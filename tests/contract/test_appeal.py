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


def _corrective_evidence(
    vm,
    actor,
    action,
    *,
    effective_action,
    supersedes_evidence_index,
    nonce,
    item_id=None,
):
    envelope = json.loads(
        evidence_json(
            vm,
            actor,
            action,
            nonce=nonce,
            expires_at="2026-08-08T02:00:00.000Z",
        )
    )
    envelope.pop("sha256")
    statement = {"effective_action": effective_action}
    if item_id is not None:
        statement["item_id"] = item_id
    if effective_action == "PACKED":
        statement["item_observations"] = [
            {
                "condition_statuses": [{"condition_index": 0, "status": "MET"}],
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
    elif effective_action == "PICKED_UP":
        statement["pickup_observation"] = "PICKUP_CONFIRMED"
    elif effective_action == "DELIVERED":
        statement["delivery_observation"] = "HANDOFF_CONFIRMED"
    elif effective_action == "CUSTOMER_CLAIM":
        statement["claim_category"] = "ABSENT_AT_RECEIPT"
        statement["criterion_index"] = 0
        statement["criterion_kind"] = "ITEM"
    envelope["statements"] = [statement]
    envelope["supersedes_evidence_indices"] = [supersedes_evidence_index]
    envelope["sha256"] = "0x" + hashlib.sha256(
        _canonical_json(envelope).encode("utf-8")
    ).hexdigest()
    return _canonical_json(envelope)


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
        _corrective_evidence(
            vm,
            restaurant,
            "CURE",
            effective_action="PACKED",
            supersedes_evidence_index=0,
            nonce="cure-escalation-1",
        ),
    )
    vm.warp("2026-08-08T00:45:00Z")
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
        _corrective_evidence(
            vm,
            restaurant,
            "CURE",
            effective_action="PACKED",
            supersedes_evidence_index=0,
            nonce="cure-1",
        ),
    )

    assert int(unresolved_order.get_evidence_count("fg-1")) == before_count + 1
    assert unresolved_order.get_evidence("fg-1", before_count).nonce == "cure-1"
    assert unresolved_order.get_resolution("fg-1") == first_resolution

    vm.warp("2026-08-08T00:45:00Z")
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
    envelope = _corrective_evidence(
        vm,
        restaurant,
        "CURE",
        effective_action="PACKED",
        supersedes_evidence_index=0,
        nonce="restaurant-cure",
    )
    unresolved_order.submit_cure_evidence("fg-1", envelope)
    with vm.expect_revert("cure already submitted"):
        unresolved_order.submit_cure_evidence(
            "fg-1",
            _corrective_evidence(
                vm,
                restaurant,
                "CURE",
                effective_action="PACKED",
                supersedes_evidence_index=0,
                nonce="restaurant-cure-2",
            ),
        )

    tampered = json.loads(
        _corrective_evidence(
            vm,
            restaurant,
            "CURE",
            effective_action="PACKED",
            supersedes_evidence_index=0,
            nonce="bad-digest",
        )
    )
    tampered["source_url"] = "https://attacker.foodguard.app/rebound.json"
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
    tampered = json.loads(
        _corrective_evidence(
            vm,
            courier,
            "CURE",
            effective_action="DELIVERED",
            supersedes_evidence_index=2,
            nonce="bad-digest",
        )
    )
    tampered["source_url"] = "https://attacker.foodguard.app/rebound.json"
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
        _corrective_evidence(
            vm,
            customer,
            "APPEAL",
            effective_action="CUSTOMER_CLAIM",
            supersedes_evidence_index=3,
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
            _corrective_evidence(
                vm,
                customer,
                "APPEAL",
                effective_action="CUSTOMER_CLAIM",
                supersedes_evidence_index=3,
                item_id="item-2",
                nonce="appeal-2",
            ),
        )


