import json

import pytest

from conftest import addr
from test_appeal import UNRESOLVED_RESULT, _allocation, _resolve
from test_evidence import evidence_json
from test_resolution import (
    MIXED_RESULT,
    _advance_to_resolution,
    _committed_sources,
    _mock_resolution,
    _mock_sources,
)


def assert_conserved(contract):
    accounting = contract.get_accounting()
    assert accounting.total_inflows == (
        accounting.reserved_items
        + accounting.reserved_delivery
        + accounting.restaurant_payouts_emitted
        + accounting.courier_payouts_emitted
        + accounting.customer_refunds_emitted
    )


def _resolve_as(contract, vm, outsider, result):
    _mock_sources(vm, _committed_sources(contract))
    _mock_resolution(vm, result)
    vm.sender = outsider
    contract.request_resolution("fg-1")
    vm.clear_mocks()
    return contract


@pytest.fixture
def resolved_order(created_order, vm, customer, restaurant, courier, outsider):
    contract = _advance_to_resolution(
        created_order,
        vm,
        customer,
        restaurant,
        courier,
    )
    _resolve_as(contract, vm, outsider, MIXED_RESULT)
    vm.deal(vm._contract_address, 130)
    return contract


@pytest.fixture
def mutual_order(created_order, vm, customer, restaurant, courier, outsider):
    contract = _advance_to_resolution(
        created_order,
        vm,
        customer,
        restaurant,
        courier,
    )
    _resolve(contract, vm, outsider, UNRESOLVED_RESULT)
    vm.sender = restaurant
    contract.submit_cure_evidence(
        "fg-1",
        evidence_json(vm, restaurant, "CURE", nonce="accounting-cure"),
    )
    _resolve(contract, vm, outsider, UNRESOLVED_RESULT)
    vm.warp("2026-08-08T00:50:00Z")
    vm.deal(vm._contract_address, 130)
    return contract


def test_mixed_outcomes_conserve_and_emit_each_transfer_once(
    resolved_order,
    emitted_messages,
    vm,
    outsider,
    customer,
    restaurant,
    courier,
):
    vm.warp("2026-08-08T00:50:00Z")
    vm.sender = outsider

    settlement_id = resolved_order.execute_settlement("fg-1")

    settlement = resolved_order.get_order_settlement("fg-1")
    transfers = {
        addr(message["address"]).lower(): message["value"]
        for message in emitted_messages
    }
    assert settlement_id
    assert settlement.settlement_id == settlement_id
    assert settlement.customer_wei == 20
    assert settlement.restaurant_wei == 80
    assert settlement.courier_wei == 30
    assert transfers == {
        addr(customer).lower(): 20,
        addr(restaurant).lower(): 80,
        addr(courier).lower(): 30,
    }
    assert all(message["on"] == "finalized" for message in emitted_messages)
    assert_conserved(resolved_order)


@pytest.mark.parametrize(
    ("item_outcome", "delivery_outcome", "expected"),
    [
        ("MISSING", "DELIVERED", (20, 80, 30)),
        ("MISMATCHED", "DELIVERY_FAILED", (50, 80, 0)),
        ("DELIVERY_FAILED", "DELIVERED", (20, 80, 30)),
    ],
)
def test_each_failure_outcome_allocates_only_to_bound_recipients(
    item_outcome,
    delivery_outcome,
    expected,
    created_order,
    emitted_messages,
    vm,
    customer,
    restaurant,
    courier,
    outsider,
):
    contract = _advance_to_resolution(
        created_order,
        vm,
        customer,
        restaurant,
        courier,
    )
    result = json.loads(json.dumps(MIXED_RESULT))
    result["items"][1]["outcome"] = item_outcome
    result["delivery_outcome"] = delivery_outcome
    _resolve_as(contract, vm, outsider, result)
    vm.warp("2026-08-08T00:50:00Z")
    vm.deal(vm._contract_address, 130)
    vm.sender = outsider

    contract.execute_settlement("fg-1")

    settlement = contract.get_order_settlement("fg-1")
    assert (
        settlement.customer_wei,
        settlement.restaurant_wei,
        settlement.courier_wei,
    ) == expected
    expected_transfers = {
        recipient: amount
        for recipient, amount in (
            (addr(customer).lower(), expected[0]),
            (addr(restaurant).lower(), expected[1]),
            (addr(courier).lower(), expected[2]),
        )
        if amount > 0
    }
    assert {
        addr(message["address"]).lower(): message["value"]
        for message in emitted_messages
    } == expected_transfers
    assert_conserved(contract)


def test_double_execute_returns_same_id_without_new_transfer(
    resolved_order,
    emitted_messages,
    vm,
    outsider,
):
    vm.warp("2026-08-08T00:50:00Z")
    vm.sender = outsider
    first = resolved_order.execute_settlement("fg-1")
    before = list(emitted_messages)

    second = resolved_order.execute_settlement("fg-1")

    assert first == second
    assert emitted_messages == before
    assert_conserved(resolved_order)


