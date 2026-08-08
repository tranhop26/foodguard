import json

import pytest

from conftest import (
    DEADLINES,
    DEADLINES_DATA,
    MANIFEST,
    MANIFEST_DATA,
    addr,
)


def test_create_order_reserves_exact_value(
    food_guard,
    vm,
    customer,
    restaurant,
    courier,
):
    vm.sender = customer
    vm.value = 130

    food_guard.create_order(
        "fg-1",
        addr(restaurant),
        addr(courier),
        MANIFEST,
        30,
        DEADLINES,
    )

    order = food_guard.get_order("fg-1")
    accounting = food_guard.get_accounting()
    assert order.state == "FUNDED"
    assert accounting.total_inflows == 130
    assert accounting.reserved_items == 100
    assert accounting.reserved_delivery == 30


def test_manifest_item_with_delimiters_round_trips_as_canonical_json(created_order):
    item_json = created_order.get_item("fg-1", "item|1")

    assert item_json == (
        '{"conditions":["served | warm"],"item_id":"item|1",'
        '"name":"Cơm | tấm","permitted_substitutions":[],'
        '"price_wei":"40","quantity":2}'
    )
    assert json.loads(item_json)["name"] == "Cơm | tấm"


def test_rejects_noncanonical_manifest_json(
    food_guard,
    vm,
    customer,
    restaurant,
    courier,
):
    noncanonical = json.dumps(MANIFEST_DATA, ensure_ascii=False, indent=2, sort_keys=True)
    vm.sender = customer
    vm.value = 130

    with vm.expect_revert("canonical manifest JSON required"):
        food_guard.create_order(
            "not-canonical",
            addr(restaurant),
            addr(courier),
            noncanonical,
            30,
            DEADLINES,
        )

    assert food_guard.get_accounting().total_inflows == 0


@pytest.mark.parametrize(
    ("case_name", "items"),
    [
        ("empty", []),
        ("duplicate-id", [MANIFEST_DATA["items"][0], MANIFEST_DATA["items"][0]]),
        (
            "missing-field",
            [{key: value for key, value in MANIFEST_DATA["items"][0].items() if key != "conditions"}],
        ),
        ("zero-quantity", [{**MANIFEST_DATA["items"][0], "quantity": 0}]),
        ("float-quantity", [{**MANIFEST_DATA["items"][0], "quantity": 1.5}]),
        ("noncanonical-price", [{**MANIFEST_DATA["items"][0], "price_wei": "040"}]),
        ("non-ascii-price", [{**MANIFEST_DATA["items"][0], "price_wei": "٤٠"}]),
    ],
)
def test_rejects_invalid_manifest_items(
    case_name,
    items,
    food_guard,
    vm,
    customer,
    restaurant,
    courier,
):
    invalid_manifest = json.dumps(
        {"items": items},
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    )
    vm.sender = customer
    vm.value = 130

    with vm.expect_revert("invalid manifest"):
        food_guard.create_order(
            "invalid-" + case_name,
            addr(restaurant),
            addr(courier),
            invalid_manifest,
            30,
            DEADLINES,
        )

    assert food_guard.get_accounting().total_inflows == 0


def test_rejects_unicode_zero_price_before_accepting_a_zero_value_order(
    food_guard,
    vm,
    customer,
    restaurant,
    courier,
):
    zero_manifest = json.dumps(
        {
            "items": [
                {
                    **MANIFEST_DATA["items"][0],
                    "price_wei": "٠",
                    "quantity": 1,
                }
            ]
        },
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    )
    vm.sender = customer
    vm.value = 0

    with vm.expect_revert("invalid manifest"):
        food_guard.create_order(
            "unicode-zero-price",
            addr(restaurant),
            addr(courier),
            zero_manifest,
            0,
            DEADLINES,
        )

    assert food_guard.get_accounting().total_inflows == 0


