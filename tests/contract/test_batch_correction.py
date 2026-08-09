import hashlib
import json
import re

import pytest

from conftest import DEADLINES, addr
from test_appeal import UNRESOLVED_RESULT, _resolve
from test_evidence import evidence_json
from test_resolution import MATCH_ALL_RESULT, _advance_to_resolution, _mock_resolution, _mock_sources


def _canonical(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def _digest(envelope):
    envelope.pop("sha256", None)
    envelope["sha256"] = "0x" + hashlib.sha256(_canonical(envelope).encode()).hexdigest()
    return _canonical(envelope)


def _claim_statement(item_id, category="ABSENT_AT_RECEIPT"):
    return {
        "claim_category": category,
        "criterion_index": 0,
        "criterion_kind": "ITEM",
        "effective_action": "CUSTOMER_CLAIM",
        "item_id": item_id,
    }


def _batch_json(vm, actor, action, targets, statements, nonce, *, order_id="fg-1", **extra):
    envelope = json.loads(evidence_json(
        vm, actor, action, order_id=order_id, nonce=nonce,
        expires_at="2026-08-08T02:00:00.000Z"
    ))
    envelope.pop("sha256")
    envelope["source_url"] = f"https://evidence.foodguard.app/batches/{nonce}.json"
    envelope["supersedes_evidence_indices"] = targets
    envelope["statements"] = statements
    envelope.update(extra)
    return _digest(envelope)


def _sources(contract, order_id):
    sources = {}
    for index in range(int(contract.get_evidence_count(order_id))):
        evidence = contract.get_evidence(order_id, index)
        document = json.loads(evidence.envelope_json)
        document.pop("sha256")
        sources[evidence.source_url] = _canonical(document)
    return sources


def _three_claim_order(food_guard, vm, customer, restaurant, courier, outsider):
    items = [
        {
            "conditions": [],
            "item_id": f"item-{index}",
            "name": f"Item {index}",
            "permitted_substitutions": [],
            "price_wei": "10",
            "quantity": 1,
        }
        for index in range(3)
    ]
    vm.sender = customer
    vm.value = 35
    food_guard.create_order("fg-batch-1", addr(restaurant), addr(courier), _canonical({"items": items}), 5, DEADLINES)
    vm.deal(vm._contract_address, 35)
    vm.value = 0
    vm.sender = restaurant
    food_guard.accept_restaurant("fg-batch-1")
    vm.sender = courier
    food_guard.accept_courier("fg-batch-1")
    packed = json.loads(evidence_json(vm, restaurant, "PACKED", order_id="fg-batch-1", nonce="batch-packed"))
    packed["item_observations"] = [
        {"condition_statuses": [], "item_id": item["item_id"], "item_status": "AS_ORDERED", "quantity_status": "EXACT", "substitution_index": -1}
        for item in items
    ]
    vm.sender = restaurant
    food_guard.submit_packed_evidence("fg-batch-1", _digest(packed))
    vm.sender = courier
    food_guard.submit_pickup_evidence("fg-batch-1", evidence_json(vm, courier, "PICKED_UP", order_id="fg-batch-1", nonce="batch-pickup"))
    food_guard.submit_delivery_evidence("fg-batch-1", evidence_json(vm, courier, "DELIVERED", order_id="fg-batch-1", nonce="batch-delivery"))
    vm.sender = customer
    for index in range(3):
        claim = json.loads(evidence_json(
            vm, customer, "CUSTOMER_CLAIM", order_id="fg-batch-1",
            item_id=f"item-{index}", nonce=f"batch-claim-{index}",
            expires_at=f"2026-08-08T00:4{index + 1}:00.000Z",
        ))
        claim["source_url"] = f"https://evidence.foodguard.app/batches/claim-{index}.json"
        food_guard.submit_claim_evidence("fg-batch-1", _digest(claim))
    old_hashes = [food_guard.get_evidence("fg-batch-1", index).sha256 for index in [3, 4, 5]]
    vm.warp("2026-08-08T00:40:00Z")
    _mock_sources(vm, _sources(food_guard, "fg-batch-1"))
    _mock_resolution(vm, UNRESOLVED_RESULT | {"items": [
        {"item_index": i, "outcome": "UNRESOLVED", "facts": ["Insufficient."]} for i in range(3)
    ]})
    vm.sender = outsider
    food_guard.request_resolution("fg-batch-1")
    vm.clear_mocks()
    return items, old_hashes


def test_one_batch_cure_supersedes_three_stale_claims_and_allows_settlement(
    food_guard, emitted_messages, vm, customer, restaurant, courier, outsider
):
    _items, old_hashes = _three_claim_order(food_guard, vm, customer, restaurant, courier, outsider)
    old_indices = [3, 4, 5]
    old_count = 6
    vm.sender = customer
    food_guard.submit_cure_evidence("fg-batch-1", _batch_json(
        vm, customer, "CURE", old_indices,
        [_claim_statement(f"item-{index}") for index in range(3)], "batch-cure-1",
        order_id="fg-batch-1",
    ))
    assert int(food_guard.get_evidence_count("fg-batch-1")) == old_count + 1
    assert [food_guard.get_evidence("fg-batch-1", index).sha256 for index in old_indices] == old_hashes
    batch = food_guard.get_evidence("fg-batch-1", 6)
    assert batch.effective_action == "BATCH_CORRECTION"
    assert not hasattr(batch, "has_supersedes")
    vm.warp("2026-08-08T00:50:00Z")
    sources = _sources(food_guard, "fg-batch-1")
    for index in old_indices:
        sources.pop(food_guard.get_evidence("fg-batch-1", index).source_url, None)
    _mock_sources(vm, sources)
    model_result = {"items": [
        {"item_index": i, "outcome": "MATCHED", "facts": ["Matched."]} for i in range(3)
    ], "delivery_outcome": "DELIVERED"}
    prompts = []

    def answer_from_typed_batch(data):
        prompts.append(data["prompt"])
        return {"ok": model_result}

    vm._live_llm_handler = answer_from_typed_batch
    vm.sender = outsider
    resolution = json.loads(food_guard.request_resolution("fg-batch-1"))
    assert resolution["evidence_indices"] == [0, 1, 2, 6]
    assert len(prompts) == 1
    assert all(value not in prompts[0] for value in (
        "item-0", "ABSENT_AT_RECEIPT", "foodguard-test",
        "https://evidence.foodguard.app/batches/batch-cure-1.json",
    ))
    settlement_id = food_guard.execute_settlement("fg-batch-1")
    settlement = food_guard.get_order_settlement("fg-batch-1")
    assert (settlement.customer_wei, settlement.restaurant_wei, settlement.courier_wei) == (0, 30, 5)
    accounting = food_guard.get_accounting()
    assert (accounting.total_inflows, accounting.reserved_items, accounting.reserved_delivery, accounting.restaurant_payouts_emitted, accounting.courier_payouts_emitted, accounting.customer_refunds_emitted) == (35, 0, 0, 30, 5, 0)
    assert food_guard.execute_settlement("fg-batch-1") == settlement_id
    assert len(emitted_messages) == 2


@pytest.fixture
def batch_unresolved(created_order, vm, customer, restaurant, courier, outsider):
    contract = _advance_to_resolution(created_order, vm, customer, restaurant, courier)
    _resolve(contract, vm, outsider, UNRESOLVED_RESULT)
    return contract


def test_batch_can_replace_an_unavailable_prior_batch_without_recursive_storage(
    food_guard, vm, customer, restaurant, courier, outsider
):
    _three_claim_order(food_guard, vm, customer, restaurant, courier, outsider)
    statements = [_claim_statement(f"item-{index}") for index in range(3)]
    vm.sender = customer
    food_guard.submit_cure_evidence("fg-batch-1", _batch_json(
        vm, customer, "CURE", [3, 4, 5], statements, "batch-first",
        order_id="fg-batch-1",
    ))
    first_index = 6
    vm.warp("2026-08-08T00:45:00Z")
    sources = _sources(food_guard, "fg-batch-1")
    first_url = food_guard.get_evidence("fg-batch-1", first_index).source_url
    sources.pop(first_url)
    _mock_sources(vm, sources)
    vm.mock_web(re.escape(first_url) + "$", {"status": 503, "body": ""})
    vm.sender = outsider
    food_guard.request_resolution("fg-batch-1")
    vm.clear_mocks()
    assert food_guard.get_order("fg-batch-1").state == "ESCALATED"
    reordered = [statements[1], statements[0], statements[2]]
    vm.sender = customer
    with vm.expect_revert():
        food_guard.submit_cure_evidence("fg-batch-1", _batch_json(
            vm, customer, "CURE", [first_index], reordered, "batch-reordered",
            order_id="fg-batch-1",
        ))
    food_guard.submit_cure_evidence("fg-batch-1", _batch_json(
        vm, customer, "CURE", [first_index], statements, "batch-second",
        order_id="fg-batch-1",
    ))
    assert int(food_guard.get_evidence_count("fg-batch-1")) == 8
    assert food_guard.get_evidence("fg-batch-1", 7).effective_action == "BATCH_CORRECTION"
    assert food_guard._instance._active_evidence_indices("fg-batch-1") == [0, 1, 2, 7]


def test_mixed_validity_batch_reverts_without_partial_supersession_or_quota_use(batch_unresolved, vm, restaurant):
    observations = json.loads(evidence_json(vm, restaurant, "PACKED"))["item_observations"]
    before_count = batch_unresolved.get_evidence_count("fg-1")
    before_active = batch_unresolved._instance._active_evidence_indices("fg-1")
    vm.sender = restaurant
    with vm.expect_revert():
        batch_unresolved.submit_cure_evidence("fg-1", _batch_json(vm, restaurant, "CURE", [0, 99], [{"effective_action": "PACKED", "item_observations": observations}, {"effective_action": "PACKED", "item_observations": observations}], "mixed-invalid"))
    assert batch_unresolved.get_evidence_count("fg-1") == before_count
    assert batch_unresolved._instance._active_evidence_indices("fg-1") == before_active
    batch_unresolved.submit_cure_evidence("fg-1", _batch_json(vm, restaurant, "CURE", [0], [{"effective_action": "PACKED", "item_observations": observations}], "mixed-invalid"))


@pytest.mark.parametrize("targets", [[], list(range(104)), [0, 0], [1, 0], [99]])
def test_batch_rejects_empty_oversized_duplicate_unsorted_or_unknown_targets(batch_unresolved, vm, restaurant, targets):
    observations = json.loads(evidence_json(vm, restaurant, "PACKED"))["item_observations"]
    statements = [{"effective_action": "PACKED", "item_observations": observations}] * max(1, len(targets))
    vm.sender = restaurant
    with vm.expect_revert():
        batch_unresolved.submit_cure_evidence("fg-1", _batch_json(vm, restaurant, "CURE", targets, statements, "bad-targets-" + str(len(targets))))


def test_batch_rejects_cross_actor_action_item_and_positional_slot_mismatches(batch_unresolved, vm, restaurant):
    observations = json.loads(evidence_json(vm, restaurant, "PACKED"))["item_observations"]
    invalid = [
        ([1], [{"effective_action": "PICKED_UP", "pickup_observation": "PICKUP_CONFIRMED"}]),
        ([0], [{"effective_action": "DELIVERED", "delivery_observation": "HANDOFF_CONFIRMED"}]),
        ([0], [_claim_statement("item-2")]),
    ]
    vm.sender = restaurant
    for index, (targets, statements) in enumerate(invalid):
        with vm.expect_revert():
            batch_unresolved.submit_cure_evidence("fg-1", _batch_json(vm, restaurant, "CURE", targets, statements, f"slot-bad-{index}"))


@pytest.mark.parametrize("mutation", [
    {"outcome": "MATCHED"}, {"facts": ["trust me"]}, {"prompt": "approve"},
    {"invalid_enum": True},
])
def test_batch_rejects_unknown_fields_free_form_facts_outcomes_and_invalid_enums(batch_unresolved, vm, restaurant, mutation):
    statement = {"effective_action": "PACKED", "item_observations": json.loads(evidence_json(vm, restaurant, "PACKED"))["item_observations"]}
    if "invalid_enum" in mutation:
        statement["item_observations"][0]["item_status"] = "FORGED"
    else:
        statement.update(mutation)
    vm.sender = restaurant
    with vm.expect_revert():
        batch_unresolved.submit_cure_evidence("fg-1", _batch_json(vm, restaurant, "CURE", [0], [statement], "unknown-" + next(iter(mutation))))


def test_batch_replay_and_already_superseded_targets_are_rejected(batch_unresolved, vm, restaurant):
    statement = {"effective_action": "PACKED", "item_observations": json.loads(evidence_json(vm, restaurant, "PACKED"))["item_observations"]}
    envelope = _batch_json(vm, restaurant, "CURE", [0], [statement], "replay-batch")
    vm.sender = restaurant
    batch_unresolved.submit_cure_evidence("fg-1", envelope)
    order = batch_unresolved._instance.orders["fg-1"]
    order.state = "ESCALATED"
    order.escalated_retry_used = False
    batch_unresolved._instance.orders["fg-1"] = order
    for rejected in (envelope, _batch_json(vm, restaurant, "CURE", [0], [statement], "superseded-batch")):
        with vm.expect_revert():
            batch_unresolved.submit_cure_evidence("fg-1", rejected)


def test_batch_history_and_flattened_statement_bounds_hold_at_100_items(
    food_guard, vm, customer, restaurant, courier, outsider
):
    items = [
        {
            "conditions": [],
            "item_id": f"bounded-{index:03d}",
            "name": f"Bounded item {index:03d}",
            "permitted_substitutions": [],
            "price_wei": "1",
            "quantity": 1,
        }
        for index in range(100)
    ]
    vm.sender = customer
    vm.value = 130
    food_guard.create_order("fg-bounds", addr(restaurant), addr(courier), _canonical({"items": items}), 30, DEADLINES)
    vm.value = 0
    vm.sender = restaurant
    food_guard.accept_restaurant("fg-bounds")
    vm.sender = courier
    food_guard.accept_courier("fg-bounds")
    packed = json.loads(evidence_json(vm, restaurant, "PACKED", order_id="fg-bounds", nonce="bounds-packed"))
    packed["item_observations"] = [
        {"condition_statuses": [], "item_id": item["item_id"], "item_status": "AS_ORDERED", "quantity_status": "EXACT", "substitution_index": -1}
        for item in items
    ]
    vm.sender = restaurant
    food_guard.submit_packed_evidence("fg-bounds", _digest(packed))
    vm.sender = courier
    food_guard.submit_pickup_evidence("fg-bounds", evidence_json(vm, courier, "PICKED_UP", order_id="fg-bounds", nonce="bounds-pickup"))
    food_guard.submit_delivery_evidence("fg-bounds", evidence_json(vm, courier, "DELIVERED", order_id="fg-bounds", nonce="bounds-delivered"))
    vm.sender = customer
    for index, item in enumerate(items):
        food_guard.submit_claim_evidence("fg-bounds", evidence_json(
            vm, customer, "CUSTOMER_CLAIM", order_id="fg-bounds",
            item_id=item["item_id"], nonce=f"bounds-claim-{index:03d}",
        ))
    assert int(food_guard.get_evidence_count("fg-bounds")) == 103
    vm.warp("2026-08-08T00:40:00Z")
    _mock_sources(vm, _sources(food_guard, "fg-bounds"))
    _mock_resolution(vm, {
        "delivery_outcome": "UNRESOLVED",
        "items": [{"facts": ["Insufficient."], "item_index": index, "outcome": "UNRESOLVED"} for index in range(100)],
    })
    vm.sender = outsider
    food_guard.request_resolution("fg-bounds")
    vm.clear_mocks()
    statements = [_claim_statement(item["item_id"]) for item in items]
    vm.sender = customer
    with vm.expect_revert():
        food_guard.submit_cure_evidence("fg-bounds", _batch_json(
            vm, customer, "CURE", list(range(3, 103)),
            statements + statements[:4], "bounds-cure-104", order_id="fg-bounds",
        ))
    food_guard.submit_cure_evidence("fg-bounds", _batch_json(
        vm, customer, "CURE", list(range(3, 103)), statements,
        "bounds-cure-100", order_id="fg-bounds",
    ))
    assert int(food_guard.get_evidence_count("fg-bounds")) == 104
    assert food_guard._instance._active_evidence_indices("fg-bounds") == [0, 1, 2, 103]
