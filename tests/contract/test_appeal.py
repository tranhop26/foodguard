import hashlib
import json

import pytest

from conftest import addr
from test_evidence import evidence_json
from test_resolution import (
    MATCH_ALL_RESULT,
    MIXED_RESULT,
    _advance_to_resolution,
    _committed_sources,
    _mock_resolution,
    _mock_sources,
)


UNRESOLVED_RESULT = {
    "items": [
        {
            "item_index": 0,
            "outcome": "UNRESOLVED",
            "facts": ["The evidence remains insufficient."],
        },
        {
            "item_index": 1,
            "outcome": "UNRESOLVED",
            "facts": ["The evidence remains insufficient."],
        },
    ],
    "delivery_outcome": "UNRESOLVED",
}


def _canonical_json(value) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def _allocation(
    *,
    nonce="mutual-1",
    item_2_customer="20",
    item_2_restaurant="0",
) -> str:
    return _canonical_json(
        {
            "delivery_allocation": {
                "courier_wei": "30",
                "customer_wei": "0",
            },
            "item_allocations": [
                {
                    "customer_wei": "0",
                    "item_id": "item|1",
                    "restaurant_wei": "80",
                },
                {
                    "customer_wei": item_2_customer,
                    "item_id": "item-2",
                    "restaurant_wei": item_2_restaurant,
                },
            ],
            "proposal_nonce": nonce,
        }
    )


def _resolve(contract, vm, caller, result):
    _mock_sources(vm, _committed_sources(contract))
    _mock_resolution(vm, result)
    vm.sender = caller
    returned = contract.request_resolution("fg-1")
    vm.clear_mocks()
    return returned


@pytest.fixture
def secondary_order(created_order, vm, customer, restaurant, courier):
    return _advance_to_resolution(
        created_order,
        vm,
        customer,
        restaurant,
        courier,
    )


@pytest.fixture
def unresolved_order(secondary_order, vm, outsider):
    _resolve(secondary_order, vm, outsider, UNRESOLVED_RESULT)
    return secondary_order


@pytest.fixture
def resolved_order(secondary_order, vm, outsider):
    _resolve(secondary_order, vm, outsider, MIXED_RESULT)
    return secondary_order


@pytest.fixture
def escalated_order(unresolved_order, vm, restaurant, outsider):
    vm.sender = restaurant
    unresolved_order.submit_cure_evidence(
        "fg-1",
        evidence_json(vm, restaurant, "CURE", nonce="cure-escalation-1"),
    )
    _resolve(unresolved_order, vm, outsider, UNRESOLVED_RESULT)
    return unresolved_order


@pytest.fixture
def mutual_order(escalated_order, vm):
    vm.warp("2026-08-08T00:50:00Z")
    return escalated_order


def test_first_unresolved_opens_one_cure_round_without_moving_reserves(
    unresolved_order,
):
    accounting = unresolved_order.get_accounting()

    assert unresolved_order.get_order("fg-1").state == "EVIDENCE_CURE"
    assert unresolved_order.get_round("fg-1") == 1
    assert accounting.reserved_items == 100
    assert accounting.reserved_delivery == 30


def test_cure_uses_append_only_bound_evidence_and_permissionless_retry_can_resolve(
    unresolved_order,
    vm,
    restaurant,
    outsider,
):
    first_resolution = unresolved_order.get_resolution("fg-1")
    before_count = int(unresolved_order.get_evidence_count("fg-1"))
    vm.sender = restaurant
    unresolved_order.submit_cure_evidence(
        "fg-1",
        evidence_json(vm, restaurant, "CURE", nonce="cure-1"),
    )

    assert int(unresolved_order.get_evidence_count("fg-1")) == before_count + 1
    assert unresolved_order.get_evidence("fg-1", before_count).nonce == "cure-1"
    assert unresolved_order.get_resolution("fg-1") == first_resolution

    second_resolution = _resolve(unresolved_order, vm, outsider, MATCH_ALL_RESULT)

    assert unresolved_order.get_order("fg-1").state == "RESOLVED"
    assert unresolved_order.get_round("fg-1") == 2
    assert json.loads(second_resolution)["evidence_hashes"][-1] == (
        unresolved_order.get_evidence("fg-1", before_count).sha256
    )


