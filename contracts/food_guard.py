# v0.2.16
# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }
from dataclasses import dataclass
import datetime
import hashlib
import json

from genlayer import *


ITEM_OUTCOMES = (
    "MATCHED",
    "MISSING",
    "MISMATCHED",
    "DELIVERY_FAILED",
    "UNRESOLVED",
)
DELIVERY_OUTCOMES = ("DELIVERED", "DELIVERY_FAILED", "UNRESOLVED")
EVIDENCE_ACTION_CODES = {
    "PACKED": 1,
    "PICKED_UP": 2,
    "DELIVERED": 3,
    "CUSTOMER_CLAIM": 4,
    "CURE": 5,
    "APPEAL": 6,
}
PACKED_ITEM_OBSERVATION_CODES = {
    "PACKED_AS_ORDERED": 1,
    "NOT_PACKED": 2,
    "PACKED_DIFFERENT": 3,
}
DELIVERY_OBSERVATION_CODES = {
    "HANDOFF_CONFIRMED": 1,
    "HANDOFF_FAILED": 2,
}
CLAIM_CATEGORY_CODES = {
    "ABSENT_AT_RECEIPT": 1,
    "NOT_AS_ORDERED": 2,
    "HANDOFF_NOT_RECEIVED": 3,
}


class _DuplicateJsonKey(Exception):
    pass


class _EvidenceResolutionFailure(Exception):
    pass


def _canonical_json_value(value) -> str:
    return json.dumps(
        value,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    )


def _load_json_without_duplicate_keys(value: str):
    def build_object(pairs):
        result = {}
        for key, item in pairs:
            if key in result:
                raise _DuplicateJsonKey("duplicate JSON key")
            result[key] = item
        return result

    return json.loads(value, object_pairs_hook=build_object)


def _assert_resolution_json_value(value) -> None:
    if value is None or type(value) in (bool, int, str):
        return
    if type(value) is list:
        for item in value:
            _assert_resolution_json_value(item)
        return
    if type(value) is dict:
        for item in value.values():
            _assert_resolution_json_value(item)
        return
    raise _EvidenceResolutionFailure("unsupported public evidence JSON value")


def _parse_resolution_timestamp(value: str) -> int:
    if type(value) is not str or not value.endswith("Z"):
        raise ValueError("invalid timestamp")
    parsed = datetime.datetime.fromisoformat(value[:-1] + "+00:00")
    if parsed.tzinfo != datetime.timezone.utc:
        raise ValueError("invalid timestamp")
    epoch = datetime.datetime(1970, 1, 1, tzinfo=datetime.timezone.utc)
    delta = parsed - epoch
    return (
        delta.days * 86_400_000_000
        + delta.seconds * 1_000_000
        + delta.microseconds
    )


def _unresolved_resolution(item_ids, reason: str):
    return {
        "items": [
            {
                "item_id": item_id,
                "outcome": "UNRESOLVED",
                "facts": [reason],
            }
            for item_id in item_ids
        ],
        "delivery_outcome": "UNRESOLVED",
        "evidence_hashes": [],
    }


def _resolution_stable_fields(value, item_ids):
    if type(value) is not dict or set(value.keys()) != {
        "delivery_outcome",
        "evidence_hashes",
        "items",
    }:
        return None
    items = value["items"]
    hashes = value["evidence_hashes"]
    if (
        type(items) is not list
        or len(items) != len(item_ids)
        or type(hashes) is not list
        or len(hashes) > 107
        or type(value["delivery_outcome"]) is not str
        or value["delivery_outcome"] not in DELIVERY_OUTCOMES
    ):
        return None
    for digest in hashes:
        if (
            type(digest) is not str
            or len(digest) != 66
            or not digest.startswith("0x")
            or any(character not in "0123456789abcdef" for character in digest[2:])
        ):
            return None

    stable_items = []
    for expected_id, item in zip(item_ids, items):
        if type(item) is not dict or set(item.keys()) != {
            "facts",
            "item_id",
            "outcome",
        }:
            return None
        facts = item["facts"]
        if (
            type(item["item_id"]) is not str
            or item["item_id"] != expected_id
            or type(item["outcome"]) is not str
            or item["outcome"] not in ITEM_OUTCOMES
            or type(facts) is not list
            or len(facts) > 8
            or any(
                type(fact) is not str
                or len(fact.encode("utf-8")) > 512
                for fact in facts
            )
        ):
            return None
        stable_items.append([item["item_id"], item["outcome"]])
    return _canonical_json_value(
        {
            "delivery_outcome": value["delivery_outcome"],
            "evidence_hashes": hashes,
            "items": stable_items,
        }
    )


def _normalize_model_resolution(value, item_ids, verified_hashes):
    if not _valid_model_resolution(value, len(item_ids)):
        raise RuntimeError("invalid model resolution")
    return {
        "items": [
            {
                "item_id": item_ids[item["item_index"]],
                "outcome": item["outcome"],
                "facts": item["facts"],
            }
            for item in value["items"]
        ],
        "delivery_outcome": value["delivery_outcome"],
        "evidence_hashes": verified_hashes,
    }