@pytest.mark.parametrize("deadline_case", ["noncanonical", "past", "out-of-order"])
def test_rejects_invalid_deadlines(
    deadline_case,
    food_guard,
    vm,
    customer,
    restaurant,
    courier,
):
    deadlines = dict(DEADLINES_DATA)
    if deadline_case == "past":
        deadlines["acceptance_deadline"] = 1_786_147_199
    elif deadline_case == "out-of-order":
        deadlines["packing_deadline"] = deadlines["acceptance_deadline"]
    invalid_deadlines = json.dumps(
        deadlines,
        indent=2 if deadline_case == "noncanonical" else None,
        separators=None if deadline_case == "noncanonical" else (",", ":"),
        sort_keys=True,
    )
    vm.sender = customer
    vm.value = 130

    with vm.expect_revert("valid canonical deadlines required"):
        food_guard.create_order(
            "invalid-deadlines-" + deadline_case,
            addr(restaurant),
            addr(courier),
            MANIFEST,
            30,
            invalid_deadlines,
        )

    assert food_guard.get_accounting().total_inflows == 0


def test_rejects_duplicate_order_id_without_double_reserving(
    created_order,
    vm,
    customer,
    restaurant,
    courier,
):
    vm.sender = customer
    vm.value = 130

    with vm.expect_revert("order already exists"):
        created_order.create_order(
            "fg-1",
            addr(restaurant),
            addr(courier),
            MANIFEST,
            30,
            DEADLINES,
        )

    assert created_order.get_accounting().total_inflows == 130


@pytest.mark.parametrize("first_role", ["restaurant", "courier"])
def test_acceptance_paths_record_independently_in_either_order(
    first_role,
    created_order,
    vm,
    restaurant,
    courier,
):
    first_actor = restaurant if first_role == "restaurant" else courier
    second_actor = courier if first_role == "restaurant" else restaurant
    first_method = (
        created_order.accept_restaurant
        if first_role == "restaurant"
        else created_order.accept_courier
    )
    second_method = (
        created_order.accept_courier
        if first_role == "restaurant"
        else created_order.accept_restaurant
    )
    vm.sender = first_actor
    first_method("fg-1")

    partial = created_order.get_order("fg-1")
    assert partial.state == "PARTIALLY_ACCEPTED"
    assert partial.restaurant_accepted is (first_role == "restaurant")
    assert partial.courier_accepted is (first_role == "courier")

    vm.sender = second_actor
    second_method("fg-1")

    accepted = created_order.get_order("fg-1")
    assert accepted.state == "ACCEPTED"
    assert accepted.restaurant_accepted is True
    assert accepted.courier_accepted is True


@pytest.mark.parametrize("role", ["restaurant", "courier"])
def test_rejects_acceptance_from_an_unbound_wallet(
    role,
    created_order,
    vm,
    outsider,
):
    vm.sender = outsider
    method = (
        created_order.accept_restaurant
        if role == "restaurant"
        else created_order.accept_courier
    )

    with vm.expect_revert("only assigned provider may accept"):
        method("fg-1")

    order = created_order.get_order("fg-1")
    assert order.state == "FUNDED"
    assert order.restaurant_accepted is False
    assert order.courier_accepted is False


@pytest.mark.parametrize("role", ["restaurant", "courier"])
def test_rejects_duplicate_acceptance_without_changing_partial_state(
    role,
    created_order,
    vm,
    restaurant,
    courier,
):
    vm.sender = restaurant if role == "restaurant" else courier
    method = (
        created_order.accept_restaurant
        if role == "restaurant"
        else created_order.accept_courier
    )
    method("fg-1")

    with vm.expect_revert("provider already accepted"):
        method("fg-1")

    assert created_order.get_order("fg-1").state == "PARTIALLY_ACCEPTED"


@pytest.mark.parametrize("role", ["restaurant", "courier"])
def test_acceptance_deadline_is_strict(
    role,
    created_order,
    vm,
    restaurant,
    courier,
):
    vm.warp("2026-08-08T00:10:00Z")
    vm.sender = restaurant if role == "restaurant" else courier
    method = (
        created_order.accept_restaurant
        if role == "restaurant"
        else created_order.accept_courier
    )

    with vm.expect_revert("acceptance deadline passed"):
        method("fg-1")

    assert created_order.get_order("fg-1").state == "FUNDED"


