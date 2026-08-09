import pytest

from conftest import DEADLINES, MANIFEST, addr


ORDER_ID = "fg-cancel-v2"


@pytest.fixture
def cancellable_order(food_guard, vm, customer, restaurant, courier):
    def create(starting_state, partial_actor="restaurant"):
        vm.sender = customer
        vm.value = 130
        food_guard.create_order(
            ORDER_ID,
            addr(restaurant),
            addr(courier),
            MANIFEST,
            30,
            DEADLINES,
        )
        vm.deal(vm._contract_address, 130)
        vm.value = 0

        if starting_state == "PARTIALLY_ACCEPTED":
            vm.sender = restaurant if partial_actor == "restaurant" else courier
            method = (
                food_guard.accept_restaurant
                if partial_actor == "restaurant"
                else food_guard.accept_courier
            )
            method(ORDER_ID)
        elif starting_state == "ACCEPTED":
            vm.sender = restaurant
            food_guard.accept_restaurant(ORDER_ID)
            vm.sender = courier
            food_guard.accept_courier(ORDER_ID)

        return food_guard, {
            "customer": customer,
            "restaurant": restaurant,
            "courier": courier,
        }

    return create


@pytest.mark.parametrize("actor_name", ["customer", "restaurant", "courier"])
@pytest.mark.parametrize("starting_state", ["FUNDED", "PARTIALLY_ACCEPTED", "ACCEPTED"])
def test_named_participant_cancels_before_packing(
    cancellable_order, actor_name, starting_state, vm, emitted_messages
):
    contract, actors = cancellable_order(starting_state)
    vm.sender = actors[actor_name]

    contract.cancel_before_packed(ORDER_ID)

    order = contract.get_order(ORDER_ID)
    assert order.state == "CANCELLED_REFUNDED"
    assert order.refund_emitted is True
    assert order.restaurant_accepted is False
    assert order.courier_accepted is False
    accounting = contract.get_accounting()
    assert accounting.reserved_items == 0
    assert accounting.reserved_delivery == 0
    assert accounting.restaurant_payouts_emitted == 0
    assert accounting.courier_payouts_emitted == 0
    assert accounting.customer_refunds_emitted == 130
    assert len(emitted_messages) == 1
    assert addr(emitted_messages[0]["address"]).lower() == addr(
        actors["customer"]
    ).lower()
    assert emitted_messages[0]["value"] == 130
    assert emitted_messages[0]["on"] == "finalized"


@pytest.mark.parametrize("actor_name", ["customer", "restaurant", "courier"])
def test_named_participant_cancels_courier_only_partial_acceptance(
    cancellable_order, actor_name, vm, emitted_messages
):
    contract, actors = cancellable_order("PARTIALLY_ACCEPTED", "courier")
    vm.sender = actors[actor_name]

    contract.cancel_before_packed(ORDER_ID)

    order = contract.get_order(ORDER_ID)
    assert order.state == "CANCELLED_REFUNDED"
    assert order.refund_emitted is True
    assert order.restaurant_accepted is False
    assert order.courier_accepted is False
    accounting = contract.get_accounting()
    assert accounting.reserved_items == 0
    assert accounting.reserved_delivery == 0
    assert accounting.restaurant_payouts_emitted == 0
    assert accounting.courier_payouts_emitted == 0
    assert accounting.customer_refunds_emitted == 130
    assert len(emitted_messages) == 1
    assert addr(emitted_messages[0]["address"]).lower() == addr(
        actors["customer"]
    ).lower()
    assert emitted_messages[0]["value"] == 130
    assert emitted_messages[0]["on"] == "finalized"


def test_outsider_cannot_cancel_before_packing(
    cancellable_order, outsider, vm, emitted_messages
):
    contract, _ = cancellable_order("FUNDED")
    gl = type(contract._instance).cancel_unaccepted.__globals__["gl"]
    vm.sender = outsider

    with pytest.raises(gl.vm.UserError) as exc_info:
        contract.cancel_before_packed(ORDER_ID)
    assert exc_info.value.message == "[EXPECTED] order participant required"

    accounting = contract.get_accounting()
    assert accounting.reserved_items == 100
    assert accounting.reserved_delivery == 30
    assert accounting.customer_refunds_emitted == 0
    assert emitted_messages == []


def test_missing_order_cannot_be_cancelled_before_packing(food_guard, customer, vm):
    gl = type(food_guard._instance).cancel_unaccepted.__globals__["gl"]
    vm.sender = customer

    with pytest.raises(gl.vm.UserError) as exc_info:
        food_guard.cancel_before_packed("missing-order")
    assert exc_info.value.message == "[EXPECTED] order not found"


@pytest.mark.parametrize(
    "closed_state",
    [
        "READY_FOR_PICKUP",
        "IN_TRANSIT",
        "REVIEW_WINDOW",
        "EVIDENCE_CURE",
        "ESCALATED",
        "RESOLVED",
        "APPEALED",
        "SETTLED",
    ],
)
def test_participant_cancellation_is_closed_after_packing_starts(
    cancellable_order, closed_state, customer, vm, emitted_messages
):
    contract, _ = cancellable_order("ACCEPTED")
    order = contract._instance.orders[ORDER_ID]
    order.state = closed_state
    contract._instance.orders[ORDER_ID] = order
    gl = type(contract._instance).cancel_unaccepted.__globals__["gl"]
    vm.sender = customer

    with pytest.raises(gl.vm.UserError) as exc_info:
        contract.cancel_before_packed(ORDER_ID)
    assert exc_info.value.message == "[EXPECTED] participant cancellation closed"

    accounting = contract.get_accounting()
    assert accounting.reserved_items == 100
    assert accounting.reserved_delivery == 30
    assert accounting.customer_refunds_emitted == 0
    assert emitted_messages == []


def test_participant_cancellation_replay_preserves_accounting_and_messages(
    cancellable_order, customer, outsider, vm, emitted_messages
):
    contract, _ = cancellable_order("ACCEPTED")
    vm.sender = customer
    contract.cancel_before_packed(ORDER_ID)

    accounting = contract.get_accounting()
    accounting_before = (
        accounting.total_inflows,
        accounting.reserved_items,
        accounting.reserved_delivery,
        accounting.restaurant_payouts_emitted,
        accounting.courier_payouts_emitted,
        accounting.customer_refunds_emitted,
    )
    messages_before = list(emitted_messages)
    vm.sender = outsider

    contract.cancel_before_packed(ORDER_ID)

    accounting = contract.get_accounting()
    assert (
        accounting.total_inflows,
        accounting.reserved_items,
        accounting.reserved_delivery,
        accounting.restaurant_payouts_emitted,
        accounting.courier_payouts_emitted,
        accounting.customer_refunds_emitted,
    ) == accounting_before
    assert emitted_messages == messages_before
    assert accounting.total_inflows == (
        accounting.reserved_items
        + accounting.reserved_delivery
        + accounting.restaurant_payouts_emitted
        + accounting.courier_payouts_emitted
        + accounting.customer_refunds_emitted
    )