def test_cure_rejects_outsiders_repeats_and_invalid_digests(
    unresolved_order,
    vm,
    restaurant,
    outsider,
):
    before_count = unresolved_order.get_evidence_count("fg-1")
    vm.sender = outsider
    with vm.expect_revert("affected actor required"):
        unresolved_order.submit_cure_evidence(
            "fg-1",
            evidence_json(vm, outsider, "CURE", nonce="outsider-cure"),
        )

    vm.sender = restaurant
    envelope = evidence_json(vm, restaurant, "CURE", nonce="restaurant-cure")
    unresolved_order.submit_cure_evidence("fg-1", envelope)
    with vm.expect_revert("cure already submitted"):
        unresolved_order.submit_cure_evidence(
            "fg-1",
            evidence_json(vm, restaurant, "CURE", nonce="restaurant-cure-2"),
        )

    tampered = json.loads(evidence_json(vm, restaurant, "CURE", nonce="bad-digest"))
    tampered["source_url"] = "https://attacker.example/rebound.json"
    with vm.expect_revert("cure already submitted"):
        unresolved_order.submit_cure_evidence(
            "fg-1",
            _canonical_json(tampered),
        )
    assert int(unresolved_order.get_evidence_count("fg-1")) == int(before_count) + 1


def test_cure_digest_binding_is_checked_before_storage(
    unresolved_order,
    vm,
    courier,
):
    before_count = unresolved_order.get_evidence_count("fg-1")
    tampered = json.loads(evidence_json(vm, courier, "CURE", nonce="bad-digest"))
    tampered["source_url"] = "https://attacker.example/rebound.json"
    vm.sender = courier

    with vm.expect_revert("evidence digest mismatch"):
        unresolved_order.submit_cure_evidence("fg-1", _canonical_json(tampered))

    assert unresolved_order.get_evidence_count("fg-1") == before_count


def test_affected_actor_can_appeal_once_and_prior_decision_is_preserved(
    resolved_order,
    vm,
    customer,
):
    first_resolution = resolved_order.get_resolution("fg-1")
    before_count = int(resolved_order.get_evidence_count("fg-1"))
    vm.sender = customer
    resolved_order.appeal(
        "fg-1",
        evidence_json(
            vm,
            customer,
            "APPEAL",
            item_id="item-2",
            nonce="appeal-1",
        ),
    )

    assert resolved_order.get_order("fg-1").state == "APPEALED"
    assert resolved_order.get_resolution("fg-1") == first_resolution
    assert resolved_order.get_evidence("fg-1", before_count).action == "APPEAL"
    with vm.expect_revert("appeal already used"):
        resolved_order.appeal(
            "fg-1",
            evidence_json(
                vm,
                customer,
                "APPEAL",
                item_id="item-2",
                nonce="appeal-2",
            ),
        )


def test_appeal_rejects_outsider_and_resolution_waits_for_appeal_deadline(
    resolved_order,
    vm,
    customer,
    outsider,
):
    vm.sender = outsider
    with vm.expect_revert("affected actor required"):
        resolved_order.appeal(
            "fg-1",
            evidence_json(vm, outsider, "APPEAL", nonce="outsider-appeal"),
        )

    vm.sender = customer
    resolved_order.appeal(
        "fg-1",
        evidence_json(vm, customer, "APPEAL", nonce="customer-appeal"),
    )
    _mock_sources(vm, _committed_sources(resolved_order))
    _mock_resolution(vm, MATCH_ALL_RESULT)
    vm.sender = outsider
    with vm.expect_revert("appeal deadline not reached"):
        resolved_order.request_resolution("fg-1")
    vm.clear_mocks()

    vm.warp("2026-08-08T00:50:00Z")
    _resolve(resolved_order, vm, outsider, MATCH_ALL_RESULT)
    assert resolved_order.get_order("fg-1").state == "RESOLVED"
    assert resolved_order.get_round("fg-1") == 2


def test_second_unresolved_escalates_without_transfer(
    escalated_order,
    emitted_messages,
):
    accounting = escalated_order.get_accounting()

    assert escalated_order.get_order("fg-1").state == "ESCALATED"
    assert escalated_order.get_round("fg-1") == 2
    assert accounting.reserved_items == 100
    assert accounting.reserved_delivery == 30
    assert accounting.restaurant_payouts_emitted == 0
    assert accounting.courier_payouts_emitted == 0
    assert accounting.customer_refunds_emitted == 0
    assert emitted_messages == []