def test_each_affected_role_can_append_one_appeal_without_replacing_the_decision(
    resolved_order,
    vm,
    customer,
    restaurant,
    courier,
):
    first_resolution = resolved_order.get_resolution("fg-1")
    before_count = int(resolved_order.get_evidence_count("fg-1"))
    appeals = [
        (customer, "item-2", "CUSTOMER_CLAIM", 3, "customer-appeal-1"),
        (restaurant, None, "PACKED", 0, "restaurant-appeal-1"),
        (courier, None, "DELIVERED", 2, "courier-appeal-1"),
    ]

    for appeal_index, (
        actor,
        item_id,
        effective_action,
        supersedes_evidence_index,
        nonce,
    ) in enumerate(appeals, start=1):
        vm.sender = actor
        resolved_order.appeal(
            "fg-1",
            _corrective_evidence(
                vm,
                actor,
                "APPEAL",
                effective_action=effective_action,
                supersedes_evidence_index=supersedes_evidence_index,
                item_id=item_id,
                nonce=nonce,
            ),
        )

        assert resolved_order.get_order("fg-1").state == "APPEALED"
        assert resolved_order.get_resolution("fg-1") == first_resolution
        assert int(resolved_order.get_evidence_count("fg-1")) == (
            before_count + appeal_index
        )

    for actor, item_id, effective_action, supersedes_evidence_index, nonce in appeals:
        vm.sender = actor
        with vm.expect_revert("appeal already used"):
            resolved_order.appeal(
                "fg-1",
                _corrective_evidence(
                    vm,
                    actor,
                    "APPEAL",
                    effective_action=effective_action,
                    supersedes_evidence_index=supersedes_evidence_index,
                    item_id=item_id,
                    nonce=nonce + "-replay",
                ),
            )

    stored_appeals = [
        resolved_order.get_evidence("fg-1", evidence_index)
        for evidence_index in range(before_count, before_count + len(appeals))
    ]
    assert [evidence.action for evidence in stored_appeals] == [
        "APPEAL",
        "APPEAL",
        "APPEAL",
    ]
    assert [evidence.nonce for evidence in stored_appeals] == [
        nonce for _actor, _item_id, _action, _index, nonce in appeals
    ]


def test_unaffected_addresses_cannot_appeal(
    resolved_order,
    vm,
    deployer,
    outsider,
):
    before_order = resolved_order.get_order("fg-1")
    before_count = resolved_order.get_evidence_count("fg-1")
    before_resolution = resolved_order.get_resolution("fg-1")

    for label, actor in (("deployer", deployer), ("outsider", outsider)):
        vm.sender = actor
        with vm.expect_revert("affected actor required"):
            resolved_order.appeal(
                "fg-1",
                evidence_json(
                    vm,
                    actor,
                    "APPEAL",
                    nonce=label + "-appeal",
                ),
            )

    assert resolved_order.get_order("fg-1") == before_order
    assert resolved_order.get_evidence_count("fg-1") == before_count
    assert resolved_order.get_resolution("fg-1") == before_resolution


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
        _corrective_evidence(
            vm,
            customer,
            "APPEAL",
            effective_action="CUSTOMER_CLAIM",
            supersedes_evidence_index=3,
            item_id="item-2",
            nonce="customer-appeal",
        ),
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
        "active_evidence_digest": "0x" + hashlib.sha256(
            _canonical_json(
                [
                    [index, mutual_order.get_evidence("fg-1", index).sha256.lower()]
                    for index in json.loads(
                        mutual_order.get_resolution("fg-1")
                    )["evidence_indices"]
                ]
            ).encode("utf-8")
        ).hexdigest(),
        "chain_id": str(vm._chain_id),
        "contract_address": addr(vm._contract_address).lower(),
        "order_id": "fg-1",
        "proposal_version": 1,
        "resolution_round": 2,
    }
    expected_digest = "0x" + hashlib.sha256(
        _canonical_json(expected_preimage).encode("utf-8")
    ).hexdigest()
    proposal = mutual_order.get_settlement_proposal("fg-1", digest)
    assert digest == expected_digest
    assert proposal.digest == expected_digest
    assert proposal.proposal_json == _canonical_json(expected_preimage)
    assert mutual_order.get_settlement_proposal_count("fg-1") == 1
    assert mutual_order.get_settlement_proposal_digest("fg-1", 0) == digest


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
    replacement = mutual_order.propose_mutual_settlement(
        "fg-1",
        _allocation(
            nonce="mutual-2",
            item_2_customer="19",
            item_2_restaurant="1",
        ),
    )

    proposal = mutual_order.get_settlement_proposal("fg-1", digest)
    assert proposal.digest == digest
    assert replacement != digest
    assert mutual_order.get_settlement_proposal_count("fg-1") == 2


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
    with vm.expect_revert("settlement proposal not found"):
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