def test_only_immutable_deployer_can_pause_creation(
    food_guard,
    vm,
    outsider,
    customer,
    restaurant,
    courier,
):
    vm.sender = outsider
    with vm.expect_revert("only deployer may pause creation"):
        food_guard.set_creation_paused(True)

    vm.sender = customer
    vm.value = 130
    food_guard.create_order(
        "still-open",
        addr(restaurant),
        addr(courier),
        MANIFEST,
        30,
        DEADLINES,
    )
    assert food_guard.get_order("still-open").state == "FUNDED"


def test_pause_blocks_only_new_order_creation(
    created_order,
    vm,
    deployer,
    customer,
    restaurant,
    courier,
):
    vm.sender = deployer
    created_order.set_creation_paused(True)

    vm.sender = customer
    vm.value = 130
    with vm.expect_revert("order creation is paused"):
        created_order.create_order(
            "fg-2",
            addr(restaurant),
            addr(courier),
            MANIFEST,
            30,
            DEADLINES,
        )
    assert created_order.get_accounting().total_inflows == 130

    vm.value = 0
    vm.sender = restaurant
    created_order.accept_restaurant("fg-1")
    vm.sender = courier
    created_order.accept_courier("fg-1")
    assert created_order.get_order("fg-1").state == "ACCEPTED"


def test_customer_cancels_unaccepted_order_with_one_finalized_full_refund(
    created_order,
    emitted_messages,
    vm,
    customer,
    outsider,
):
    vm.sender = customer
    created_order.cancel_unaccepted("fg-1")

    order = created_order.get_order("fg-1")
    accounting = created_order.get_accounting()
    assert order.state == "CANCELLED_REFUNDED"
    assert order.refund_emitted is True
    assert accounting.total_inflows == 130
    assert accounting.reserved_items == 0
    assert accounting.reserved_delivery == 0
    assert accounting.customer_refunds_emitted == 130
    assert len(emitted_messages) == 1
    assert addr(emitted_messages[0]["address"]).lower() == addr(customer).lower()
    assert emitted_messages[0]["value"] == 130
    assert emitted_messages[0]["on"] == "finalized"

    vm.sender = outsider
    created_order.cancel_unaccepted("fg-1")
    assert len(emitted_messages) == 1
    assert created_order.get_accounting().customer_refunds_emitted == 130


@pytest.mark.parametrize("accepted_role", ["restaurant", "courier"])
def test_partial_acceptance_timeout_refunds_and_invalidates_acceptance(
    accepted_role,
    created_order,
    emitted_messages,
    vm,
    restaurant,
    courier,
    outsider,
    customer,
):
    vm.sender = restaurant if accepted_role == "restaurant" else courier
    method = (
        created_order.accept_restaurant
        if accepted_role == "restaurant"
        else created_order.accept_courier
    )
    method("fg-1")
    vm.warp("2026-08-08T00:10:01Z")
    vm.sender = outsider

    created_order.cancel_unaccepted("fg-1")

    order = created_order.get_order("fg-1")
    assert order.state == "CANCELLED_REFUNDED"
    assert order.restaurant_accepted is False
    assert order.courier_accepted is False
    assert len(emitted_messages) == 1
    assert addr(emitted_messages[0]["address"]).lower() == addr(customer).lower()