def test_mutual_proposal_digest_uses_trusted_order_chain_and_contract_bindings(
    mutual_order,
    vm,
    customer,
):
    allocation_json = _allocation()
    vm.sender = customer

    digest = mutual_order.propose_mutual_settlement("fg-1", allocation_json)

    allocation = json.loads(allocation_json)
    expected_preimage = {
        **allocation,
        "chain_id": str(vm._chain_id),
        "contract_address": addr(vm._contract_address).lower(),
        "order_id": "fg-1",
    }
    expected_digest = "0x" + hashlib.sha256(
        _canonical_json(expected_preimage).encode("utf-8")
    ).hexdigest()
    proposal = mutual_order.get_settlement_proposal("fg-1")
    assert digest == expected_digest
    assert proposal.digest == expected_digest
    assert proposal.proposal_json == _canonical_json(expected_preimage)


@pytest.mark.parametrize(
    ("mutate", "error"),
    [
        (
            lambda value: value["item_allocations"][1].update(
                {"customer_wei": "21"}
            ),
            "allocation must conserve order value",
        ),
        (
            lambda value: value["delivery_allocation"].pop("courier_wei"),
            "settlement proposal recipients required",
        ),
        (
            lambda value: value.update({"order_id": "caller-selected-order"}),
            "invalid settlement proposal",
        ),
    ],
    ids=["excess-allocation", "missing-recipient", "caller-identity-binding"],
)
def test_mutual_proposal_rejects_invalid_or_caller_bound_allocations(
    mutate,
    error,
    mutual_order,
    vm,
    customer,
):
    proposal = json.loads(_allocation())
    mutate(proposal)
    vm.sender = customer

    with vm.expect_revert(error):
        mutual_order.propose_mutual_settlement(
            "fg-1",
            _canonical_json(proposal),
        )


def test_mutual_proposal_rejects_outsider_changed_allocations_and_reused_nonce(
    mutual_order,
    vm,
    customer,
    outsider,
):
    vm.sender = outsider
    with vm.expect_revert("affected actor required"):
        mutual_order.propose_mutual_settlement("fg-1", _allocation())

    vm.sender = customer
    digest = mutual_order.propose_mutual_settlement("fg-1", _allocation())
    with vm.expect_revert("proposal nonce already used"):
        mutual_order.propose_mutual_settlement("fg-1", _allocation())
    with vm.expect_revert("settlement proposal already exists"):
        mutual_order.propose_mutual_settlement(
            "fg-1",
            _allocation(
                nonce="mutual-2",
                item_2_customer="19",
                item_2_restaurant="1",
            ),
        )

    proposal = mutual_order.get_settlement_proposal("fg-1")
    assert proposal.digest == digest


def test_mutual_settlement_requires_distinct_three_party_signatures_and_emits_once(
    mutual_order,
    emitted_messages,
    vm,
    customer,
    restaurant,
    courier,
    outsider,
):
    vm.sender = customer
    digest = mutual_order.propose_mutual_settlement("fg-1", _allocation())
    mutual_order.sign_mutual_settlement("fg-1", digest)
    with vm.expect_revert("settlement signature already recorded"):
        mutual_order.sign_mutual_settlement("fg-1", digest)

    vm.sender = outsider
    with vm.expect_revert("affected actor required"):
        mutual_order.sign_mutual_settlement("fg-1", digest)
    vm.sender = restaurant
    with vm.expect_revert("settlement proposal digest mismatch"):
        mutual_order.sign_mutual_settlement("fg-1", "0x" + "00" * 32)
    mutual_order.sign_mutual_settlement("fg-1", digest)

    assert mutual_order.get_order("fg-1").state == "ESCALATED"
    assert emitted_messages == []

    vm.sender = courier
    mutual_order.sign_mutual_settlement("fg-1", digest)

    accounting = mutual_order.get_accounting()
    transfers = {
        addr(message["address"]).lower(): message["value"]
        for message in emitted_messages
    }
    assert mutual_order.get_order("fg-1").state == "SETTLED"
    assert accounting.reserved_items == 0
    assert accounting.reserved_delivery == 0
    assert accounting.restaurant_payouts_emitted == 80
    assert accounting.courier_payouts_emitted == 30
    assert accounting.customer_refunds_emitted == 20
    assert transfers == {
        addr(customer).lower(): 20,
        addr(restaurant).lower(): 80,
        addr(courier).lower(): 30,
    }
    assert all(message["on"] == "finalized" for message in emitted_messages)


def test_mutual_proposal_waits_for_appeal_deadline(
    escalated_order,
    emitted_messages,
    vm,
    customer,
):
    vm.sender = customer

    with vm.expect_revert("appeal deadline not reached"):
        escalated_order.propose_mutual_settlement("fg-1", _allocation())

    assert escalated_order.get_order("fg-1").state == "ESCALATED"
    assert emitted_messages == []
