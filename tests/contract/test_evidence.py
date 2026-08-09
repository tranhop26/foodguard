import hashlib
import json

import pytest

from conftest import BASE_TIME, addr


def _canonical_json(value) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def evidence_json(
    vm,
    actor,
    action,
    *,
    order_id="fg-1",
    item_id=None,
    subject=None,
    nonce=None,
    submitted_at="2026-08-08T00:00:00.000Z",
    observed_at="2026-08-07T23:59:00.000Z",
    expires_at="2026-08-08T01:00:00.000Z",
    chain_id=None,
    contract_address=None,
):
    envelope = {
        "action": action,
        "actor_wallet": addr(actor),
        "chain_id": str(vm._chain_id) if chain_id is None else chain_id,
        "contract_address": (
            addr(vm._contract_address)
            if contract_address is None
            else contract_address
        ),
        "expires_at": expires_at,
        "issuer_id": "foodguard-test",
        "nonce": nonce or action.lower() + "-1",
        "observed_at": observed_at,
        "order_id": order_id,
        "schema_version": "foodguard-evidence/1",
        "source_url": "https://evidence.foodguard.app/" + action.lower() + ".json",
        "subject": subject or (
            f"order:{order_id}/item:{item_id}" if item_id else f"order:{order_id}"
        ),
        "submitted_at": submitted_at,
    }
    if item_id is not None:
        envelope["item_id"] = item_id
    if action == "PACKED":
        envelope["item_observations"] = [
            {
                "condition_statuses": [
                    {"condition_index": 0, "status": "MET"}
                ],
                "item_id": "item|1",
                "item_status": "AS_ORDERED",
                "quantity_status": "EXACT",
                "substitution_index": -1,
            },
            {
                "condition_statuses": [],
                "item_id": "item-2",
                "item_status": "AS_ORDERED",
                "quantity_status": "EXACT",
                "substitution_index": -1,
            },
        ]
    elif action == "PICKED_UP":
        envelope["pickup_observation"] = "PICKUP_CONFIRMED"
    elif action == "DELIVERED":
        envelope["delivery_observation"] = "HANDOFF_CONFIRMED"
    elif action == "CUSTOMER_CLAIM":
        envelope["claim_category"] = "ABSENT_AT_RECEIPT"
        envelope["criterion_index"] = 0
        envelope["criterion_kind"] = "ITEM"
    envelope["sha256"] = "0x" + hashlib.sha256(
        _canonical_json(envelope).encode("utf-8")
    ).hexdigest()
    return _canonical_json(envelope)


@pytest.fixture
def accepted_order(created_order, vm, restaurant, courier):
    vm.sender = restaurant
    created_order.accept_restaurant("fg-1")
    vm.sender = courier
    created_order.accept_courier("fg-1")
    return created_order


@pytest.fixture
def review_order(accepted_order, vm, restaurant, courier):
    vm.sender = restaurant
    accepted_order.submit_packed_evidence(
        "fg-1", evidence_json(vm, restaurant, "PACKED")
    )
    vm.sender = courier
    accepted_order.submit_pickup_evidence(
        "fg-1", evidence_json(vm, courier, "PICKED_UP")
    )
    accepted_order.submit_delivery_evidence(
        "fg-1", evidence_json(vm, courier, "DELIVERED")
    )
    return accepted_order


def test_packed_pickup_delivery_transitions_append_evidence_in_order(
    accepted_order,
    vm,
    restaurant,
    courier,
):
    vm.sender = restaurant
    accepted_order.submit_packed_evidence(
        "fg-1", evidence_json(vm, restaurant, "PACKED", nonce="pack-1")
    )
    assert accepted_order.get_order("fg-1").state == "READY_FOR_PICKUP"

    vm.sender = courier
    accepted_order.submit_pickup_evidence(
        "fg-1", evidence_json(vm, courier, "PICKED_UP", nonce="pickup-1")
    )
    assert accepted_order.get_order("fg-1").state == "IN_TRANSIT"
    accepted_order.submit_delivery_evidence(
        "fg-1", evidence_json(vm, courier, "DELIVERED", nonce="delivery-1")
    )

    assert accepted_order.get_order("fg-1").state == "REVIEW_WINDOW"
    assert accepted_order.get_evidence_count("fg-1") == 3
    assert accepted_order.get_evidence("fg-1", 0).nonce == "pack-1"
    assert accepted_order.get_evidence("fg-1", 1).nonce == "pickup-1"
    assert accepted_order.get_evidence("fg-1", 2).nonce == "delivery-1"