def _valid_model_resolution(value, item_count: int) -> bool:
    if type(value) is not dict or set(value.keys()) != {
        "delivery_outcome",
        "items",
    }:
        return False
    items = value["items"]
    if (
        type(items) is not list
        or len(items) != item_count
        or type(value["delivery_outcome"]) is not str
        or value["delivery_outcome"] not in DELIVERY_OUTCOMES
    ):
        return False
    for expected_index, item in enumerate(items):
        if type(item) is not dict or set(item.keys()) != {
            "facts",
            "item_index",
            "outcome",
        }:
            return False
        facts = item["facts"]
        if (
            type(item["item_index"]) is not int
            or item["item_index"] != expected_index
            or type(item["outcome"]) is not str
            or item["outcome"] not in ITEM_OUTCOMES
            or type(facts) is not list
            or len(facts) > 8
            or any(
                type(fact) is not str
                or len(fact.encode("utf-8")) > 512
                for fact in facts
            )
        ):
            return False
    return True


def _derive_resolution(manifest_json, item_ids, evidence_inputs, resolution_time):
    invalid_reason = "Public evidence was unavailable, invalid, or insufficient."
    verified_hashes = []
    evidence_events = []
    actions = set()
    manifest = _load_json_without_duplicate_keys(manifest_json)
    if (
        type(manifest) is not dict
        or type(manifest.get("items")) is not list
        or len(manifest["items"]) != len(item_ids)
    ):
        raise RuntimeError("invalid stored manifest shape")
    typed_manifest = []
    item_index_by_id = {}
    for item_index, item in enumerate(manifest["items"]):
        if (
            type(item) is not dict
            or item.get("item_id") != item_ids[item_index]
            or type(item.get("quantity")) is not int
        ):
            raise RuntimeError("invalid stored manifest item")
        item_index_by_id[item_ids[item_index]] = item_index
        typed_manifest.append(
            {
                "item_index": item_index,
                "quantity": item["quantity"],
            }
        )

    try:
        if not evidence_inputs:
            raise _EvidenceResolutionFailure("missing evidence")
        for record in evidence_inputs:
            source_url = record["source_url"]
            if (
                type(source_url) is not str
                or not source_url.startswith("https://")
                or len(source_url.encode("utf-8")) > 2048
            ):
                raise _EvidenceResolutionFailure("invalid evidence URL")

            response = gl.nondet.web.get(source_url)
            if response.status != 200 or response.body is None:
                raise _EvidenceResolutionFailure("evidence unavailable")
            try:
                body = response.body.decode("utf-8")
            except UnicodeDecodeError:
                raise _EvidenceResolutionFailure("invalid evidence encoding")
            if not body or len(body.encode("utf-8")) > 65_536:
                raise _EvidenceResolutionFailure("invalid evidence size")
            try:
                document = _load_json_without_duplicate_keys(body)
            except (json.JSONDecodeError, _DuplicateJsonKey):
                raise _EvidenceResolutionFailure("malformed evidence JSON")
            _assert_resolution_json_value(document)
            if type(document) is not dict:
                raise _EvidenceResolutionFailure("malformed evidence document")
            canonical_document = _canonical_json_value(document)

            expected_document = _load_json_without_duplicate_keys(
                record["envelope_json"]
            )
            expected_digest = expected_document.pop("sha256")
            if (
                canonical_document != _canonical_json_value(expected_document)
                or expected_digest.lower() != record["sha256"]
                or "0x"
                + hashlib.sha256(canonical_document.encode("utf-8")).hexdigest()
                != record["sha256"]
            ):
                raise _EvidenceResolutionFailure("evidence digest mismatch")

            observed_at = _parse_resolution_timestamp(document["observed_at"])
            submitted_at = _parse_resolution_timestamp(document["submitted_at"])
            expires_at = _parse_resolution_timestamp(document["expires_at"])
            if not (
                observed_at <= submitted_at <= resolution_time <= expires_at
            ):
                raise _EvidenceResolutionFailure("stale evidence")

            action = record["action"]
            if action not in EVIDENCE_ACTION_CODES:
                raise RuntimeError("invalid stored evidence action")
            if document.get("action") != action:
                raise RuntimeError("stored evidence action mismatch")
            item_id = record["item_id"]
            if document.get("item_id", "") != item_id:
                raise RuntimeError("stored evidence item mismatch")
            if item_id:
                if item_id not in item_index_by_id:
                    raise RuntimeError("invalid stored evidence item")
                item_index = item_index_by_id[item_id]
            else:
                item_index = -1

            claim_code = 0
            delivery_code = 0
            item_observations = []
            if action == "PACKED":
                observations = document.get("item_observations")
                if type(observations) is not list or len(observations) != len(item_ids):
                    raise _EvidenceResolutionFailure(
                        "missing packed item observations"
                    )
                for expected_index, observation in enumerate(observations):
                    if (
                        type(observation) is not dict
                        or set(observation.keys()) != {"item_id", "observation"}
                        or observation["item_id"] != item_ids[expected_index]
                        or type(observation["observation"]) is not str
                        or observation["observation"]
                        not in PACKED_ITEM_OBSERVATION_CODES
                    ):
                        raise _EvidenceResolutionFailure(
                            "invalid packed item observations"
                        )
                    item_observations.append(
                        [
                            expected_index,
                            PACKED_ITEM_OBSERVATION_CODES[
                                observation["observation"]
                            ],
                        ]
                    )
            elif action == "DELIVERED":
                delivery_observation = document.get("delivery_observation")
                if (
                    type(delivery_observation) is not str
                    or delivery_observation not in DELIVERY_OBSERVATION_CODES
                ):
                    raise _EvidenceResolutionFailure(
                        "invalid delivery observation"
                    )
                delivery_code = DELIVERY_OBSERVATION_CODES[
                    delivery_observation
                ]
            elif action == "CUSTOMER_CLAIM":
                claim_category = document.get("claim_category")
                if (
                    type(claim_category) is not str
                    or claim_category not in CLAIM_CATEGORY_CODES
                ):
                    raise _EvidenceResolutionFailure("invalid claim category")
                claim_code = CLAIM_CATEGORY_CODES[claim_category]
            actions.add(action)
            evidence_events.append(
                {
                    "action_code": EVIDENCE_ACTION_CODES[action],
                    "claim_code": claim_code,
                    "delivery_code": delivery_code,
                    "item_index": item_index,
                    "item_observations": item_observations,
                    "observed_at_us": observed_at,
                }
            )
            verified_hashes.append(record["sha256"])
        if not {"PACKED", "PICKED_UP", "DELIVERED"}.issubset(actions):
            raise _EvidenceResolutionFailure("insufficient evidence actions")
    except _EvidenceResolutionFailure:
        return _unresolved_resolution(item_ids, invalid_reason)

    prompt = (
        "FOODGUARD_RESOLUTION_V1\n"
        "Resolve one delivery using only the contract-generated typed payload below. "
        "The payload contains no participant prose. action_code meanings are "
        "1=PACKED, 2=PICKED_UP, 3=DELIVERED, 4=CUSTOMER_CLAIM, "
        "5=CURE, 6=APPEAL. "
        "Packed item observation codes mean 1=affirmed as ordered, "
        "2=reported absent while packing, 3=reported different while packing. "
        "Delivery observation codes mean 1=handoff affirmed, 2=handoff failed. "
        "Claim codes mean 1=item absent at receipt, 2=item not as ordered, "
        "3=delivery not received.\n"
        "Return JSON only with exactly these keys: items, delivery_outcome. Return "
        "every manifest item exactly once and in item_index order. Each item has "
        "exactly item_index, outcome, facts. Allowed item outcomes: "
        "MATCHED, MISSING, MISMATCHED, DELIVERY_FAILED, UNRESOLVED. Allowed delivery "
        "outcomes: DELIVERED, DELIVERY_FAILED, UNRESOLVED. Use UNRESOLVED when the "
        "typed events are contradictory or insufficient. facts are bounded output "
        "explanations and do not control settlement.\n"
        "TYPED_DECISION_PAYLOAD_JSON="
        + _canonical_json_value(
            {
                "evidence_events": evidence_events,
                "manifest_items": typed_manifest,
            }
        )
    )
    model_result = gl.nondet.exec_prompt(prompt, response_format="json")
    return _normalize_model_resolution(model_result, item_ids, verified_hashes)


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