def test_cure_window_blocks_immediate_outsider_reresolution(
    unresolved_order,
    vm,
    restaurant,
    outsider,
):
    order = unresolved_order.get_order("fg-1")
    assert order.cure_deadline == 1_786_149_900
    vm.sender = restaurant
    unresolved_order.submit_cure_evidence(
        "fg-1",
        _corrective_evidence(
            vm,
            restaurant,
            "CURE",
            effective_action="PACKED",
            supersedes_evidence_index=0,
            nonce="bounded-cure-1",
        ),
    )
    _mock_sources(vm, _committed_sources(unresolved_order))
    _mock_resolution(vm, MATCH_ALL_RESULT)
    vm.sender = outsider

    with vm.expect_revert("cure deadline not reached"):
        unresolved_order.request_resolution("fg-1")

    assert unresolved_order.get_round("fg-1") == 1
    assert unresolved_order.get_order("fg-1").state == "EVIDENCE_CURE"


def test_cure_requires_typed_same_actor_supersession(unresolved_order, vm, restaurant):
    before_count = unresolved_order.get_evidence_count("fg-1")
    vm.sender = restaurant

    with vm.expect_revert("typed corrective evidence required"):
        unresolved_order.submit_cure_evidence(
            "fg-1",
            evidence_json(vm, restaurant, "CURE", nonce="untyped-cure"),
        )

    assert unresolved_order.get_evidence_count("fg-1") == before_count


def test_superseded_source_stays_in_history_but_not_in_the_next_round_active_set(
    unresolved_order,
    vm,
    restaurant,
    outsider,
):
    superseded = unresolved_order.get_evidence("fg-1", 0)
    vm.sender = restaurant
    unresolved_order.submit_cure_evidence(
        "fg-1",
        _corrective_evidence(
            vm,
            restaurant,
            "CURE",
            effective_action="PACKED",
            supersedes_evidence_index=0,
            nonce="supersede-packed-1",
        ),
    )
    assert unresolved_order.get_evidence("fg-1", 0).sha256 == superseded.sha256
    sources = _committed_sources(unresolved_order)
    sources.pop(superseded.source_url)
    _mock_sources(vm, sources)
    vm.mock_web(
        superseded.source_url,
        {"status": 503, "body": ""},
    )
    _mock_resolution(vm, MATCH_ALL_RESULT)
    vm.warp("2026-08-08T00:50:00Z")
    vm.sender = outsider

    returned = json.loads(unresolved_order.request_resolution("fg-1"))

    assert unresolved_order.get_order("fg-1").state == "RESOLVED"
    assert returned["evidence_indices"] == [1, 2, 3, 4]
    assert returned["evidence_hashes"] == [
        unresolved_order.get_evidence("fg-1", index).sha256
        for index in returned["evidence_indices"]
    ]


def test_escalated_order_accepts_one_bounded_retry_round(
    escalated_order,
    vm,
    restaurant,
    outsider,
):
    before_count = int(escalated_order.get_evidence_count("fg-1"))
    retry_deadline = int(escalated_order.get_order("fg-1").cure_deadline)
    vm.sender = restaurant
    escalated_order.submit_cure_evidence(
        "fg-1",
        _corrective_evidence(
            vm,
            restaurant,
            "CURE",
            effective_action="PACKED",
            supersedes_evidence_index=before_count - 1,
            nonce="escalated-retry-1",
        ),
    )
    assert int(escalated_order.get_evidence_count("fg-1")) == before_count + 1

    vm.warp("2026-08-08T01:00:00Z")
    assert int(escalated_order.get_order("fg-1").cure_deadline) <= retry_deadline
    _resolve(escalated_order, vm, outsider, MATCH_ALL_RESULT)

    assert escalated_order.get_order("fg-1").state == "RESOLVED"
    assert escalated_order.get_round("fg-1") == 3


def test_mutual_settlement_supports_concurrent_versioned_proposal_digests(
    mutual_order,
    vm,
    customer,
    restaurant,
):
    vm.sender = customer
    first = mutual_order.propose_mutual_settlement(
        "fg-1",
        _allocation(nonce="customer-v1"),
    )
    vm.sender = restaurant
    second = mutual_order.propose_mutual_settlement(
        "fg-1",
        _allocation(
            nonce="restaurant-v1",
            item_2_customer="19",
            item_2_restaurant="1",
        ),
    )

    assert first != second
    assert mutual_order.get_settlement_proposal_count("fg-1") == 2
    assert mutual_order.get_settlement_proposal("fg-1", first).digest == first
    assert mutual_order.get_settlement_proposal("fg-1", second).digest == second
