import hashlib
import json

from conftest import DEADLINES, addr
from test_appeal import UNRESOLVED_RESULT
from test_evidence import evidence_json
from test_resolution import _mock_resolution, _mock_sources


def _canonical_json(value) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def _committed_evidence(vm, actor, action, nonce, *, item_id=None, **facts):
    envelope = json.loads(
        evidence_json(
            vm,
            actor,
            action,
            order_id="fg-max",
            item_id=item_id,
            nonce=nonce,
            expires_at="2026-08-08T02:00:00.000Z",
        )
    )
    envelope.pop("sha256")
    envelope["source_url"] = f"https://evidence.foodguard.app/max/{nonce}.json"
    envelope.update(facts)
    envelope["sha256"] = "0x" + hashlib.sha256(
        _canonical_json(envelope).encode("utf-8")
    ).hexdigest()
    return _canonical_json(envelope)


def _packed_observations(items):
    return [
        {
            "condition_statuses": [],
            "item_id": item["item_id"],
            "item_status": "AS_ORDERED",
            "quantity_status": "EXACT",
            "substitution_index": -1,
        }
        for item in items
    ]


def _result(item_count, outcome):
    return {
        "delivery_outcome": "DELIVERED" if outcome == "MATCHED" else "UNRESOLVED",
        "items": [
            {
                "facts": ["Bounded maximum-workflow result."],
                "item_index": item_index,
                "outcome": outcome,
            }
            for item_index in range(item_count)
        ],
    }


def _sources(contract):
    sources = {}
    for evidence_index in range(int(contract.get_evidence_count("fg-max"))):
        evidence = contract.get_evidence("fg-max", evidence_index)
        document = json.loads(evidence.envelope_json)
        document.pop("sha256")
        sources[evidence.source_url] = _canonical_json(document)
    return sources


def test_maximum_100_item_109_history_workflow_resolves_from_103_active_records(
    food_guard,
    vm,
    customer,
    restaurant,
    courier,
    outsider,
):
    items = [
        {
            "conditions": [],
            "item_id": f"item-{item_index:03d}",
            "name": f"Catalog item {item_index:03d}",
            "permitted_substitutions": [],
            "price_wei": "1",
            "quantity": 1,
        }
        for item_index in range(100)
    ]
    manifest = _canonical_json({"items": items})
    vm.sender = customer
    vm.value = 130
    food_guard.create_order(
        "fg-max",
        addr(restaurant),
        addr(courier),
        manifest,
        30,
        DEADLINES,
    )
    vm.value = 0
    vm.sender = restaurant
    food_guard.accept_restaurant("fg-max")
    vm.sender = courier
    food_guard.accept_courier("fg-max")
    vm.sender = restaurant
    food_guard.submit_packed_evidence(
        "fg-max",
        _committed_evidence(
            vm,
            restaurant,
            "PACKED",
            "packed-max",
            item_observations=_packed_observations(items),
        ),
    )
    vm.sender = courier
    food_guard.submit_pickup_evidence(
        "fg-max",
        _committed_evidence(vm, courier, "PICKED_UP", "pickup-max"),
    )
    food_guard.submit_delivery_evidence(
        "fg-max",
        _committed_evidence(
            vm,
            courier,
            "DELIVERED",
            "delivered-max",
            delivery_observation="HANDOFF_CONFIRMED",
        ),
    )
    vm.sender = customer
    for item_index, item in enumerate(items):
        food_guard.submit_claim_evidence(
            "fg-max",
            _committed_evidence(
                vm,
                customer,
                "CUSTOMER_CLAIM",
                f"claim-{item_index:03d}",
                item_id=item["item_id"],
                claim_category="ABSENT_AT_RECEIPT",
                criterion_index=0,
                criterion_kind="ITEM",
            ),
        )
    assert food_guard.get_evidence_count("fg-max") == 103

    vm.warp("2026-08-08T00:40:00Z")
    _mock_sources(vm, _sources(food_guard))
    _mock_resolution(vm, _result(100, "UNRESOLVED"))
    vm.sender = outsider
    food_guard.request_resolution("fg-max")
    vm.clear_mocks()
    assert food_guard.get_order("fg-max").state == "EVIDENCE_CURE"

    corrections = [
        (
            restaurant,
            0,
            "PACKED",
            "cure-restaurant-max",
            None,
            {
                "item_observations": _packed_observations(items)
            },
        ),
        (
            courier,
            2,
            "DELIVERED",
            "cure-courier-max",
            None,
            {"delivery_observation": "HANDOFF_CONFIRMED"},
        ),
        (
            customer,
            3,
            "CUSTOMER_CLAIM",
            "cure-customer-max",
            items[0]["item_id"],
            {
                "claim_category": "ABSENT_AT_RECEIPT",
                "criterion_index": 0,
                "criterion_kind": "ITEM",
            },
        ),
    ]
    for actor, supersedes, effective_action, nonce, item_id, facts in corrections:
        vm.sender = actor
        food_guard.submit_cure_evidence(
            "fg-max",
            _committed_evidence(
                vm,
                actor,
                "CURE",
                nonce,
                supersedes_evidence_indices=[supersedes],
                statements=[{
                    "effective_action": effective_action,
                    **({"item_id": item_id} if item_id else {}),
                    **facts,
                }],
            ),
        )
    assert food_guard.get_evidence_count("fg-max") == 106

    vm.warp("2026-08-08T00:45:00Z")
    _mock_sources(vm, _sources(food_guard))
    _mock_resolution(vm, _result(100, "MATCHED"))
    vm.sender = outsider
    second = json.loads(food_guard.request_resolution("fg-max"))
    vm.clear_mocks()
    assert food_guard.get_order("fg-max").state == "RESOLVED"

    for appeal_index, (actor, _supersedes, effective_action, _nonce, item_id, facts) in enumerate(corrections):
        vm.sender = actor
        food_guard.appeal(
            "fg-max",
            _committed_evidence(
                vm,
                actor,
                "APPEAL",
                f"appeal-{appeal_index}-max",
                supersedes_evidence_indices=[103 + appeal_index],
                statements=[{
                    "effective_action": effective_action,
                    **({"item_id": item_id} if item_id else {}),
                    **facts,
                }],
            ),
        )
    assert food_guard.get_evidence_count("fg-max") == 109

    vm.warp("2026-08-08T00:50:00Z")
    _mock_sources(vm, _sources(food_guard))
    _mock_resolution(vm, _result(100, "MATCHED"))
    vm.sender = outsider
    final = json.loads(food_guard.request_resolution("fg-max"))

    assert food_guard.get_order("fg-max").state == "RESOLVED"
    assert len(second["evidence_indices"]) == 103
    assert len(final["evidence_indices"]) == 103
    assert len(final["evidence_hashes"]) == 103
    assert final["evidence_indices"] == [1] + list(range(4, 103)) + [106, 107, 108]