def test_rejects_packed_evidence_from_an_invalid_transition(
    created_order,
    vm,
    restaurant,
):
    vm.sender = restaurant

    with vm.expect_revert("invalid evidence transition"):
        created_order.submit_packed_evidence(
            "fg-1", evidence_json(vm, restaurant, "PACKED")
        )

    assert created_order.get_order("fg-1").state == "FUNDED"
    assert created_order.get_evidence_count("fg-1") == 0


def test_rejects_packed_evidence_from_the_wrong_wallet(
    accepted_order,
    vm,
    customer,
    restaurant,
):
    vm.sender = customer

    with vm.expect_revert("restaurant wallet required"):
        accepted_order.submit_packed_evidence(
            "fg-1", evidence_json(vm, restaurant, "PACKED")
        )

    assert accepted_order.get_order("fg-1").state == "ACCEPTED"
    assert accepted_order.get_evidence_count("fg-1") == 0


def test_rejects_pickup_evidence_from_the_wrong_wallet(
    accepted_order,
    vm,
    customer,
    restaurant,
    courier,
):
    vm.sender = restaurant
    accepted_order.submit_packed_evidence(
        "fg-1", evidence_json(vm, restaurant, "PACKED")
    )
    vm.sender = customer

    with vm.expect_revert("courier wallet required"):
        accepted_order.submit_pickup_evidence(
            "fg-1", evidence_json(vm, courier, "PICKED_UP")
        )

    assert accepted_order.get_order("fg-1").state == "READY_FOR_PICKUP"
    assert accepted_order.get_evidence_count("fg-1") == 1


def test_rejects_delivery_evidence_from_the_wrong_wallet(
    accepted_order,
    vm,
    customer,
    restaurant,
    courier,
):
    vm.sender = restaurant
    accepted_order.submit_packed_evidence(
        "fg-1", evidence_json(vm, restaurant, "PACKED")
    )
    vm.sender = courier
    accepted_order.submit_pickup_evidence(
        "fg-1", evidence_json(vm, courier, "PICKED_UP")
    )
    vm.sender = customer

    with vm.expect_revert("courier wallet required"):
        accepted_order.submit_delivery_evidence(
            "fg-1", evidence_json(vm, courier, "DELIVERED")
        )

    assert accepted_order.get_order("fg-1").state == "IN_TRANSIT"
    assert accepted_order.get_evidence_count("fg-1") == 2


def test_rejects_claim_evidence_from_the_wrong_wallet(
    review_order,
    vm,
    restaurant,
    customer,
):
    vm.sender = restaurant

    with vm.expect_revert("customer wallet required"):
        review_order.submit_claim_evidence(
            "fg-1",
            evidence_json(
                vm,
                customer,
                "CUSTOMER_CLAIM",
                item_id="item|1",
            ),
        )

    assert review_order.get_evidence_count("fg-1") == 3


def test_rejects_an_envelope_bound_to_another_actor(
    accepted_order,
    vm,
    restaurant,
    outsider,
):
    vm.sender = restaurant

    with vm.expect_revert("evidence actor mismatch"):
        accepted_order.submit_packed_evidence(
            "fg-1", evidence_json(vm, outsider, "PACKED")
        )

    assert accepted_order.get_evidence_count("fg-1") == 0


def test_rejects_an_envelope_for_the_wrong_action(
    accepted_order,
    vm,
    restaurant,
):
    vm.sender = restaurant

    with vm.expect_revert("evidence action mismatch"):
        accepted_order.submit_packed_evidence(
            "fg-1", evidence_json(vm, restaurant, "PICKED_UP")
        )

    assert accepted_order.get_order("fg-1").state == "ACCEPTED"
    assert accepted_order.get_evidence_count("fg-1") == 0