@pytest.mark.parametrize(
    "rejection_case",
    ["outsider-before-deadline", "partial-before-deadline", "fully-accepted-after-deadline"],
)
def test_rejected_cancellation_preserves_reserves_and_emits_nothing(
    rejection_case,
    created_order,
    emitted_messages,
    vm,
    customer,
    restaurant,
    courier,
    outsider,
):
    if rejection_case == "outsider-before-deadline":
        vm.sender = outsider
    elif rejection_case == "partial-before-deadline":
        vm.sender = restaurant
        created_order.accept_restaurant("fg-1")
        vm.sender = customer
    else:
        vm.sender = restaurant
        created_order.accept_restaurant("fg-1")
        vm.sender = courier
        created_order.accept_courier("fg-1")
        vm.warp("2026-08-08T00:10:01Z")
        vm.sender = outsider

    with vm.expect_revert("order cannot be cancelled"):
        created_order.cancel_unaccepted("fg-1")

    accounting = created_order.get_accounting()
    assert accounting.reserved_items == 100
    assert accounting.reserved_delivery == 30
    assert accounting.customer_refunds_emitted == 0
    assert emitted_messages == []


def test_pause_does_not_block_existing_order_refund(
    created_order,
    emitted_messages,
    vm,
    deployer,
    customer,
):
    vm.sender = deployer
    created_order.set_creation_paused(True)
    vm.sender = customer

    created_order.cancel_unaccepted("fg-1")

    assert created_order.get_order("fg-1").state == "CANCELLED_REFUNDED"
    assert len(emitted_messages) == 1


def test_intentionally_frozen_public_abi_has_no_privileged_escape_hatch(food_guard):
    schema = json.loads(type(food_guard._instance).__get_schema__())

    assert set(schema["methods"]) == {
        "accept_courier",
        "accept_restaurant",
        "cancel_unaccepted",
        "create_order",
        "get_accounting",
        "get_evidence",
        "get_evidence_count",
        "get_item",
        "get_order",
        "get_resolution",
        "request_resolution",
        "set_creation_paused",
        "submit_claim_evidence",
        "submit_delivery_evidence",
        "submit_packed_evidence",
        "submit_pickup_evidence",
    }


def test_rejects_inexact_value_without_changing_accounting(
    food_guard,
    vm,
    customer,
    restaurant,
    courier,
):
    vm.sender = customer
    vm.value = 129

    with vm.expect_revert("exact order value required"):
        food_guard.create_order(
            "short",
            addr(restaurant),
            addr(courier),
            MANIFEST,
            30,
            DEADLINES,
        )

    accounting = food_guard.get_accounting()
    assert accounting.total_inflows == 0
    assert accounting.reserved_items == 0
    assert accounting.reserved_delivery == 0


@pytest.mark.parametrize("duplicate_pair", ["providers", "customer_restaurant", "customer_courier"])
def test_rejects_any_same_actor_wallet_pair(
    duplicate_pair,
    food_guard,
    vm,
    customer,
    restaurant,
    courier,
):
    restaurant_arg = restaurant
    courier_arg = courier
    if duplicate_pair == "providers":
        courier_arg = restaurant
    elif duplicate_pair == "customer_restaurant":
        restaurant_arg = customer
    else:
        courier_arg = customer
    vm.sender = customer
    vm.value = 130

    with vm.expect_revert("three distinct wallets required"):
        food_guard.create_order(
            "same-" + duplicate_pair,
            addr(restaurant_arg),
            addr(courier_arg),
            MANIFEST,
            30,
            DEADLINES,
        )

    assert food_guard.get_accounting().total_inflows == 0


@pytest.mark.parametrize("zero_role", ["customer", "restaurant", "courier"])
def test_rejects_a_zero_actor_wallet(
    zero_role,
    food_guard,
    vm,
    customer,
    restaurant,
    courier,
):
    zero = bytes(20)
    customer_arg = zero if zero_role == "customer" else customer
    restaurant_arg = zero if zero_role == "restaurant" else restaurant
    courier_arg = zero if zero_role == "courier" else courier
    vm.sender = customer_arg
    vm.value = 130

    with vm.expect_revert("three nonzero wallets required"):
        food_guard.create_order(
            "zero-" + zero_role,
            addr(restaurant_arg),
            addr(courier_arg),
            MANIFEST,
            30,
            DEADLINES,
        )

    assert food_guard.get_accounting().total_inflows == 0
