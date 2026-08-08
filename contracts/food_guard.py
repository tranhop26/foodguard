# v0.2.16
# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }
from dataclasses import dataclass
import datetime
import json

from genlayer import *


@allow_storage
@dataclass
class Order:
    order_id: str
    customer: Address
    restaurant: Address
    courier: Address
    manifest_json: str
    subtotal: u256
    delivery_fee: u256
    total_value: u256
    acceptance_deadline: u64
    packing_deadline: u64
    delivery_deadline: u64
    review_deadline: u64
    appeal_deadline: u64
    state: str
    restaurant_accepted: bool
    courier_accepted: bool
    refund_emitted: bool


@dataclass
class Accounting:
    total_inflows: u256
    reserved_items: u256
    reserved_delivery: u256
    restaurant_payouts_emitted: u256
    courier_payouts_emitted: u256
    customer_refunds_emitted: u256


class FoodGuard(gl.Contract):
    orders: TreeMap[str, Order]
    item_json_by_key: TreeMap[str, str]
    deployer: Address
    creation_paused: bool
    total_inflows: u256
    reserved_items: u256
    reserved_delivery: u256
    restaurant_payouts_emitted: u256
    courier_payouts_emitted: u256
    customer_refunds_emitted: u256

    def __init__(self):
        self.deployer = gl.message.sender_address
        self.creation_paused = False
        self.total_inflows = u256(0)
        self.reserved_items = u256(0)
        self.reserved_delivery = u256(0)
        self.restaurant_payouts_emitted = u256(0)
        self.courier_payouts_emitted = u256(0)
        self.customer_refunds_emitted = u256(0)

    def _canonical_json(self, value) -> str:
        return json.dumps(
            value,
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        )

    def _item_key(self, order_id: str, item_id: str) -> str:
        return self._canonical_json([order_id, item_id])

    def _now(self) -> int:
        try:
            parsed = datetime.datetime.now(datetime.timezone.utc)
            if parsed.tzinfo is None:
                raise ValueError("timezone required")
            return int(parsed.timestamp())
        except Exception:
            raise gl.vm.UserError("[EXPECTED] transaction datetime required")

    def _parse_manifest(self, manifest_json: str):
        try:
            manifest = json.loads(manifest_json)
        except Exception:
            raise gl.vm.UserError("[EXPECTED] invalid manifest")
        if manifest_json != self._canonical_json(manifest):
            raise gl.vm.UserError("[EXPECTED] canonical manifest JSON required")
        if type(manifest) is not dict or set(manifest.keys()) != {"items"}:
            raise gl.vm.UserError("[EXPECTED] invalid manifest")
        items = manifest["items"]
        if type(items) is not list or not items or len(items) > 100:
            raise gl.vm.UserError("[EXPECTED] invalid manifest")

        required_fields = {
            "conditions",
            "item_id",
            "name",
            "permitted_substitutions",
            "price_wei",
            "quantity",
        }
        seen_item_ids = set()
        subtotal = 0
        for item in items:
            if type(item) is not dict or set(item.keys()) != required_fields:
                raise gl.vm.UserError("[EXPECTED] invalid manifest")
            item_id = item["item_id"]
            name = item["name"]
            quantity = item["quantity"]
            price_wei = item["price_wei"]
            substitutions = item["permitted_substitutions"]
            conditions = item["conditions"]
            if (
                type(item_id) is not str
                or not item_id.strip()
                or len(item_id.encode("utf-8")) > 128
                or item_id in seen_item_ids
                or type(name) is not str
                or not name.strip()
                or len(name.encode("utf-8")) > 256
                or type(quantity) is not int
                or quantity <= 0
                or type(price_wei) is not str
                or not price_wei
                or any(character < "0" or character > "9" for character in price_wei)
                or price_wei.startswith("0")
                or len(price_wei) > 78
                or type(substitutions) is not list
                or type(conditions) is not list
                or len(substitutions) > 20
                or len(conditions) > 20
                or any(type(value) is not str or not value.strip() for value in substitutions)
                or any(type(value) is not str or not value.strip() for value in conditions)
            ):
                raise gl.vm.UserError("[EXPECTED] invalid manifest")
            seen_item_ids.add(item_id)
            subtotal += int(price_wei) * quantity
            try:
                u256(subtotal)
            except Exception:
                raise gl.vm.UserError("[EXPECTED] invalid manifest")
        return manifest, subtotal

    def _parse_deadlines(self, deadlines_json: str):
        try:
            deadlines = json.loads(deadlines_json)
        except Exception:
            raise gl.vm.UserError("[EXPECTED] valid canonical deadlines required")
        expected_fields = {
            "acceptance_deadline",
            "packing_deadline",
            "delivery_deadline",
            "review_deadline",
            "appeal_deadline",
        }
        values = []
        if (
            deadlines_json != self._canonical_json(deadlines)
            or type(deadlines) is not dict
            or set(deadlines.keys()) != expected_fields
        ):
            raise gl.vm.UserError("[EXPECTED] valid canonical deadlines required")
        for field_name in (
            "acceptance_deadline",
            "packing_deadline",
            "delivery_deadline",
            "review_deadline",
            "appeal_deadline",
        ):
            value = deadlines[field_name]
            if type(value) is not int or value <= self._now():
                raise gl.vm.UserError("[EXPECTED] valid canonical deadlines required")
            values.append(value)
        if values != sorted(set(values)):
            raise gl.vm.UserError("[EXPECTED] valid canonical deadlines required")
        return deadlines

    def _assert_conservation(self) -> None:
        accounted = (
            int(self.reserved_items)
            + int(self.reserved_delivery)
            + int(self.restaurant_payouts_emitted)
            + int(self.courier_payouts_emitted)
            + int(self.customer_refunds_emitted)
        )
        if int(self.total_inflows) != accounted:
            raise gl.vm.UserError("[EXPECTED] accounting conservation violated")

    @gl.public.write.payable
    def create_order(
        self,
        order_id: str,
        restaurant: str,
        courier: str,
        manifest_json: str,
        delivery_fee: u256,
        deadlines_json: str,
    ) -> None:
        if self.creation_paused:
            raise gl.vm.UserError("[EXPECTED] order creation is paused")
        if not order_id.strip() or len(order_id.encode("utf-8")) > 128:
            raise gl.vm.UserError("[EXPECTED] invalid order id")
        if order_id in self.orders:
            raise gl.vm.UserError("[EXPECTED] order already exists")
        manifest, subtotal = self._parse_manifest(manifest_json)
        deadlines = self._parse_deadlines(deadlines_json)
        total_value = subtotal + int(delivery_fee)
        if gl.message.value != u256(total_value):
            raise gl.vm.UserError("[EXPECTED] exact order value required")
        customer_address = gl.message.sender_address
        restaurant_address = Address(restaurant)
        courier_address = Address(courier)
        zero_address = Address(bytes(20))
        if (
            customer_address == zero_address
            or restaurant_address == zero_address
            or courier_address == zero_address
        ):
            raise gl.vm.UserError("[EXPECTED] three nonzero wallets required")
        if (
            customer_address == restaurant_address
            or customer_address == courier_address
            or restaurant_address == courier_address
        ):
            raise gl.vm.UserError("[EXPECTED] three distinct wallets required")

        self.orders[order_id] = Order(
            order_id=order_id,
            customer=customer_address,
            restaurant=restaurant_address,
            courier=courier_address,
            manifest_json=manifest_json,
            subtotal=u256(subtotal),
            delivery_fee=u256(delivery_fee),
            total_value=u256(total_value),
            acceptance_deadline=u64(deadlines["acceptance_deadline"]),
            packing_deadline=u64(deadlines["packing_deadline"]),
            delivery_deadline=u64(deadlines["delivery_deadline"]),
            review_deadline=u64(deadlines["review_deadline"]),
            appeal_deadline=u64(deadlines["appeal_deadline"]),
            state="FUNDED",
            restaurant_accepted=False,
            courier_accepted=False,
            refund_emitted=False,
        )
        for item in manifest["items"]:
            self.item_json_by_key[self._item_key(order_id, item["item_id"])] = (
                self._canonical_json(item)
            )
        self.total_inflows += u256(total_value)
        self.reserved_items += u256(subtotal)
        self.reserved_delivery += u256(delivery_fee)
        self._assert_conservation()

    def _record_acceptance(self, order_id: str, restaurant_acceptance: bool) -> None:
        if order_id not in self.orders:
            raise gl.vm.UserError("[EXPECTED] order not found")
        order = self.orders[order_id]
        if order.state not in ("FUNDED", "PARTIALLY_ACCEPTED"):
            raise gl.vm.UserError("[EXPECTED] order cannot be accepted")
        expected_actor = order.restaurant if restaurant_acceptance else order.courier
        already_accepted = (
            order.restaurant_accepted
            if restaurant_acceptance
            else order.courier_accepted
        )
        if gl.message.sender_address != expected_actor:
            raise gl.vm.UserError("[EXPECTED] only assigned provider may accept")
        if already_accepted:
            raise gl.vm.UserError("[EXPECTED] provider already accepted")
        if self._now() >= int(order.acceptance_deadline):
            raise gl.vm.UserError("[EXPECTED] acceptance deadline passed")
        if restaurant_acceptance:
            order.restaurant_accepted = True
        else:
            order.courier_accepted = True
        order.state = (
            "ACCEPTED"
            if order.restaurant_accepted and order.courier_accepted
            else "PARTIALLY_ACCEPTED"
        )
        self.orders[order_id] = order

    @gl.public.write
    def accept_restaurant(self, order_id: str) -> None:
        self._record_acceptance(order_id, True)

    @gl.public.write
    def accept_courier(self, order_id: str) -> None:
        self._record_acceptance(order_id, False)

    @gl.public.write
    def set_creation_paused(self, paused: bool) -> None:
        if gl.message.sender_address != self.deployer:
            raise gl.vm.UserError("[EXPECTED] only deployer may pause creation")
        self.creation_paused = paused

    @gl.public.write
    def cancel_unaccepted(self, order_id: str) -> None:
        if order_id not in self.orders:
            raise gl.vm.UserError("[EXPECTED] order not found")
        order = self.orders[order_id]
        if order.state == "CANCELLED_REFUNDED":
            return
        if order.state not in ("FUNDED", "PARTIALLY_ACCEPTED"):
            raise gl.vm.UserError("[EXPECTED] order cannot be cancelled")

        before_deadline = self._now() < int(order.acceptance_deadline)
        if before_deadline:
            if (
                gl.message.sender_address != order.customer
                or order.restaurant_accepted
                or order.courier_accepted
            ):
                raise gl.vm.UserError("[EXPECTED] order cannot be cancelled")
        elif order.restaurant_accepted and order.courier_accepted:
            raise gl.vm.UserError("[EXPECTED] order cannot be cancelled")

        if (
            order.refund_emitted
            or self.reserved_items < order.subtotal
            or self.reserved_delivery < order.delivery_fee
        ):
            raise gl.vm.UserError("[EXPECTED] accounting conservation violated")

        self.reserved_items -= order.subtotal
        self.reserved_delivery -= order.delivery_fee
        self.customer_refunds_emitted += order.total_value
        order.state = "CANCELLED_REFUNDED"
        order.restaurant_accepted = False
        order.courier_accepted = False
        order.refund_emitted = True
        self.orders[order_id] = order
        self._assert_conservation()
        gl.get_contract_at(order.customer).emit_transfer(
            value=order.total_value,
            on="finalized",
        )

    @gl.public.view
    def get_order(self, order_id: str) -> Order:
        return self.orders[order_id]

    @gl.public.view
    def get_item(self, order_id: str, item_id: str) -> str:
        return self.item_json_by_key[self._item_key(order_id, item_id)]

    @gl.public.view
    def get_accounting(self) -> Accounting:
        return Accounting(
            total_inflows=self.total_inflows,
            reserved_items=self.reserved_items,
            reserved_delivery=self.reserved_delivery,
            restaurant_payouts_emitted=self.restaurant_payouts_emitted,
            courier_payouts_emitted=self.courier_payouts_emitted,
            customer_refunds_emitted=self.customer_refunds_emitted,
        )