def test_rejects_an_envelope_for_the_wrong_subject(
    accepted_order,
    vm,
    restaurant,
):
    vm.sender = restaurant

    with vm.expect_revert("evidence subject mismatch"):
        accepted_order.submit_packed_evidence(
            "fg-1",
            evidence_json(vm, restaurant, "PACKED", subject="order:somewhere-else"),
        )

    assert accepted_order.get_evidence_count("fg-1") == 0


def test_rejects_an_envelope_bound_to_another_order(
    accepted_order,
    vm,
    restaurant,
):
    vm.sender = restaurant

    with vm.expect_revert("evidence order mismatch"):
        accepted_order.submit_packed_evidence(
            "fg-1", evidence_json(vm, restaurant, "PACKED", order_id="fg-2")
        )

    assert accepted_order.get_evidence_count("fg-1") == 0


@pytest.mark.parametrize("binding", ["chain", "contract"])
def test_rejects_an_envelope_outside_the_transaction_domain(
    binding,
    accepted_order,
    vm,
    restaurant,
):
    vm.sender = restaurant
    overrides = (
        {"chain_id": str(vm._chain_id + 1)}
        if binding == "chain"
        else {"contract_address": "0x" + "ff" * 20}
    )

    with vm.expect_revert("evidence transaction binding mismatch"):
        accepted_order.submit_packed_evidence(
            "fg-1", evidence_json(vm, restaurant, "PACKED", **overrides)
        )

    assert accepted_order.get_evidence_count("fg-1") == 0


@pytest.mark.parametrize(
    ("freshness", "submitted_at", "expires_at", "expected_error"),
    [
        (
            "stale",
            "2026-08-07T23:59:58.000Z",
            "2026-08-07T23:59:59.000Z",
            "stale evidence",
        ),
        (
            "future",
            "2026-08-08T00:00:01.000Z",
            "2026-08-08T01:00:00.000Z",
            "future evidence",
        ),
    ],
)
def test_rejects_stale_and_future_evidence_at_the_transaction_time(
    freshness,
    submitted_at,
    expires_at,
    expected_error,
    accepted_order,
    vm,
    restaurant,
):
    vm.sender = restaurant

    with vm.expect_revert(expected_error):
        accepted_order.submit_packed_evidence(
            "fg-1",
            evidence_json(
                vm,
                restaurant,
                "PACKED",
                submitted_at=submitted_at,
                observed_at="2026-08-07T23:59:00.000Z",
                expires_at=expires_at,
            ),
        )

    assert accepted_order.get_evidence_count("fg-1") == 0


def test_accepts_evidence_submitted_in_the_past_while_it_remains_unexpired(
    accepted_order,
    vm,
    restaurant,
):
    vm.sender = restaurant

    accepted_order.submit_packed_evidence(
        "fg-1",
        evidence_json(
            vm,
            restaurant,
            "PACKED",
            observed_at="2026-08-07T23:58:00.000Z",
            submitted_at="2026-08-07T23:59:00.000Z",
            expires_at="2026-08-08T01:00:00.000Z",
        ),
    )

    assert accepted_order.get_order("fg-1").state == "READY_FOR_PICKUP"
    assert accepted_order.get_evidence_count("fg-1") == 1


def test_rejects_a_digest_that_does_not_bind_the_canonical_envelope(
    accepted_order,
    vm,
    restaurant,
):
    vm.sender = restaurant
    envelope = json.loads(evidence_json(vm, restaurant, "PACKED"))
    envelope["source_url"] = "https://attacker.foodguard.app/replaced.json"

    with vm.expect_revert("evidence digest mismatch"):
        accepted_order.submit_packed_evidence("fg-1", _canonical_json(envelope))

    assert accepted_order.get_evidence_count("fg-1") == 0


