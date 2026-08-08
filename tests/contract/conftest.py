import hashlib
import json
import os
import sys

import pytest

BASE_TIME = "2026-08-08T00:00:00Z"
ACCEPTANCE_DEADLINE = 1_786_147_800

MANIFEST_DATA = {
    "items": [
        {
            "conditions": ["served | warm"],
            "item_id": "item|1",
            "name": "Cơm | tấm",
            "permitted_substitutions": [],
            "price_wei": "40",
            "quantity": 2,
        },
        {
            "conditions": [],
            "item_id": "item-2",
            "name": "Canh chua",
            "permitted_substitutions": ["Canh rau"],
            "price_wei": "20",
            "quantity": 1,
        },
    ]
}
DEADLINES_DATA = {
    "acceptance_deadline": ACCEPTANCE_DEADLINE,
    "appeal_deadline": 1_786_150_200,
    "delivery_deadline": 1_786_149_000,
    "packing_deadline": 1_786_148_400,
    "review_deadline": 1_786_149_600,
}
MANIFEST = json.dumps(
    MANIFEST_DATA,
    ensure_ascii=False,
    separators=(",", ":"),
    sort_keys=True,
)
DEADLINES = json.dumps(DEADLINES_DATA, separators=(",", ":"), sort_keys=True)


def addr(address) -> str:
    if isinstance(address, bytes):
        return "0x" + address.hex()
    if hasattr(address, "as_hex"):
        return address.as_hex
    return str(address)


def _inject_message_via_pipe(vm) -> None:
    """Work around genlayer-test 0.29.2 unlinking an open stdin file on Windows.

    This copies the runner's message envelope byte-for-byte through a pipe. It
    does not alter sender/value, bypass contract validation, or manufacture
    contract storage.
    """
    from genlayer.py import calldata
    from genlayer.py.types import Address

    def as_address(value):
        return Address(value) if isinstance(value, bytes) else value

    encoded = calldata.encode(
        {
            "chain_id": vm._chain_id,
            "contract_address": as_address(vm._contract_address),
            "datetime": vm._datetime,
            "entry_data": b"",
            "entry_kind": 0,
            "entry_stage_data": None,
            "is_init": False,
            "origin_address": as_address(vm.origin),
            "sender_address": as_address(vm.sender),
            "stack": [],
            "value": vm._value,
        }
    )
    read_fd, write_fd = os.pipe()
    try:
        os.write(write_fd, encoded)
    finally:
        os.close(write_fd)
    vm._original_stdin_fd = os.dup(0)
    try:
        os.dup2(read_fd, 0)
    finally:
        os.close(read_fd)


@pytest.fixture
def vm(direct_vm):
    direct_vm.warp(BASE_TIME)
    direct_vm.value = 0
    return direct_vm


@pytest.fixture
def actors():
    return [hashlib.sha256(f"foodguard-actor-{index}".encode()).digest()[:20] for index in range(5)]


@pytest.fixture
def deployer(actors):
    return actors[0]


@pytest.fixture
def customer(actors):
    return actors[1]


@pytest.fixture
def restaurant(actors):
    return actors[2]


@pytest.fixture
def courier(actors):
    return actors[3]


@pytest.fixture
def outsider(actors):
    return actors[4]


@pytest.fixture
def emitted_messages(vm):
    """Capture production PostMessage payloads missing from direct mode 0.29.2.

    genlayer-test direct mode delegates PostMessage only through this glsim hook.
    The hook preserves the decoded production payload and does not mutate contract
    state, balances, sender, value, or validation outcomes.
    """
    messages = []

    def capture_post_message(_vm, request):
        if "PostMessage" not in request:
            return None
        messages.append(request["PostMessage"])
        return {"ok": None}

    vm._gl_call_hook = capture_post_message
    return messages


@pytest.fixture
def food_guard(vm, direct_deploy, deployer, monkeypatch):
    # genlayer-test 0.29.2 can import the empty PyPI `genlayer` shim before it
    # prepends the cached GenVM SDK. Evict only those modules so direct_deploy
    # loads the pinned SDK declared by the contract header.
    for module_name in list(sys.modules):
        if module_name == "genlayer" or module_name.startswith("genlayer."):
            sys.modules.pop(module_name, None)
    from gltest.direct import loader

    monkeypatch.setattr(loader, "_inject_message_to_fd0", _inject_message_via_pipe)
    vm.sender = deployer
    return direct_deploy("contracts/food_guard.py")


@pytest.fixture
def created_order(food_guard, vm, customer, restaurant, courier):
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
    # Compatibility self-check: successful exact-value validation proves the
    # pipe delivered vm.value=130; the stored customer proves sender identity.
    order = food_guard.get_order("fg-1")
    assert int(order.total_value) == 130
    assert addr(order.customer).lower() == addr(customer).lower()
    # Direct mode validates payable value but does not credit the contract
    # balance. Mirror that executor-side custody effect so solvency checks are
    # exercised; individual insolvency tests can then override it with deal().
    vm.deal(vm._contract_address, 130)
    vm.value = 0
    return food_guard