@allow_storage
@dataclass
class Evidence:
    schema_version: str
    order_id: str
    item_id: str
    subject: str
    action: str
    actor_wallet: str
    issuer_id: str
    source_url: str
    sha256: str
    observed_at: str
    submitted_at: str
    expires_at: str
    chain_id: str
    contract_address: str
    nonce: str
    envelope_json: str


@allow_storage
@dataclass
class SettlementProposal:
    proposal_json: str
    digest: str
    proposal_nonce: str
    customer_wei: u256
    restaurant_wei: u256
    courier_wei: u256
    customer_signed: bool
    restaurant_signed: bool
    courier_signed: bool


class FoodGuard(gl.Contract):
    orders: TreeMap[str, Order]
    item_json_by_key: TreeMap[str, str]
    evidence_by_key: TreeMap[str, Evidence]
    evidence_count_by_order: TreeMap[str, u256]
    used_evidence_replay_keys: TreeMap[str, bool]
    submitted_claim_keys: TreeMap[str, bool]
    resolution_json_by_order: TreeMap[str, str]
    resolution_json_by_round: TreeMap[str, str]
    resolution_round_by_order: TreeMap[str, u256]
    unresolved_count_by_order: TreeMap[str, u256]
    submitted_cure_keys: TreeMap[str, bool]
    appeal_used_keys: TreeMap[str, bool]
    settlement_proposal_by_order: TreeMap[str, SettlementProposal]
    used_settlement_nonce_keys: TreeMap[str, bool]
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
        return _canonical_json_value(value)

    def _item_key(self, order_id: str, item_id: str) -> str:
        return self._canonical_json([order_id, item_id])

    def _evidence_key(self, order_id: str, evidence_index: int) -> str:
        return self._canonical_json([order_id, evidence_index])

    def _resolution_key(self, order_id: str, resolution_round: int) -> str:
        return self._canonical_json([order_id, resolution_round])

    def _address_hex(self, address: Address) -> str:
        return address.as_hex.lower()

    def _participant_role(self, order: Order, actor: Address) -> str:
        if actor == order.customer:
            return "customer"
        if actor == order.restaurant:
            return "restaurant"
        if actor == order.courier:
            return "courier"
        return ""

    def _parse_allocation_wei(self, value) -> int:
        if (
            type(value) is not str
            or not value
            or len(value) > 78
            or any(character < "0" or character > "9" for character in value)
            or (len(value) > 1 and value.startswith("0"))
        ):
            raise gl.vm.UserError("[EXPECTED] invalid settlement proposal")
        try:
            parsed = int(value)
            u256(parsed)
            return parsed
        except Exception:
            raise gl.vm.UserError("[EXPECTED] invalid settlement proposal")

    def _parse_mutual_allocation(self, order_id: str, allocation_json: str):
        try:
            allocation = json.loads(allocation_json)
        except Exception:
            raise gl.vm.UserError("[EXPECTED] invalid settlement proposal")
        if (
            type(allocation) is not dict
            or set(allocation.keys()) != {
                "delivery_allocation",
                "item_allocations",
                "proposal_nonce",
            }
            or allocation_json != self._canonical_json(allocation)
        ):
            raise gl.vm.UserError("[EXPECTED] invalid settlement proposal")

        proposal_nonce = allocation["proposal_nonce"]
        if (
            type(proposal_nonce) is not str
            or not proposal_nonce.strip()
            or len(proposal_nonce.encode("utf-8")) > 128
        ):
            raise gl.vm.UserError("[EXPECTED] invalid settlement proposal")

        order = self.orders[order_id]
        manifest = json.loads(order.manifest_json)
        item_allocations = allocation["item_allocations"]
        delivery_allocation = allocation["delivery_allocation"]
        if type(item_allocations) is not list or len(item_allocations) != len(
            manifest["items"]
        ):
            raise gl.vm.UserError(
                "[EXPECTED] settlement proposal recipients required"
            )
        if (
            type(delivery_allocation) is not dict
            or set(delivery_allocation.keys())
            != {"courier_wei", "customer_wei"}
        ):
            raise gl.vm.UserError(
                "[EXPECTED] settlement proposal recipients required"
            )

        restaurant_total = 0
        customer_total = 0
        for manifest_item, proposed_item in zip(
            manifest["items"], item_allocations
        ):
            if (
                type(proposed_item) is not dict
                or set(proposed_item.keys())
                != {"customer_wei", "item_id", "restaurant_wei"}
                or proposed_item["item_id"] != manifest_item["item_id"]
            ):
                raise gl.vm.UserError(
                    "[EXPECTED] settlement proposal recipients required"
                )
            customer_amount = self._parse_allocation_wei(
                proposed_item["customer_wei"]
            )
            restaurant_amount = self._parse_allocation_wei(
                proposed_item["restaurant_wei"]
            )
            item_value = int(manifest_item["price_wei"]) * manifest_item["quantity"]
            if customer_amount + restaurant_amount != item_value:
                raise gl.vm.UserError(
                    "[EXPECTED] allocation must conserve order value"
                )
            customer_total += customer_amount
            restaurant_total += restaurant_amount

        delivery_customer = self._parse_allocation_wei(
            delivery_allocation["customer_wei"]
        )
        courier_total = self._parse_allocation_wei(
            delivery_allocation["courier_wei"]
        )
        if delivery_customer + courier_total != int(order.delivery_fee):
            raise gl.vm.UserError(
                "[EXPECTED] allocation must conserve order value"
            )
        customer_total += delivery_customer
        if customer_total + restaurant_total + courier_total != int(
            order.total_value
        ):
            raise gl.vm.UserError(
                "[EXPECTED] allocation must conserve order value"
            )

        bound_proposal = dict(allocation)
        bound_proposal["chain_id"] = str(int(gl.message.chain_id))
        bound_proposal["contract_address"] = self._address_hex(
            gl.message.contract_address
        )
        bound_proposal["order_id"] = order_id
        proposal_json = self._canonical_json(bound_proposal)
        digest = "0x" + hashlib.sha256(
            proposal_json.encode("utf-8")
        ).hexdigest()
        return (
            proposal_nonce,
            proposal_json,
            digest,
            customer_total,
            restaurant_total,
            courier_total,
        )

    def _now(self) -> int:
        try:
            parsed = datetime.datetime.now(datetime.timezone.utc)
            if parsed.tzinfo is None:
                raise ValueError("timezone required")
            return int(parsed.timestamp())
        except Exception:
            raise gl.vm.UserError("[EXPECTED] transaction datetime required")

    def _parse_evidence_timestamp(self, value: str) -> int:
        if type(value) is not str or not value.endswith("Z"):
            raise gl.vm.UserError("[EXPECTED] invalid evidence timestamps")
        try:
            parsed = datetime.datetime.fromisoformat(value[:-1] + "+00:00")
        except Exception:
            raise gl.vm.UserError("[EXPECTED] invalid evidence timestamps")
        if parsed.tzinfo != datetime.timezone.utc:
            raise gl.vm.UserError("[EXPECTED] invalid evidence timestamps")
        epoch = datetime.datetime(1970, 1, 1, tzinfo=datetime.timezone.utc)
        delta = parsed - epoch
        return (
            delta.days * 86_400_000_000
            + delta.seconds * 1_000_000
            + delta.microseconds
        )

    def _assert_evidence_json_value(self, value) -> None:
        if value is None or type(value) in (bool, int, str):
            return
        if type(value) is list:
            for item in value:
                self._assert_evidence_json_value(item)
            return
        if type(value) is dict:
            for item in value.values():
                self._assert_evidence_json_value(item)
            return
        raise gl.vm.UserError("[EXPECTED] invalid evidence")

    def _append_evidence(
        self,
        order_id: str,
        expected_action: str,
        envelope_json: str,
        expected_actor: Address,
    ) -> Evidence:
        try:
            envelope = json.loads(envelope_json)
        except Exception:
            raise gl.vm.UserError("[EXPECTED] invalid evidence")
        if type(envelope) is not dict:
            raise gl.vm.UserError("[EXPECTED] invalid evidence")
        self._assert_evidence_json_value(envelope)
        if envelope_json != self._canonical_json(envelope):
            raise gl.vm.UserError("[EXPECTED] canonical evidence JSON required")

        required_fields = {
            "action",
            "actor_wallet",
            "chain_id",
            "contract_address",
            "expires_at",
            "issuer_id",
            "nonce",
            "observed_at",
            "order_id",
            "schema_version",
            "sha256",
            "source_url",
            "subject",
            "submitted_at",
        }
        if not required_fields.issubset(envelope.keys()) or any(
            type(envelope[field_name]) is not str
            or not envelope[field_name].strip()
            for field_name in required_fields
        ):
            raise gl.vm.UserError("[EXPECTED] invalid evidence")
        if envelope["schema_version"] != "foodguard-evidence/1":
            raise gl.vm.UserError("[EXPECTED] invalid evidence")
        if envelope["order_id"] != order_id:
            raise gl.vm.UserError("[EXPECTED] evidence order mismatch")
        if envelope["action"] != expected_action:
            raise gl.vm.UserError("[EXPECTED] evidence action mismatch")

        item_id = envelope.get("item_id", "")
        if type(item_id) is not str or ("item_id" in envelope and not item_id):
            raise gl.vm.UserError("[EXPECTED] invalid evidence")
        if expected_action == "CUSTOMER_CLAIM" and not item_id:
            raise gl.vm.UserError("[EXPECTED] evidence item required")
        if item_id and self._item_key(order_id, item_id) not in self.item_json_by_key:
            raise gl.vm.UserError("[EXPECTED] evidence item not found")
        expected_subject = (
            "order:" + order_id + "/item:" + item_id
            if item_id
            else "order:" + order_id
        )
        if envelope["subject"] != expected_subject:
            raise gl.vm.UserError("[EXPECTED] evidence subject mismatch")

        try:
            envelope_actor = Address(envelope["actor_wallet"])
            envelope_contract = Address(envelope["contract_address"])
        except Exception:
            raise gl.vm.UserError("[EXPECTED] invalid evidence")
        if envelope_actor != expected_actor:
            raise gl.vm.UserError("[EXPECTED] evidence actor mismatch")
        if (
            envelope["chain_id"] != str(int(gl.message.chain_id))
            or envelope_contract != gl.message.contract_address
        ):
            raise gl.vm.UserError(
                "[EXPECTED] evidence transaction binding mismatch"
            )

        observed_at = self._parse_evidence_timestamp(envelope["observed_at"])
        submitted_at = self._parse_evidence_timestamp(envelope["submitted_at"])
        expires_at = self._parse_evidence_timestamp(envelope["expires_at"])
        if observed_at > submitted_at or submitted_at > expires_at:
            raise gl.vm.UserError("[EXPECTED] invalid evidence timestamps")
        transaction_time = self._now() * 1_000_000
        if expires_at < transaction_time:
            raise gl.vm.UserError("[EXPECTED] stale evidence")
        if submitted_at > transaction_time:
            raise gl.vm.UserError("[EXPECTED] future evidence")

        digest = envelope["sha256"]
        if (
            len(digest) != 66
            or digest[:2].lower() != "0x"
            or any(character not in "0123456789abcdefABCDEF" for character in digest[2:])
        ):
            raise gl.vm.UserError("[EXPECTED] invalid evidence")
        digest_preimage = dict(envelope)
        digest_preimage.pop("sha256")
        calculated_digest = "0x" + hashlib.sha256(
            self._canonical_json(digest_preimage).encode("utf-8")
        ).hexdigest()
        if digest.lower() != calculated_digest:
            raise gl.vm.UserError("[EXPECTED] evidence digest mismatch")

        canonical_chain_id = str(int(gl.message.chain_id))
        canonical_contract = self._address_hex(gl.message.contract_address)
        canonical_actor = self._address_hex(expected_actor)
        replay_preimage = self._canonical_json(
            [
                canonical_chain_id,
                canonical_contract,
                order_id,
                item_id,
                expected_action,
                canonical_actor,
                envelope["nonce"],
            ]
        )
        replay_key = hashlib.sha256(replay_preimage.encode("utf-8")).hexdigest()
        if replay_key in self.used_evidence_replay_keys:
            raise gl.vm.UserError("[EXPECTED] evidence replay")

        claim_key = self._item_key(order_id, item_id)
        if (
            expected_action == "CUSTOMER_CLAIM"
            and claim_key in self.submitted_claim_keys
        ):
            raise gl.vm.UserError("[EXPECTED] claim already submitted")

        evidence = Evidence(
            schema_version=envelope["schema_version"],
            order_id=envelope["order_id"],
            item_id=item_id,
            subject=envelope["subject"],
            action=envelope["action"],
            actor_wallet=envelope["actor_wallet"],
            issuer_id=envelope["issuer_id"],
            source_url=envelope["source_url"],
            sha256=envelope["sha256"],
            observed_at=envelope["observed_at"],
            submitted_at=envelope["submitted_at"],
            expires_at=envelope["expires_at"],
            chain_id=envelope["chain_id"],
            contract_address=envelope["contract_address"],
            nonce=envelope["nonce"],
            envelope_json=envelope_json,
        )
        evidence_count = (
            int(self.evidence_count_by_order[order_id])
            if order_id in self.evidence_count_by_order
            else 0
        )
        self.evidence_by_key[self._evidence_key(order_id, evidence_count)] = evidence
        self.evidence_count_by_order[order_id] = u256(evidence_count + 1)
        self.used_evidence_replay_keys[replay_key] = True
        if expected_action == "CUSTOMER_CLAIM":
            self.submitted_claim_keys[claim_key] = True
        return evidence

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
    def submit_packed_evidence(self, order_id: str, envelope_json: str) -> None:
        if order_id not in self.orders:
            raise gl.vm.UserError("[EXPECTED] order not found")
        order = self.orders[order_id]
        if order.state != "ACCEPTED":
            raise gl.vm.UserError("[EXPECTED] invalid evidence transition")
        if gl.message.sender_address != order.restaurant:
            raise gl.vm.UserError("[EXPECTED] restaurant wallet required")
        self._append_evidence(order_id, "PACKED", envelope_json, order.restaurant)
        order.state = "READY_FOR_PICKUP"
        self.orders[order_id] = order

    @gl.public.write
    def submit_pickup_evidence(self, order_id: str, envelope_json: str) -> None:
        if order_id not in self.orders:
            raise gl.vm.UserError("[EXPECTED] order not found")
        order = self.orders[order_id]
        if order.state != "READY_FOR_PICKUP":
            raise gl.vm.UserError("[EXPECTED] invalid evidence transition")
        if gl.message.sender_address != order.courier:
            raise gl.vm.UserError("[EXPECTED] courier wallet required")
        self._append_evidence(order_id, "PICKED_UP", envelope_json, order.courier)
        order.state = "IN_TRANSIT"
        self.orders[order_id] = order

    @gl.public.write
    def submit_delivery_evidence(self, order_id: str, envelope_json: str) -> None:
        if order_id not in self.orders:
            raise gl.vm.UserError("[EXPECTED] order not found")
        order = self.orders[order_id]
        if order.state != "IN_TRANSIT":
            raise gl.vm.UserError("[EXPECTED] invalid evidence transition")
        if gl.message.sender_address != order.courier:
            raise gl.vm.UserError("[EXPECTED] courier wallet required")
        self._append_evidence(order_id, "DELIVERED", envelope_json, order.courier)
        order.state = "REVIEW_WINDOW"
        self.orders[order_id] = order

    @gl.public.write
    def submit_claim_evidence(self, order_id: str, envelope_json: str) -> None:
        if order_id not in self.orders:
            raise gl.vm.UserError("[EXPECTED] order not found")
        order = self.orders[order_id]
        if order.state != "REVIEW_WINDOW":
            raise gl.vm.UserError("[EXPECTED] invalid evidence transition")
        if gl.message.sender_address != order.customer:
            raise gl.vm.UserError("[EXPECTED] customer wallet required")
        if self._now() >= int(order.review_deadline):
            raise gl.vm.UserError("[EXPECTED] review deadline passed")
        self._append_evidence(
            order_id,
            "CUSTOMER_CLAIM",
            envelope_json,
            order.customer,
        )

    @gl.public.write
    def submit_cure_evidence(self, order_id: str, envelope_json: str) -> None:
        if order_id not in self.orders:
            raise gl.vm.UserError("[EXPECTED] order not found")
        order = self.orders[order_id]
        if order.state != "EVIDENCE_CURE":
            raise gl.vm.UserError("[EXPECTED] invalid cure transition")
        actor = gl.message.sender_address
        role = self._participant_role(order, actor)
        if not role:
            raise gl.vm.UserError("[EXPECTED] affected actor required")
        cure_key = self._canonical_json([order_id, role])
        if cure_key in self.submitted_cure_keys:
            raise gl.vm.UserError("[EXPECTED] cure already submitted")
        self._append_evidence(order_id, "CURE", envelope_json, actor)
        self.submitted_cure_keys[cure_key] = True

    @gl.public.write
    def appeal(self, order_id: str, envelope_json: str) -> None:
        if order_id not in self.orders:
            raise gl.vm.UserError("[EXPECTED] order not found")
        order = self.orders[order_id]
        if order.state not in ("RESOLVED", "APPEALED"):
            raise gl.vm.UserError("[EXPECTED] invalid appeal transition")
        if self._now() >= int(order.appeal_deadline):
            raise gl.vm.UserError("[EXPECTED] appeal deadline passed")
        actor = gl.message.sender_address
        role = self._participant_role(order, actor)
        if not role:
            raise gl.vm.UserError("[EXPECTED] affected actor required")
        appeal_key = self._canonical_json([order_id, role])
        if appeal_key in self.appeal_used_keys:
            raise gl.vm.UserError("[EXPECTED] appeal already used")
        self._append_evidence(order_id, "APPEAL", envelope_json, actor)
        self.appeal_used_keys[appeal_key] = True
        order.state = "APPEALED"
        self.orders[order_id] = order

    @gl.public.write
    def request_resolution(self, order_id: str) -> str:
        if order_id not in self.orders:
            raise gl.vm.UserError("[EXPECTED] order not found")
        order = self.orders[order_id]
        if order.state not in ("REVIEW_WINDOW", "EVIDENCE_CURE", "APPEALED"):
            raise gl.vm.UserError("[EXPECTED] invalid resolution transition")
        if (
            order.state == "REVIEW_WINDOW"
            and self._now() < int(order.review_deadline)
        ):
            raise gl.vm.UserError("[EXPECTED] review deadline not reached")
        if order.state == "APPEALED" and self._now() < int(order.appeal_deadline):
            raise gl.vm.UserError("[EXPECTED] appeal deadline not reached")

        manifest = json.loads(order.manifest_json)
        item_ids = [item["item_id"] for item in manifest["items"]]
        evidence_count = (
            int(self.evidence_count_by_order[order_id])
            if order_id in self.evidence_count_by_order
            else 0
        )
        evidence_inputs = []
        for evidence_index in range(evidence_count):
            evidence = self.evidence_by_key[
                self._evidence_key(order_id, evidence_index)
            ]
            evidence_inputs.append(
                {
                    "action": evidence.action,
                    "envelope_json": evidence.envelope_json,
                    "issuer_id": evidence.issuer_id,
                    "item_id": evidence.item_id,
                    "observed_at": evidence.observed_at,
                    "sha256": evidence.sha256.lower(),
                    "source_url": evidence.source_url,
                    "subject": evidence.subject,
                }
            )
        manifest_json = order.manifest_json
        resolution_time = self._now() * 1_000_000

        def derive_resolution():
            return _derive_resolution(
                manifest_json,
                item_ids,
                evidence_inputs,
                resolution_time,
            )

        def validate_resolution(leader_result):
            if not isinstance(leader_result, gl.vm.Return):
                return False
            leader_stable = _resolution_stable_fields(
                leader_result.calldata,
                item_ids,
            )
            if leader_stable is None:
                return False
            independent = derive_resolution()
            independent_stable = _resolution_stable_fields(
                independent,
                item_ids,
            )
            return (
                independent_stable is not None
                and leader_stable == independent_stable
            )

        result = gl.vm.run_nondet_unsafe(
            derive_resolution,
            validate_resolution,
        )
        if _resolution_stable_fields(result, item_ids) is None:
            raise gl.vm.UserError("[EXPECTED] invalid consensus result")

        resolution_json = self._canonical_json(result)
        resolution_round = (
            int(self.resolution_round_by_order[order_id]) + 1
            if order_id in self.resolution_round_by_order
            else 1
        )
        self.resolution_json_by_round[
            self._resolution_key(order_id, resolution_round)
        ] = resolution_json
        self.resolution_json_by_order[order_id] = resolution_json
        self.resolution_round_by_order[order_id] = u256(resolution_round)
        has_unresolved_item = any(
            item["outcome"] == "UNRESOLVED" for item in result["items"]
        )
        is_unresolved = (
            has_unresolved_item
            or result["delivery_outcome"] == "UNRESOLVED"
        )
        if is_unresolved:
            unresolved_count = (
                int(self.unresolved_count_by_order[order_id]) + 1
                if order_id in self.unresolved_count_by_order
                else 1
            )
            self.unresolved_count_by_order[order_id] = u256(unresolved_count)
            order.state = "ESCALATED" if unresolved_count >= 2 else "EVIDENCE_CURE"
        else:
            order.state = "RESOLVED"
        self.orders[order_id] = order
        return resolution_json

    @gl.public.write
    def propose_mutual_settlement(
        self,
        order_id: str,
        allocation_json: str,
    ) -> str:
        if order_id not in self.orders:
            raise gl.vm.UserError("[EXPECTED] order not found")
        order = self.orders[order_id]
        if order.state != "ESCALATED":
            raise gl.vm.UserError("[EXPECTED] invalid settlement transition")
        if self._now() < int(order.appeal_deadline):
            raise gl.vm.UserError("[EXPECTED] appeal deadline not reached")
        if not self._participant_role(order, gl.message.sender_address):
            raise gl.vm.UserError("[EXPECTED] affected actor required")

        (
            proposal_nonce,
            proposal_json,
            digest,
            customer_total,
            restaurant_total,
            courier_total,
        ) = self._parse_mutual_allocation(order_id, allocation_json)
        nonce_key = self._canonical_json(
            [
                str(int(gl.message.chain_id)),
                self._address_hex(gl.message.contract_address),
                order_id,
                proposal_nonce,
            ]
        )
        if nonce_key in self.used_settlement_nonce_keys:
            raise gl.vm.UserError("[EXPECTED] proposal nonce already used")
        if order_id in self.settlement_proposal_by_order:
            raise gl.vm.UserError("[EXPECTED] settlement proposal already exists")

        self.settlement_proposal_by_order[order_id] = SettlementProposal(
            proposal_json=proposal_json,
            digest=digest,
            proposal_nonce=proposal_nonce,
            customer_wei=u256(customer_total),
            restaurant_wei=u256(restaurant_total),
            courier_wei=u256(courier_total),
            customer_signed=False,
            restaurant_signed=False,
            courier_signed=False,
        )
        self.used_settlement_nonce_keys[nonce_key] = True
        return digest

    def _complete_mutual_settlement(
        self,
        order_id: str,
        order: Order,
        proposal: SettlementProposal,
    ) -> None:
        if (
            self.reserved_items < order.subtotal
            or self.reserved_delivery < order.delivery_fee
        ):
            raise gl.vm.UserError("[EXPECTED] accounting conservation violated")

        self.reserved_items -= order.subtotal
        self.reserved_delivery -= order.delivery_fee
        self.restaurant_payouts_emitted += proposal.restaurant_wei
        self.courier_payouts_emitted += proposal.courier_wei
        self.customer_refunds_emitted += proposal.customer_wei
        order.state = "SETTLED"
        self.orders[order_id] = order
        self._assert_conservation()

        if proposal.customer_wei > u256(0):
            gl.get_contract_at(order.customer).emit_transfer(
                value=proposal.customer_wei,
                on="finalized",
            )
        if proposal.restaurant_wei > u256(0):
            gl.get_contract_at(order.restaurant).emit_transfer(
                value=proposal.restaurant_wei,
                on="finalized",
            )
        if proposal.courier_wei > u256(0):
            gl.get_contract_at(order.courier).emit_transfer(
                value=proposal.courier_wei,
                on="finalized",
            )

    @gl.public.write
    def sign_mutual_settlement(self, order_id: str, digest: str) -> None:
        if order_id not in self.orders:
            raise gl.vm.UserError("[EXPECTED] order not found")
        if order_id not in self.settlement_proposal_by_order:
            raise gl.vm.UserError("[EXPECTED] settlement proposal not found")
        order = self.orders[order_id]
        role = self._participant_role(order, gl.message.sender_address)
        if not role:
            raise gl.vm.UserError("[EXPECTED] affected actor required")
        proposal = self.settlement_proposal_by_order[order_id]
        if digest != proposal.digest:
            raise gl.vm.UserError(
                "[EXPECTED] settlement proposal digest mismatch"
            )
        if (
            (role == "customer" and proposal.customer_signed)
            or (role == "restaurant" and proposal.restaurant_signed)
            or (role == "courier" and proposal.courier_signed)
        ):
            raise gl.vm.UserError(
                "[EXPECTED] settlement signature already recorded"
            )
        if order.state != "ESCALATED":
            raise gl.vm.UserError("[EXPECTED] invalid settlement transition")

        if role == "customer":
            proposal.customer_signed = True
        elif role == "restaurant":
            proposal.restaurant_signed = True
        else:
            proposal.courier_signed = True
        self.settlement_proposal_by_order[order_id] = proposal
        if (
            proposal.customer_signed
            and proposal.restaurant_signed
            and proposal.courier_signed
        ):
            self._complete_mutual_settlement(order_id, order, proposal)

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
    def get_evidence(self, order_id: str, evidence_index: u256) -> Evidence:
        return self.evidence_by_key[
            self._evidence_key(order_id, int(evidence_index))
        ]

    @gl.public.view
    def get_evidence_count(self, order_id: str) -> u256:
        if order_id not in self.orders:
            raise gl.vm.UserError("[EXPECTED] order not found")
        if order_id not in self.evidence_count_by_order:
            return u256(0)
        return self.evidence_count_by_order[order_id]

    @gl.public.view
    def get_item(self, order_id: str, item_id: str) -> str:
        return self.item_json_by_key[self._item_key(order_id, item_id)]

    @gl.public.view
    def get_resolution(self, order_id: str) -> str:
        if order_id not in self.orders:
            raise gl.vm.UserError("[EXPECTED] order not found")
        if order_id not in self.resolution_json_by_order:
            raise gl.vm.UserError("[EXPECTED] resolution not found")
        return self.resolution_json_by_order[order_id]

    @gl.public.view
    def get_round(self, order_id: str) -> u256:
        if order_id not in self.orders:
            raise gl.vm.UserError("[EXPECTED] order not found")
        if order_id not in self.resolution_round_by_order:
            return u256(0)
        return self.resolution_round_by_order[order_id]

    @gl.public.view
    def get_settlement_proposal(self, order_id: str) -> SettlementProposal:
        if order_id not in self.orders:
            raise gl.vm.UserError("[EXPECTED] order not found")
        if order_id not in self.settlement_proposal_by_order:
            raise gl.vm.UserError("[EXPECTED] settlement proposal not found")
        return self.settlement_proposal_by_order[order_id]

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