def test_insolvency_aborts_before_ledger_mutation_and_emission(
    resolved_order,
    emitted_messages,
    vm,
    outsider,
):
    before_order = resolved_order.get_order("fg-1")
    before_accounting = resolved_order.get_accounting()
    vm.warp("2026-08-08T00:50:00Z")
    vm.deal(vm._contract_address, 1)
    vm.sender = outsider

    with vm.expect_revert("insufficient contract balance"):
        resolved_order.execute_settlement("fg-1")

    assert resolved_order.get_order("fg-1") == before_order
    assert resolved_order.get_accounting() == before_accounting
    with vm.expect_revert("settlement not found"):
        resolved_order.get_order_settlement("fg-1")
    assert emitted_messages == []


def test_settlement_waits_until_exact_appeal_deadline(
    resolved_order,
    emitted_messages,
    vm,
    outsider,
):
    vm.warp("2026-08-08T00:49:59Z")
    vm.sender = outsider
    with vm.expect_revert("appeal deadline not reached"):
        resolved_order.execute_settlement("fg-1")
    assert emitted_messages == []

    vm.warp("2026-08-08T00:50:00Z")
    resolved_order.execute_settlement("fg-1")
    assert len(emitted_messages) == 3


def test_unresolved_decision_cannot_release_reserves(
    created_order,
    emitted_messages,
    vm,
    customer,
    restaurant,
    courier,
    outsider,
):
    contract = _advance_to_resolution(
        created_order,
        vm,
        customer,
        restaurant,
        courier,
    )
    _resolve_as(contract, vm, outsider, UNRESOLVED_RESULT)
    vm.warp("2026-08-08T00:50:00Z")
    vm.deal(vm._contract_address, 130)
    vm.sender = outsider

    with vm.expect_revert("invalid settlement transition"):
        contract.execute_settlement("fg-1")

    assert contract.get_accounting().reserved_items == 100
    assert contract.get_accounting().reserved_delivery == 30
    assert emitted_messages == []


def test_unanimous_mutual_settlement_uses_the_same_immutable_ledger(
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
    vm.sender = restaurant
    mutual_order.sign_mutual_settlement("fg-1", digest)
    vm.sender = courier
    mutual_order.sign_mutual_settlement("fg-1", digest)
    before = list(emitted_messages)

    settlement = mutual_order.get_order_settlement("fg-1")
    vm.sender = outsider
    replayed_id = mutual_order.execute_settlement("fg-1")

    assert settlement.settlement_id == replayed_id
    assert (
        settlement.customer_wei,
        settlement.restaurant_wei,
        settlement.courier_wei,
    ) == (20, 80, 30)
    assert emitted_messages == before
    assert_conserved(mutual_order)


def test_final_mutual_signature_preflights_insolvency_before_persisting(
    mutual_order,
    emitted_messages,
    vm,
    customer,
    restaurant,
    courier,
    monkeypatch,
):
    vm.sender = customer
    digest = mutual_order.propose_mutual_settlement("fg-1", _allocation())
    mutual_order.sign_mutual_settlement("fg-1", digest)
    vm.sender = restaurant
    mutual_order.sign_mutual_settlement("fg-1", digest)
    before_order = mutual_order.get_order("fg-1")
    before_accounting = mutual_order.get_accounting()

    instance = mutual_order._instance
    contract_wasi = type(instance).__mro__[1].balance.fget.__globals__["wasi"]
    original_get_self_balance = contract_wasi.get_self_balance
    final_signature_at_balance_check = []

    def observe_balance_check():
        stored = instance.settlement_proposal_by_order["fg-1"]
        final_signature_at_balance_check.append(stored.courier_signed)
        return original_get_self_balance()

    monkeypatch.setattr(
        contract_wasi,
        "get_self_balance",
        observe_balance_check,
    )
    vm.deal(vm._contract_address, 1)
    vm.sender = courier

    with vm.expect_revert("insufficient contract balance"):
        mutual_order.sign_mutual_settlement("fg-1", digest)

    stored = mutual_order.get_settlement_proposal("fg-1")
    assert final_signature_at_balance_check == [False]
    assert stored.customer_signed is True
    assert stored.restaurant_signed is True
    assert stored.courier_signed is False
    assert mutual_order.get_order("fg-1") == before_order
    assert mutual_order.get_accounting() == before_accounting
    with vm.expect_revert("settlement not found"):
        mutual_order.get_order_settlement("fg-1")
    assert emitted_messages == []


def test_exact_acceptance_deadline_is_permissionless_cancellation_boundary(
    created_order,
    emitted_messages,
    vm,
    outsider,
):
    vm.deal(vm._contract_address, 130)
    vm.warp("2026-08-08T00:10:00Z")
    vm.sender = outsider

    created_order.cancel_unaccepted("fg-1")

    settlement = created_order.get_order_settlement("fg-1")
    assert settlement.customer_wei == 130
    assert settlement.restaurant_wei == 0
    assert settlement.courier_wei == 0
    assert len(emitted_messages) == 1
    assert_conserved(created_order)