def test_claim_appends_without_deciding_an_outcome(
    review_order,
    vm,
    customer,
):
    vm.sender = customer
    review_order.submit_claim_evidence(
        "fg-1",
        evidence_json(
            vm,
            customer,
            "CUSTOMER_CLAIM",
            item_id="item|1",
            nonce="claim-1",
        ),
    )

    assert review_order.get_order("fg-1").state == "REVIEW_WINDOW"
    assert review_order.get_evidence_count("fg-1") == 4
    claim = review_order.get_evidence("fg-1", 3)
    assert claim.item_id == "item|1"
    assert claim.action == "CUSTOMER_CLAIM"


def test_rejects_a_claim_for_an_item_outside_the_locked_manifest(
    review_order,
    vm,
    customer,
):
    vm.sender = customer

    with vm.expect_revert("evidence item not found"):
        review_order.submit_claim_evidence(
            "fg-1",
            evidence_json(
                vm,
                customer,
                "CUSTOMER_CLAIM",
                item_id="not-in-order",
            ),
        )

    assert review_order.get_evidence_count("fg-1") == 3


def test_rejects_a_true_same_action_replay_without_replacing_history(
    review_order,
    vm,
    customer,
):
    vm.sender = customer
    envelope = evidence_json(
        vm,
        customer,
        "CUSTOMER_CLAIM",
        item_id="item|1",
        nonce="claim-replay-1",
    )
    review_order.submit_claim_evidence("fg-1", envelope)

    with vm.expect_revert("evidence replay"):
        review_order.submit_claim_evidence("fg-1", envelope)

    assert review_order.get_order("fg-1").state == "REVIEW_WINDOW"
    assert review_order.get_evidence_count("fg-1") == 4
    assert review_order.get_evidence("fg-1", 3).nonce == "claim-replay-1"


def test_rejects_a_second_base_claim_for_the_same_item(
    review_order,
    vm,
    customer,
):
    vm.sender = customer
    review_order.submit_claim_evidence(
        "fg-1",
        evidence_json(
            vm,
            customer,
            "CUSTOMER_CLAIM",
            item_id="item|1",
            nonce="claim-1",
        ),
    )

    with vm.expect_revert("claim already submitted"):
        review_order.submit_claim_evidence(
            "fg-1",
            evidence_json(
                vm,
                customer,
                "CUSTOMER_CLAIM",
                item_id="item|1",
                nonce="claim-2",
            ),
        )

    assert review_order.get_evidence_count("fg-1") == 4


def test_claim_submission_is_strictly_before_the_review_deadline(
    review_order,
    vm,
    customer,
):
    vm.warp("2026-08-08T00:40:00Z")
    vm.sender = customer

    with vm.expect_revert("review deadline passed"):
        review_order.submit_claim_evidence(
            "fg-1",
            evidence_json(
                vm,
                customer,
                "CUSTOMER_CLAIM",
                item_id="item|1",
                submitted_at="2026-08-08T00:40:00.000Z",
                observed_at=BASE_TIME.replace("Z", ".000Z"),
                expires_at="2026-08-08T01:00:00.000Z",
            ),
        )

    assert review_order.get_evidence_count("fg-1") == 3


@pytest.mark.parametrize(
    "source_url",
    [
        "http://public.example.org/evidence.json",
        "https://localhost/evidence.json",
        "https://127.0.0.1/evidence.json",
        "https://10.0.0.1/evidence.json",
        "https://user:password@public.example.org/evidence.json",
        "https://public.example.org/evidence.json#ambiguous-fragment",
        "https://public.example.org\\@127.0.0.1/evidence.json",
    ],
)
def test_contract_rejects_nonpublic_source_before_history_or_state_changes(
    source_url,
    accepted_order,
    vm,
    restaurant,
):
    envelope = json.loads(
        evidence_json(vm, restaurant, "PACKED", nonce="source-policy")
    )
    envelope.pop("sha256")
    envelope["source_url"] = source_url
    envelope["sha256"] = "0x" + hashlib.sha256(
        _canonical_json(envelope).encode("utf-8")
    ).hexdigest()
    vm.sender = restaurant

    with vm.expect_revert("public HTTPS evidence source required"):
        accepted_order.submit_packed_evidence("fg-1", _canonical_json(envelope))

    assert accepted_order.get_order("fg-1").state == "ACCEPTED"
    assert accepted_order.get_evidence_count("fg-1") == 0
