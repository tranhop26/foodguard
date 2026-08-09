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
MAX_ITEMS = 100
MAX_ACTIVE_EVIDENCE = 103
MAX_EVIDENCE_HISTORY = 112
CURE_WINDOW_SECONDS = 300
MAX_SETTLEMENT_PROPOSALS = 32
EVIDENCE_ACTION_CODES = {
    "PACKED": 1,
    "PICKED_UP": 2,
    "DELIVERED": 3,
    "CUSTOMER_CLAIM": 4,
    "CURE": 5,
    "APPEAL": 6,
}
PACKED_ITEM_STATUS_CODES = {
    "AS_ORDERED": 1,
    "PERMITTED_SUBSTITUTION": 2,
    "ABSENT": 3,
    "DIFFERENT": 4,
    "UNKNOWN": 5,
}
QUANTITY_STATUS_CODES = {"EXACT": 1, "SHORT": 2, "EXCESS": 3, "UNKNOWN": 4}
CONDITION_STATUS_CODES = {"MET": 1, "NOT_MET": 2, "UNKNOWN": 3}
PICKUP_OBSERVATION_CODES = {
    "PICKUP_CONFIRMED": 1,
    "PICKUP_FAILED": 2,
    "UNKNOWN": 3,
}
DELIVERY_OBSERVATION_CODES = {
    "HANDOFF_CONFIRMED": 1,
    "HANDOFF_FAILED": 2,
    "UNKNOWN": 3,
}
CLAIM_CATEGORY_CODES = {
    "ABSENT_AT_RECEIPT": 1,
    "NOT_AS_ORDERED": 2,
    "HANDOFF_NOT_RECEIVED": 3,
}
CLAIM_CRITERION_KIND_CODES = {
    "ITEM": 1,
    "SUBSTITUTION": 2,
    "CONDITION": 3,
    "QUANTITY": 4,
    "DELIVERY": 5,
}


def _is_public_https_url(value: str) -> bool:
    if (
        type(value) is not str
        or not value.startswith("https://")
        or len(value.encode("utf-8")) > 2048
        or any(ord(character) <= 32 or ord(character) == 127 for character in value)
        or "\\" in value
        or "#" in value
    ):
        return False
    remainder = value[8:]
    authority = remainder
    for separator in ("/", "?"):
        if separator in authority:
            authority = authority.split(separator, 1)[0]
    if not authority or "@" in authority or ":" in authority or authority.endswith("."):
        return False
    host = authority.lower()
    if (
        "." not in host
        or host.startswith(".")
        or host.endswith(".")
        or any(character not in "abcdefghijklmnopqrstuvwxyz0123456789-." for character in host)
    ):
        return False
    labels = host.split(".")
    if any(
        not label
        or label.startswith("-")
        or label.endswith("-")
        for label in labels
    ):
        return False
    if all(character in "0123456789." for character in host):
        return False
    reserved_suffixes = (
        ".localhost",
        ".local",
        ".internal",
        ".example",
        ".invalid",
        ".test",
        ".arpa",
        ".onion",
    )
    if host in ("localhost", "example.com", "example.net", "example.org"):
        return False
    if host.endswith(reserved_suffixes):
        return False
    if any(
        host == domain or host.endswith("." + domain)
        for domain in ("example.com", "example.net", "example.org")
    ):
        return False
    return True


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


def _unresolved_resolution(item_ids, reason: str, evidence_indices, evidence_hashes):
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
        "evidence_hashes": evidence_hashes,
        "evidence_indices": evidence_indices,
    }


def _resolution_stable_fields(value, item_ids):
    if type(value) is not dict or set(value.keys()) != {
        "delivery_outcome",
        "evidence_hashes",
        "evidence_indices",
        "items",
    }:
        return None
    items = value["items"]
    hashes = value["evidence_hashes"]
    indices = value["evidence_indices"]
    if (
        type(items) is not list
        or len(items) != len(item_ids)
        or type(hashes) is not list
        or type(indices) is not list
        or len(hashes) != len(indices)
        or len(hashes) > MAX_ACTIVE_EVIDENCE
        or type(value["delivery_outcome"]) is not str
        or value["delivery_outcome"] not in DELIVERY_OUTCOMES
    ):
        return None
    if any(
        type(index) is not int
        or index < 0
        or index >= MAX_EVIDENCE_HISTORY
        or (position > 0 and index <= indices[position - 1])
        for position, index in enumerate(indices)
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
            "evidence_indices": indices,
            "items": stable_items,
        }
    )


def _normalize_model_resolution(value, item_ids, verified_indices, verified_hashes):
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
        "evidence_indices": verified_indices,
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


def _typed_evidence_event(manifest, item_ids, item_index_by_id, document, action, record_action, observed_at):
    item_id = document.get("item_id", "")
    if item_id:
        if item_id not in item_index_by_id:
            raise _EvidenceResolutionFailure("invalid evidence item")
        item_index = item_index_by_id[item_id]
    else:
        item_index = -1
    claim_code = 0
    claim_criterion_index = -1
    claim_criterion_kind_code = 0
    delivery_code = 0
    pickup_code = 0
    item_observations = []
    if action == "PACKED":
        observations = document.get("item_observations")
        if type(observations) is not list or len(observations) != len(item_ids):
            raise _EvidenceResolutionFailure("missing packed item observations")
        for expected_index, observation in enumerate(observations):
            manifest_item = manifest["items"][expected_index]
            if (
                type(observation) is not dict
                or set(observation.keys()) != {"condition_statuses", "item_id", "item_status", "quantity_status", "substitution_index"}
                or observation["item_id"] != item_ids[expected_index]
                or type(observation["item_status"]) is not str
                or observation["item_status"] not in PACKED_ITEM_STATUS_CODES
                or type(observation["quantity_status"]) is not str
                or observation["quantity_status"] not in QUANTITY_STATUS_CODES
                or type(observation["substitution_index"]) is not int
            ):
                raise _EvidenceResolutionFailure("invalid packed item observations")
            substitution_index = observation["substitution_index"]
            if (observation["item_status"] == "PERMITTED_SUBSTITUTION" and not 0 <= substitution_index < len(manifest_item["permitted_substitutions"])) or (observation["item_status"] != "PERMITTED_SUBSTITUTION" and substitution_index != -1):
                raise _EvidenceResolutionFailure("invalid packed substitution index")
            condition_statuses = observation["condition_statuses"]
            if type(condition_statuses) is not list or len(condition_statuses) != len(manifest_item["conditions"]):
                raise _EvidenceResolutionFailure("invalid packed condition statuses")
            typed_conditions = []
            for condition_index, condition in enumerate(condition_statuses):
                if type(condition) is not dict or set(condition.keys()) != {"condition_index", "status"} or condition["condition_index"] != condition_index or type(condition["status"]) is not str or condition["status"] not in CONDITION_STATUS_CODES:
                    raise _EvidenceResolutionFailure("invalid packed condition statuses")
                typed_conditions.append([condition_index, CONDITION_STATUS_CODES[condition["status"]]])
            item_observations.append([expected_index, PACKED_ITEM_STATUS_CODES[observation["item_status"]], QUANTITY_STATUS_CODES[observation["quantity_status"]], substitution_index, typed_conditions])
        if item_id:
            raise _EvidenceResolutionFailure("invalid packed item")
    elif action == "PICKED_UP":
        value = document.get("pickup_observation")
        if type(value) is not str or value not in PICKUP_OBSERVATION_CODES or item_id:
            raise _EvidenceResolutionFailure("invalid pickup observation")
        pickup_code = PICKUP_OBSERVATION_CODES[value]
    elif action == "DELIVERED":
        value = document.get("delivery_observation")
        if type(value) is not str or value not in DELIVERY_OBSERVATION_CODES or item_id:
            raise _EvidenceResolutionFailure("invalid delivery observation")
        delivery_code = DELIVERY_OBSERVATION_CODES[value]
    elif action == "CUSTOMER_CLAIM":
        category = document.get("claim_category")
        kind = document.get("criterion_kind")
        criterion_index = document.get("criterion_index")
        if not item_id or type(category) is not str or category not in CLAIM_CATEGORY_CODES or type(kind) is not str or kind not in CLAIM_CRITERION_KIND_CODES or type(criterion_index) is not int:
            raise _EvidenceResolutionFailure("invalid claim criterion")
        manifest_item = manifest["items"][item_index]
        limit = {"ITEM": 1, "SUBSTITUTION": len(manifest_item["permitted_substitutions"]), "CONDITION": len(manifest_item["conditions"]), "QUANTITY": 1, "DELIVERY": 0}[kind]
        if (criterion_index != -1 if kind == "DELIVERY" else not 0 <= criterion_index < limit):
            raise _EvidenceResolutionFailure("invalid claim criterion")
        claim_code = CLAIM_CATEGORY_CODES[category]
        claim_criterion_kind_code = CLAIM_CRITERION_KIND_CODES[kind]
        claim_criterion_index = criterion_index
    else:
        raise _EvidenceResolutionFailure("invalid evidence action")
    return {
        "action_code": EVIDENCE_ACTION_CODES[action],
        "claim_code": claim_code,
        "claim_criterion_index": claim_criterion_index,
        "claim_criterion_kind_code": claim_criterion_kind_code,
        "delivery_code": delivery_code,
        "item_index": item_index,
        "item_observations": item_observations,
        "observed_at_us": observed_at,
        "pickup_code": pickup_code,
        "record_action_code": EVIDENCE_ACTION_CODES[record_action],
    }


def _derive_resolution(manifest_json, item_ids, evidence_inputs, resolution_time):
    invalid_reason = "Public evidence was unavailable, invalid, or insufficient."
    verified_indices = [record["history_index"] for record in evidence_inputs]
    verified_hashes = [record["sha256"] for record in evidence_inputs]
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
                "condition_count": len(item["conditions"]),
                "condition_set_commitment": "0x" + hashlib.sha256(
                    _canonical_json_value(item["conditions"]).encode("utf-8")
                ).hexdigest(),
                "item_identity_commitment": "0x" + hashlib.sha256(
                    item["name"].encode("utf-8")
                ).hexdigest(),
                "item_index": item_index,
                "quantity": item["quantity"],
                "substitution_count": len(item["permitted_substitutions"]),
                "substitution_set_commitment": "0x" + hashlib.sha256(
                    _canonical_json_value(item["permitted_substitutions"]).encode("utf-8")
                ).hexdigest(),
            }
        )

    try:
        if not evidence_inputs:
            raise _EvidenceResolutionFailure("missing evidence")
        for record in evidence_inputs:
            source_url = record["source_url"]
            if not _is_public_https_url(source_url):
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

            record_action = record["action"]
            action = record["effective_action"]
            if action == "BATCH_CORRECTION":
                if record_action not in ("CURE", "APPEAL") or document.get("action") != record_action or record["item_id"] or document.get("item_id", ""):
                    raise _EvidenceResolutionFailure("invalid batch evidence")
                statements = document.get("statements")
                if type(statements) is not list or not statements or len(statements) > MAX_ACTIVE_EVIDENCE:
                    raise _EvidenceResolutionFailure("invalid batch evidence")
                for statement in statements:
                    if type(statement) is not dict:
                        raise _EvidenceResolutionFailure("invalid batch statement")
                    semantic_action = statement.get("effective_action")
                    semantic_item = statement.get("item_id", "")
                    typed_fields = {
                        "PACKED": {"item_observations"},
                        "PICKED_UP": {"pickup_observation"},
                        "DELIVERED": {"delivery_observation"},
                        "CUSTOMER_CLAIM": {"claim_category", "criterion_index", "criterion_kind"},
                    }.get(semantic_action)
                    if typed_fields is None:
                        raise _EvidenceResolutionFailure("invalid batch statement")
                    exact_fields = {"effective_action"} | typed_fields
                    if semantic_item:
                        exact_fields.add("item_id")
                    if set(statement.keys()) != exact_fields:
                        raise _EvidenceResolutionFailure("invalid batch statement")
                    actions.add(semantic_action)
                    evidence_events.append(_typed_evidence_event(
                        manifest, item_ids, item_index_by_id, statement,
                        semantic_action, record_action, observed_at,
                    ))
                continue
            if record_action not in EVIDENCE_ACTION_CODES or action not in EVIDENCE_ACTION_CODES:
                raise RuntimeError("invalid stored evidence action")
            if document.get("action") != record_action:
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
            claim_criterion_index = -1
            claim_criterion_kind_code = 0
            delivery_code = 0
            pickup_code = 0
            item_observations = []
            if action == "PACKED":
                observations = document.get("item_observations")
                if type(observations) is not list or len(observations) != len(item_ids):
                    raise _EvidenceResolutionFailure(
                        "missing packed item observations"
                    )
                for expected_index, observation in enumerate(observations):
                    manifest_item = manifest["items"][expected_index]
                    if (
                        type(observation) is not dict
                        or set(observation.keys())
                        != {
                            "condition_statuses",
                            "item_id",
                            "item_status",
                            "quantity_status",
                            "substitution_index",
                        }
                        or observation["item_id"] != item_ids[expected_index]
                        or type(observation["item_status"]) is not str
                        or observation["item_status"] not in PACKED_ITEM_STATUS_CODES
                        or type(observation["quantity_status"]) is not str
                        or observation["quantity_status"] not in QUANTITY_STATUS_CODES
                        or type(observation["substitution_index"]) is not int
                    ):
                        raise _EvidenceResolutionFailure(
                            "invalid packed item observations"
                        )
                    substitution_index = observation["substitution_index"]
                    if (
                        observation["item_status"] == "PERMITTED_SUBSTITUTION"
                        and not (
                            0
                            <= substitution_index
                            < len(manifest_item["permitted_substitutions"])
                        )
                    ) or (
                        observation["item_status"] != "PERMITTED_SUBSTITUTION"
                        and substitution_index != -1
                    ):
                        raise _EvidenceResolutionFailure(
                            "invalid packed substitution index"
                        )
                    condition_statuses = observation["condition_statuses"]
                    if (
                        type(condition_statuses) is not list
                        or len(condition_statuses) != len(manifest_item["conditions"])
                    ):
                        raise _EvidenceResolutionFailure(
                            "invalid packed condition statuses"
                        )
                    typed_conditions = []
                    for condition_index, condition in enumerate(condition_statuses):
                        if (
                            type(condition) is not dict
                            or set(condition.keys()) != {"condition_index", "status"}
                            or condition["condition_index"] != condition_index
                            or type(condition["status"]) is not str
                            or condition["status"] not in CONDITION_STATUS_CODES
                        ):
                            raise _EvidenceResolutionFailure(
                                "invalid packed condition statuses"
                            )
                        typed_conditions.append(
                            [condition_index, CONDITION_STATUS_CODES[condition["status"]]]
                        )
                    item_observations.append(
                        [
                            expected_index,
                            PACKED_ITEM_STATUS_CODES[observation["item_status"]],
                            QUANTITY_STATUS_CODES[observation["quantity_status"]],
                            substitution_index,
                            typed_conditions,
                        ]
                    )
            elif action == "PICKED_UP":
                pickup_observation = document.get("pickup_observation")
                if (
                    type(pickup_observation) is not str
                    or pickup_observation not in PICKUP_OBSERVATION_CODES
                ):
                    raise _EvidenceResolutionFailure("invalid pickup observation")
                pickup_code = PICKUP_OBSERVATION_CODES[pickup_observation]
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
                criterion_kind = document.get("criterion_kind")
                criterion_index = document.get("criterion_index")
                if (
                    type(criterion_kind) is not str
                    or criterion_kind not in CLAIM_CRITERION_KIND_CODES
                    or type(criterion_index) is not int
                ):
                    raise _EvidenceResolutionFailure("invalid claim criterion")
                manifest_item = manifest["items"][item_index]
                criterion_limit = {
                    "ITEM": 1,
                    "SUBSTITUTION": len(manifest_item["permitted_substitutions"]),
                    "CONDITION": len(manifest_item["conditions"]),
                    "QUANTITY": 1,
                    "DELIVERY": 0,
                }[criterion_kind]
                if criterion_kind == "DELIVERY":
                    if criterion_index != -1:
                        raise _EvidenceResolutionFailure("invalid claim criterion")
                elif criterion_index < 0 or criterion_index >= criterion_limit:
                    raise _EvidenceResolutionFailure("invalid claim criterion")
                claim_criterion_kind_code = CLAIM_CRITERION_KIND_CODES[criterion_kind]
                claim_criterion_index = criterion_index
            actions.add(action)
            evidence_events.append(
                {
                    "action_code": EVIDENCE_ACTION_CODES[action],
                    "claim_code": claim_code,
                    "claim_criterion_index": claim_criterion_index,
                    "claim_criterion_kind_code": claim_criterion_kind_code,
                    "delivery_code": delivery_code,
                    "item_index": item_index,
                    "item_observations": item_observations,
                    "observed_at_us": observed_at,
                    "pickup_code": pickup_code,
                    "record_action_code": EVIDENCE_ACTION_CODES[record_action],
                }
            )
        if not {"PACKED", "PICKED_UP", "DELIVERED"}.issubset(actions):
            raise _EvidenceResolutionFailure("insufficient evidence actions")
    except _EvidenceResolutionFailure:
        return _unresolved_resolution(
            item_ids,
            invalid_reason,
            verified_indices,
            verified_hashes,
        )

    prompt = (
        "FOODGUARD_RESOLUTION_V1\n"
        "Resolve one delivery using only the contract-generated typed payload below. "
        "The payload contains no participant prose. action_code meanings are "
        "1=PACKED, 2=PICKED_UP, 3=DELIVERED, 4=CUSTOMER_CLAIM, "
        "5=CURE, 6=APPEAL. "
        "Packed item status codes mean 1=as ordered, 2=permitted substitution, "
        "3=absent, 4=different, 5=unknown. Quantity codes mean 1=exact, 2=short, "
        "3=excess, 4=unknown. Condition codes mean 1=met, 2=not met, 3=unknown. "
        "Pickup codes mean 1=confirmed, 2=failed, 3=unknown. Delivery codes mean "
        "1=handoff confirmed, 2=handoff failed, 3=unknown. Claim codes mean "
        "1=item absent at receipt, 2=item not as ordered, 3=delivery not received. "
        "Claim criterion kind codes mean 1=item, 2=substitution, 3=condition, "
        "4=quantity, 5=delivery. All indices bind the corresponding manifest "
        "commitments and contain no participant prose.\n"
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
    return _normalize_model_resolution(
        model_result,
        item_ids,
        verified_indices,
        verified_hashes,
    )


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
    cure_deadline: u64
    state: str
    restaurant_accepted: bool
    courier_accepted: bool
    items_settled: bool
    delivery_settled: bool
    refund_emitted: bool
    escalated_retry_used: bool


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
    effective_action: str


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
    proposal_version: u256
    resolution_round: u256
    active_evidence_digest: str


@allow_storage
@dataclass
class Settlement:
    settlement_id: str
    customer_wei: u256
    restaurant_wei: u256
    courier_wei: u256


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
    superseded_evidence_keys: TreeMap[str, bool]
    last_resolution_active_digest_by_order: TreeMap[str, str]
    appeal_used_keys: TreeMap[str, bool]
    settlement_proposal_by_key: TreeMap[str, SettlementProposal]
    settlement_proposal_count_by_order: TreeMap[str, u256]
    settlement_proposal_count_by_order_role: TreeMap[str, u256]
    settlement_proposal_digest_by_index: TreeMap[str, str]
    settlement_by_order: TreeMap[str, Settlement]
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

    def _proposal_key(self, order_id: str, digest: str) -> str:
        return self._canonical_json([order_id, digest])

    def _proposal_index_key(self, order_id: str, proposal_index: int) -> str:
        return self._canonical_json([order_id, proposal_index])

    def _proposal_role_key(self, order_id: str, role: str) -> str:
        return self._canonical_json([order_id, role])

    def _active_evidence_indices(self, order_id: str):
        evidence_count = (
            int(self.evidence_count_by_order[order_id])
            if order_id in self.evidence_count_by_order
            else 0
        )
        if evidence_count > MAX_EVIDENCE_HISTORY:
            raise gl.vm.UserError("[EXPECTED] evidence history limit exceeded")
        active = []
        for evidence_index in range(evidence_count):
            if self._evidence_key(order_id, evidence_index) not in self.superseded_evidence_keys:
                active.append(evidence_index)
        if len(active) > MAX_ACTIVE_EVIDENCE:
            raise gl.vm.UserError("[EXPECTED] active evidence limit exceeded")
        return active

    def _active_evidence_digest(self, order_id: str, active_indices) -> str:
        bindings = []
        for evidence_index in active_indices:
            evidence = self.evidence_by_key[
                self._evidence_key(order_id, evidence_index)
            ]
            bindings.append([evidence_index, evidence.sha256.lower()])
        return "0x" + hashlib.sha256(
            self._canonical_json(bindings).encode("utf-8")
        ).hexdigest()

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

    def _parse_mutual_allocation(
        self,
        order_id: str,
        allocation_json: str,
        proposal_version: int,
        resolution_round: int,
    ):
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
        bound_proposal["proposal_version"] = proposal_version
        bound_proposal["resolution_round"] = resolution_round
        bound_proposal["active_evidence_digest"] = (
            self.last_resolution_active_digest_by_order[order_id]
            if order_id in self.last_resolution_active_digest_by_order
            else self._active_evidence_digest(
                order_id,
                self._active_evidence_indices(order_id),
            )
        )
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

    def _typed_statement_slot(self, order_id: str, statement):
        if type(statement) is not dict:
            raise gl.vm.UserError("[EXPECTED] typed evidence facts required")
        action = statement.get("effective_action")
        item_id = statement.get("item_id", "")
        if type(item_id) is not str:
            raise gl.vm.UserError("[EXPECTED] typed evidence facts required")
        manifest = json.loads(self.orders[order_id].manifest_json)
        typed_fields = set()
        if action == "PACKED":
            typed_fields = {"item_observations"}
            observations = statement.get("item_observations")
            if type(observations) is not list or len(observations) != len(manifest["items"]):
                raise gl.vm.UserError("[EXPECTED] typed evidence facts required")
            for manifest_item, observation in zip(manifest["items"], observations):
                if (
                    type(observation) is not dict
                    or set(observation.keys()) != {"condition_statuses", "item_id", "item_status", "quantity_status", "substitution_index"}
                    or observation.get("item_id") != manifest_item["item_id"]
                    or type(observation.get("item_status")) is not str
                    or observation.get("item_status") not in PACKED_ITEM_STATUS_CODES
                    or type(observation.get("quantity_status")) is not str
                    or observation.get("quantity_status") not in QUANTITY_STATUS_CODES
                    or type(observation.get("substitution_index")) is not int
                ):
                    raise gl.vm.UserError("[EXPECTED] typed evidence facts required")
                substitution_index = observation["substitution_index"]
                if observation["item_status"] == "PERMITTED_SUBSTITUTION":
                    if not 0 <= substitution_index < len(manifest_item["permitted_substitutions"]):
                        raise gl.vm.UserError("[EXPECTED] typed evidence facts required")
                elif substitution_index != -1:
                    raise gl.vm.UserError("[EXPECTED] typed evidence facts required")
                statuses = observation.get("condition_statuses")
                if type(statuses) is not list or len(statuses) != len(manifest_item["conditions"]):
                    raise gl.vm.UserError("[EXPECTED] typed evidence facts required")
                for condition_index, status in enumerate(statuses):
                    if (
                        type(status) is not dict
                        or set(status.keys()) != {"condition_index", "status"}
                        or status.get("condition_index") != condition_index
                        or type(status.get("status")) is not str
                        or status.get("status") not in CONDITION_STATUS_CODES
                    ):
                        raise gl.vm.UserError("[EXPECTED] typed evidence facts required")
            if item_id:
                raise gl.vm.UserError("[EXPECTED] typed evidence facts required")
        elif action == "PICKED_UP":
            typed_fields = {"pickup_observation"}
            if type(statement.get("pickup_observation")) is not str or statement.get("pickup_observation") not in PICKUP_OBSERVATION_CODES or item_id:
                raise gl.vm.UserError("[EXPECTED] typed evidence facts required")
        elif action == "DELIVERED":
            typed_fields = {"delivery_observation"}
            if type(statement.get("delivery_observation")) is not str or statement.get("delivery_observation") not in DELIVERY_OBSERVATION_CODES or item_id:
                raise gl.vm.UserError("[EXPECTED] typed evidence facts required")
        elif action == "CUSTOMER_CLAIM":
            typed_fields = {"claim_category", "criterion_index", "criterion_kind"}
            category = statement.get("claim_category")
            kind = statement.get("criterion_kind")
            criterion_index = statement.get("criterion_index")
            manifest_item = next((candidate for candidate in manifest["items"] if candidate["item_id"] == item_id), None)
            if not item_id or manifest_item is None or type(category) is not str or category not in CLAIM_CATEGORY_CODES or type(kind) is not str or kind not in CLAIM_CRITERION_KIND_CODES or type(criterion_index) is not int:
                raise gl.vm.UserError("[EXPECTED] typed evidence facts required")
            criterion_limit = {"ITEM": 1, "SUBSTITUTION": len(manifest_item["permitted_substitutions"]), "CONDITION": len(manifest_item["conditions"]), "QUANTITY": 1, "DELIVERY": 0}[kind]
            if (criterion_index != -1 if kind == "DELIVERY" else not 0 <= criterion_index < criterion_limit):
                raise gl.vm.UserError("[EXPECTED] typed evidence facts required")
        else:
            raise gl.vm.UserError("[EXPECTED] typed evidence facts required")
        exact_fields = {"effective_action"} | typed_fields
        if item_id:
            exact_fields.add("item_id")
        if set(statement.keys()) != exact_fields:
            raise gl.vm.UserError("[EXPECTED] typed evidence facts required")
        return action, item_id

    def _stored_evidence_slots(self, order_id: str, evidence: Evidence):
        if evidence.effective_action != "BATCH_CORRECTION":
            return [(evidence.effective_action, evidence.item_id)]
        try:
            statements = json.loads(evidence.envelope_json)["statements"]
        except Exception:
            raise gl.vm.UserError("[EXPECTED] invalid stored batch evidence")
        return [(statement.get("effective_action"), statement.get("item_id", "")) for statement in statements]

    def _validate_batch_correction(self, order_id: str, envelope, expected_actor: Address):
        targets = envelope.get("supersedes_evidence_indices")
        statements = envelope.get("statements")
        if type(targets) is not list or not targets or type(statements) is not list or not statements or len(statements) > MAX_ACTIVE_EVIDENCE:
            raise gl.vm.UserError("[EXPECTED] typed corrective evidence required")
        evidence_count = int(self.evidence_count_by_order[order_id])
        previous = -1
        slots = []
        for target in targets:
            if type(target) is not int or target <= previous or target >= evidence_count:
                raise gl.vm.UserError("[EXPECTED] typed corrective evidence required")
            previous = target
            key = self._evidence_key(order_id, target)
            if key in self.superseded_evidence_keys:
                raise gl.vm.UserError("[EXPECTED] typed corrective evidence required")
            evidence = self.evidence_by_key[key]
            try:
                actor = Address(evidence.actor_wallet)
            except Exception:
                raise gl.vm.UserError("[EXPECTED] typed corrective evidence required")
            if actor != expected_actor:
                raise gl.vm.UserError("[EXPECTED] typed corrective evidence required")
            slots.extend(self._stored_evidence_slots(order_id, evidence))
            if len(slots) > MAX_ACTIVE_EVIDENCE:
                raise gl.vm.UserError("[EXPECTED] typed corrective evidence required")
        if len(slots) != len(statements):
            raise gl.vm.UserError("[EXPECTED] typed corrective evidence required")
        for expected_slot, statement in zip(slots, statements):
            if self._typed_statement_slot(order_id, statement) != expected_slot:
                raise gl.vm.UserError("[EXPECTED] typed corrective evidence required")
        return targets

    def _validate_typed_evidence_facts(
        self,
        order_id: str,
        envelope,
        expected_action: str,
        expected_actor: Address,
        item_id: str,
    ):
        common_fields = {
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
        if item_id:
            common_fields.add("item_id")

        if expected_action in ("CURE", "APPEAL"):
            if item_id or set(envelope.keys()) != common_fields | {"statements", "supersedes_evidence_indices"}:
                raise gl.vm.UserError("[EXPECTED] typed corrective evidence required")
            return "BATCH_CORRECTION", self._validate_batch_correction(order_id, envelope, expected_actor)

        effective_action = expected_action
        manifest = json.loads(self.orders[order_id].manifest_json)
        typed_fields = set()
        if effective_action == "PACKED":
            typed_fields = {"item_observations"}
            observations = envelope.get("item_observations")
            if type(observations) is not list or len(observations) != len(
                manifest["items"]
            ):
                raise gl.vm.UserError("[EXPECTED] typed evidence facts required")
            for item_index, (manifest_item, observation) in enumerate(
                zip(manifest["items"], observations)
            ):
                if (
                    type(observation) is not dict
                    or set(observation.keys())
                    != {
                        "condition_statuses",
                        "item_id",
                        "item_status",
                        "quantity_status",
                        "substitution_index",
                    }
                    or observation.get("item_id") != manifest_item["item_id"]
                    or type(observation.get("item_status")) is not str
                    or observation.get("item_status") not in PACKED_ITEM_STATUS_CODES
                    or type(observation.get("quantity_status")) is not str
                    or observation.get("quantity_status") not in QUANTITY_STATUS_CODES
                    or type(observation.get("substitution_index")) is not int
                ):
                    raise gl.vm.UserError("[EXPECTED] typed evidence facts required")
                substitution_index = observation["substitution_index"]
                if observation["item_status"] == "PERMITTED_SUBSTITUTION":
                    if not (
                        0
                        <= substitution_index
                        < len(manifest_item["permitted_substitutions"])
                    ):
                        raise gl.vm.UserError("[EXPECTED] typed evidence facts required")
                elif substitution_index != -1:
                    raise gl.vm.UserError("[EXPECTED] typed evidence facts required")
                statuses = observation.get("condition_statuses")
                if type(statuses) is not list or len(statuses) != len(
                    manifest_item["conditions"]
                ):
                    raise gl.vm.UserError("[EXPECTED] typed evidence facts required")
                for condition_index, status in enumerate(statuses):
                    if (
                        type(status) is not dict
                        or set(status.keys()) != {"condition_index", "status"}
                        or status.get("condition_index") != condition_index
                        or type(status.get("status")) is not str
                        or status.get("status") not in CONDITION_STATUS_CODES
                    ):
                        raise gl.vm.UserError("[EXPECTED] typed evidence facts required")
            if item_id:
                raise gl.vm.UserError("[EXPECTED] typed evidence facts required")
        elif effective_action == "PICKED_UP":
            typed_fields = {"pickup_observation"}
            if (
                type(envelope.get("pickup_observation")) is not str
                or envelope.get("pickup_observation") not in PICKUP_OBSERVATION_CODES
                or item_id
            ):
                raise gl.vm.UserError("[EXPECTED] typed evidence facts required")
        elif effective_action == "DELIVERED":
            typed_fields = {"delivery_observation"}
            if (
                type(envelope.get("delivery_observation")) is not str
                or envelope.get("delivery_observation") not in DELIVERY_OBSERVATION_CODES
                or item_id
            ):
                raise gl.vm.UserError("[EXPECTED] typed evidence facts required")
        elif effective_action == "CUSTOMER_CLAIM":
            typed_fields = {"claim_category", "criterion_index", "criterion_kind"}
            category = envelope.get("claim_category")
            kind = envelope.get("criterion_kind")
            criterion_index = envelope.get("criterion_index")
            if (
                not item_id
                or type(category) is not str
                or category not in CLAIM_CATEGORY_CODES
                or type(kind) is not str
                or kind not in CLAIM_CRITERION_KIND_CODES
                or type(criterion_index) is not int
            ):
                raise gl.vm.UserError("[EXPECTED] typed evidence facts required")
            manifest_item = None
            for candidate in manifest["items"]:
                if candidate["item_id"] == item_id:
                    manifest_item = candidate
                    break
            if manifest_item is None:
                raise gl.vm.UserError("[EXPECTED] typed evidence facts required")
            criterion_limit = {
                "ITEM": 1,
                "SUBSTITUTION": len(manifest_item["permitted_substitutions"]),
                "CONDITION": len(manifest_item["conditions"]),
                "QUANTITY": 1,
                "DELIVERY": 0,
            }[kind]
            if kind == "DELIVERY":
                valid_index = criterion_index == -1
            else:
                valid_index = 0 <= criterion_index < criterion_limit
            if not valid_index:
                raise gl.vm.UserError("[EXPECTED] typed evidence facts required")
        else:
            raise gl.vm.UserError("[EXPECTED] typed evidence facts required")

        if set(envelope.keys()) != common_fields | typed_fields:
            raise gl.vm.UserError("[EXPECTED] typed evidence facts required")
        return effective_action, []

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
        if not _is_public_https_url(envelope["source_url"]):
            raise gl.vm.UserError(
                "[EXPECTED] public HTTPS evidence source required"
            )

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

        effective_action, superseded_indices = self._validate_typed_evidence_facts(
            order_id,
            envelope,
            expected_action,
            expected_actor,
            item_id,
        )

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
            effective_action=effective_action,
        )
        evidence_count = (
            int(self.evidence_count_by_order[order_id])
            if order_id in self.evidence_count_by_order
            else 0
        )
        if evidence_count >= MAX_EVIDENCE_HISTORY:
            raise gl.vm.UserError("[EXPECTED] evidence history limit exceeded")
        self.evidence_by_key[self._evidence_key(order_id, evidence_count)] = evidence
        self.evidence_count_by_order[order_id] = u256(evidence_count + 1)
        for target_index in superseded_indices:
            self.superseded_evidence_keys[
                self._evidence_key(order_id, target_index)
            ] = True
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

    def _settlement_id(
        self,
        order_id: str,
        basis: str,
        customer_wei: int,
        restaurant_wei: int,
        courier_wei: int,
    ) -> str:
        preimage = self._canonical_json(
            {
                "basis": basis,
                "chain_id": str(int(gl.message.chain_id)),
                "contract_address": self._address_hex(
                    gl.message.contract_address
                ),
                "courier_wei": str(courier_wei),
                "customer_wei": str(customer_wei),
                "order_id": order_id,
                "restaurant_wei": str(restaurant_wei),
                "schema_version": "foodguard-settlement-v1",
            }
        )
        return "0x" + hashlib.sha256(preimage.encode("utf-8")).hexdigest()

    def _emit_eoa_transfer(self, recipient: Address, amount: u256) -> None:
        if amount > u256(0):
            gl.get_contract_at(recipient).emit_transfer(
                value=amount,
                on="finalized",
            )

    def _preflight_allocation(
        self,
        order_id: str,
        order: Order,
        basis: str,
        customer_wei: int,
        restaurant_wei: int,
        courier_wei: int,
    ) -> str:
        if order_id in self.settlement_by_order:
            raise gl.vm.UserError("[EXPECTED] order reserves already settled")

        allocation_total = customer_wei + restaurant_wei + courier_wei
        if (
            customer_wei < 0
            or restaurant_wei < 0
            or courier_wei < 0
            or allocation_total != int(order.total_value)
        ):
            raise gl.vm.UserError(
                "[EXPECTED] allocation must conserve order value"
            )
        if order.items_settled or order.delivery_settled:
            raise gl.vm.UserError("[EXPECTED] order reserves already settled")

        self._assert_conservation()
        if (
            self.reserved_items < order.subtotal
            or self.reserved_delivery < order.delivery_fee
        ):
            raise gl.vm.UserError("[EXPECTED] accounting conservation violated")
        if self.balance < order.total_value:
            raise gl.vm.UserError("[EXPECTED] insufficient contract balance")

        post_accounted = (
            int(self.reserved_items)
            - int(order.subtotal)
            + int(self.reserved_delivery)
            - int(order.delivery_fee)
            + int(self.restaurant_payouts_emitted)
            + restaurant_wei
            + int(self.courier_payouts_emitted)
            + courier_wei
            + int(self.customer_refunds_emitted)
            + customer_wei
        )
        if int(self.total_inflows) != post_accounted:
            raise gl.vm.UserError("[EXPECTED] accounting conservation violated")

        return self._settlement_id(
            order_id,
            basis,
            customer_wei,
            restaurant_wei,
            courier_wei,
        )

    def _apply_allocation(
        self,
        order_id: str,
        order: Order,
        settlement_id: str,
        customer_wei: int,
        restaurant_wei: int,
        courier_wei: int,
        terminal_state: str,
    ) -> str:
        self.reserved_items -= order.subtotal
        self.reserved_delivery -= order.delivery_fee
        self.restaurant_payouts_emitted += u256(restaurant_wei)
        self.courier_payouts_emitted += u256(courier_wei)
        self.customer_refunds_emitted += u256(customer_wei)
        order.items_settled = True
        order.delivery_settled = True
        order.state = terminal_state
        if terminal_state in (
            "CANCELLED_REFUNDED",
            "FULFILLMENT_TIMEOUT_REFUNDED",
        ):
            order.refund_emitted = True
        if terminal_state == "CANCELLED_REFUNDED":
            order.restaurant_accepted = False
            order.courier_accepted = False
        self.orders[order_id] = order
        self.settlement_by_order[order_id] = Settlement(
            settlement_id=settlement_id,
            customer_wei=u256(customer_wei),
            restaurant_wei=u256(restaurant_wei),
            courier_wei=u256(courier_wei),
        )

        self._emit_eoa_transfer(order.customer, u256(customer_wei))
        self._emit_eoa_transfer(order.restaurant, u256(restaurant_wei))
        self._emit_eoa_transfer(order.courier, u256(courier_wei))
        return settlement_id

    def _allocate_once(
        self,
        order_id: str,
        order: Order,
        basis: str,
        customer_wei: int,
        restaurant_wei: int,
        courier_wei: int,
        terminal_state: str,
    ) -> str:
        if order_id in self.settlement_by_order:
            return self.settlement_by_order[order_id].settlement_id
        settlement_id = self._preflight_allocation(
            order_id,
            order,
            basis,
            customer_wei,
            restaurant_wei,
            courier_wei,
        )
        return self._apply_allocation(
            order_id,
            order,
            settlement_id,
            customer_wei,
            restaurant_wei,
            courier_wei,
            terminal_state,
        )

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
        try:
            restaurant_address = Address(restaurant)
            courier_address = Address(courier)
        except Exception:
            raise gl.vm.UserError("[EXPECTED] invalid wallet address")
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
            cure_deadline=u64(0),
            state="FUNDED",
            restaurant_accepted=False,
            courier_accepted=False,
            items_settled=False,
            delivery_settled=False,
            refund_emitted=False,
            escalated_retry_used=False,
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
        if self._now() >= int(order.packing_deadline):
            raise gl.vm.UserError("[EXPECTED] packing deadline passed")
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
        if self._now() >= int(order.delivery_deadline):
            raise gl.vm.UserError("[EXPECTED] delivery deadline passed")
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
        if self._now() >= int(order.delivery_deadline):
            raise gl.vm.UserError("[EXPECTED] delivery deadline passed")
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
        if order.state not in ("EVIDENCE_CURE", "ESCALATED"):
            raise gl.vm.UserError("[EXPECTED] invalid cure transition")
        if order.state == "ESCALATED" and order.escalated_retry_used:
            raise gl.vm.UserError("[EXPECTED] escalated retry already used")
        if self._now() >= int(order.cure_deadline):
            raise gl.vm.UserError("[EXPECTED] cure deadline passed")
        actor = gl.message.sender_address
        role = self._participant_role(order, actor)
        if not role:
            raise gl.vm.UserError("[EXPECTED] affected actor required")
        resolution_round = (
            int(self.resolution_round_by_order[order_id])
            if order_id in self.resolution_round_by_order
            else 0
        )
        cure_key = self._canonical_json([order_id, resolution_round, role])
        if cure_key in self.submitted_cure_keys:
            raise gl.vm.UserError("[EXPECTED] cure already submitted")
        self._append_evidence(order_id, "CURE", envelope_json, actor)
        self.submitted_cure_keys[cure_key] = True

    @gl.public.write
    def escalate_cure_timeout(self, order_id: str) -> None:
        if order_id not in self.orders:
            raise gl.vm.UserError("[EXPECTED] order not found")
        order = self.orders[order_id]
        if order.state != "EVIDENCE_CURE":
            raise gl.vm.UserError("[EXPECTED] invalid cure transition")
        if self._now() < int(order.cure_deadline):
            raise gl.vm.UserError("[EXPECTED] cure deadline not reached")
        active_indices = self._active_evidence_indices(order_id)
        active_digest = self._active_evidence_digest(order_id, active_indices)
        if (
            order_id not in self.last_resolution_active_digest_by_order
            or active_digest != self.last_resolution_active_digest_by_order[order_id]
        ):
            raise gl.vm.UserError("[EXPECTED] changed evidence requires resolution")
        order.state = "ESCALATED"
        order.cure_deadline = u64(self._now() + CURE_WINDOW_SECONDS)
        order.escalated_retry_used = False
        self.orders[order_id] = order

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
        if order.state not in (
            "REVIEW_WINDOW",
            "EVIDENCE_CURE",
            "APPEALED",
            "ESCALATED",
        ):
            raise gl.vm.UserError("[EXPECTED] invalid resolution transition")
        now = self._now()
        if (
            order.state == "REVIEW_WINDOW"
            and now < int(order.review_deadline)
        ):
            raise gl.vm.UserError("[EXPECTED] review deadline not reached")
        if order.state == "APPEALED" and now < int(order.appeal_deadline):
            raise gl.vm.UserError("[EXPECTED] appeal deadline not reached")
        if order.state in ("EVIDENCE_CURE", "ESCALATED"):
            if now < int(order.cure_deadline):
                raise gl.vm.UserError("[EXPECTED] cure deadline not reached")
            if order.state == "ESCALATED" and order.escalated_retry_used:
                raise gl.vm.UserError("[EXPECTED] escalated retry already used")

        manifest = json.loads(order.manifest_json)
        item_ids = [item["item_id"] for item in manifest["items"]]
        active_indices = self._active_evidence_indices(order_id)
        active_digest = self._active_evidence_digest(order_id, active_indices)
        if order.state in ("EVIDENCE_CURE", "APPEALED", "ESCALATED") and (
            order_id in self.last_resolution_active_digest_by_order
            and active_digest
            == self.last_resolution_active_digest_by_order[order_id]
        ):
            raise gl.vm.UserError("[EXPECTED] new active evidence required")
        evidence_inputs = []
        for evidence_index in active_indices:
            evidence = self.evidence_by_key[
                self._evidence_key(order_id, evidence_index)
            ]
            evidence_inputs.append(
                {
                    "action": evidence.action,
                    "effective_action": evidence.effective_action,
                    "envelope_json": evidence.envelope_json,
                    "history_index": evidence_index,
                    "issuer_id": evidence.issuer_id,
                    "item_id": evidence.item_id,
                    "observed_at": evidence.observed_at,
                    "sha256": evidence.sha256.lower(),
                    "source_url": evidence.source_url,
                    "subject": evidence.subject,
                }
            )
        manifest_json = order.manifest_json
        resolution_time = now * 1_000_000

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
        self.last_resolution_active_digest_by_order[order_id] = active_digest
        has_unresolved_item = any(
            item["outcome"] == "UNRESOLVED" for item in result["items"]
        )
        is_unresolved = (
            has_unresolved_item
            or result["delivery_outcome"] == "UNRESOLVED"
        )
        was_escalated = order.state == "ESCALATED"
        if is_unresolved:
            unresolved_count = (
                int(self.unresolved_count_by_order[order_id]) + 1
                if order_id in self.unresolved_count_by_order
                else 1
            )
            self.unresolved_count_by_order[order_id] = u256(unresolved_count)
            if unresolved_count == 1:
                order.state = "EVIDENCE_CURE"
                order.cure_deadline = u64(now + CURE_WINDOW_SECONDS)
            else:
                order.state = "ESCALATED"
                if was_escalated:
                    order.escalated_retry_used = True
                else:
                    order.escalated_retry_used = False
                    order.cure_deadline = u64(now + CURE_WINDOW_SECONDS)
        else:
            order.state = "RESOLVED"
            if was_escalated:
                order.escalated_retry_used = True
        self.orders[order_id] = order
        return resolution_json

    @gl.public.write
    def execute_settlement(self, order_id: str) -> str:
        if order_id not in self.orders:
            raise gl.vm.UserError("[EXPECTED] order not found")
        if order_id in self.settlement_by_order:
            return self.settlement_by_order[order_id].settlement_id

        order = self.orders[order_id]
        if order.state != "RESOLVED":
            raise gl.vm.UserError("[EXPECTED] invalid settlement transition")
        if self._now() < int(order.appeal_deadline):
            raise gl.vm.UserError("[EXPECTED] appeal deadline not reached")
        if order_id not in self.resolution_json_by_order:
            raise gl.vm.UserError("[EXPECTED] resolution not found")

        try:
            resolution = json.loads(self.resolution_json_by_order[order_id])
            manifest = json.loads(order.manifest_json)
        except Exception:
            raise gl.vm.UserError("[EXPECTED] invalid final decision")
        if (
            type(resolution) is not dict
            or set(resolution.keys())
            != {
                "delivery_outcome",
                "evidence_hashes",
                "evidence_indices",
                "items",
            }
            or type(resolution["items"]) is not list
            or len(resolution["items"]) != len(manifest["items"])
            or type(resolution["evidence_indices"]) is not list
            or len(resolution["evidence_indices"])
            != len(resolution["evidence_hashes"])
        ):
            raise gl.vm.UserError("[EXPECTED] invalid final decision")

        customer_wei = 0
        restaurant_wei = 0
        for manifest_item, decision in zip(
            manifest["items"], resolution["items"]
        ):
            if (
                type(decision) is not dict
                or decision.get("item_id") != manifest_item["item_id"]
            ):
                raise gl.vm.UserError("[EXPECTED] invalid final decision")
            item_value = (
                int(manifest_item["price_wei"])
                * manifest_item["quantity"]
            )
            outcome = decision.get("outcome")
            if outcome == "MATCHED":
                restaurant_wei += item_value
            elif outcome in ("MISSING", "MISMATCHED", "DELIVERY_FAILED"):
                customer_wei += item_value
            elif outcome == "UNRESOLVED":
                raise gl.vm.UserError("[EXPECTED] final decision unresolved")
            else:
                raise gl.vm.UserError("[EXPECTED] invalid final decision")

        delivery_outcome = resolution["delivery_outcome"]
        if delivery_outcome == "DELIVERED":
            courier_wei = int(order.delivery_fee)
        elif delivery_outcome == "DELIVERY_FAILED":
            courier_wei = 0
            customer_wei += int(order.delivery_fee)
        elif delivery_outcome == "UNRESOLVED":
            raise gl.vm.UserError("[EXPECTED] final decision unresolved")
        else:
            raise gl.vm.UserError("[EXPECTED] invalid final decision")

        resolution_digest = "0x" + hashlib.sha256(
            self.resolution_json_by_order[order_id].encode("utf-8")
        ).hexdigest()
        return self._allocate_once(
            order_id,
            order,
            "resolution:" + resolution_digest,
            customer_wei,
            restaurant_wei,
            courier_wei,
            "SETTLED",
        )

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
        role = self._participant_role(order, gl.message.sender_address)
        if not role:
            raise gl.vm.UserError("[EXPECTED] affected actor required")

        proposal_count = (
            int(self.settlement_proposal_count_by_order[order_id])
            if order_id in self.settlement_proposal_count_by_order
            else 0
        )
        role_key = self._proposal_role_key(order_id, role)
        role_proposal_count = (
            int(self.settlement_proposal_count_by_order_role[role_key])
            if role_key in self.settlement_proposal_count_by_order_role
            else 0
        )
        if role_proposal_count >= MAX_SETTLEMENT_PROPOSALS:
            raise gl.vm.UserError("[EXPECTED] settlement proposal limit reached")
        proposal_version = proposal_count + 1
        resolution_round = (
            int(self.resolution_round_by_order[order_id])
            if order_id in self.resolution_round_by_order
            else 0
        )

        (
            proposal_nonce,
            proposal_json,
            digest,
            customer_total,
            restaurant_total,
            courier_total,
        ) = self._parse_mutual_allocation(
            order_id,
            allocation_json,
            proposal_version,
            resolution_round,
        )
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
        proposal_key = self._proposal_key(order_id, digest)
        if proposal_key in self.settlement_proposal_by_key:
            raise gl.vm.UserError("[EXPECTED] settlement proposal already exists")
        active_evidence_digest = (
            self.last_resolution_active_digest_by_order[order_id]
            if order_id in self.last_resolution_active_digest_by_order
            else self._active_evidence_digest(
                order_id,
                self._active_evidence_indices(order_id),
            )
        )
        self.settlement_proposal_by_key[proposal_key] = SettlementProposal(
            proposal_json=proposal_json,
            digest=digest,
            proposal_nonce=proposal_nonce,
            customer_wei=u256(customer_total),
            restaurant_wei=u256(restaurant_total),
            courier_wei=u256(courier_total),
            customer_signed=False,
            restaurant_signed=False,
            courier_signed=False,
            proposal_version=u256(proposal_version),
            resolution_round=u256(resolution_round),
            active_evidence_digest=active_evidence_digest,
        )
        self.settlement_proposal_digest_by_index[
            self._proposal_index_key(order_id, proposal_count)
        ] = digest
        self.settlement_proposal_count_by_order[order_id] = u256(
            proposal_count + 1
        )
        self.settlement_proposal_count_by_order_role[role_key] = u256(
            role_proposal_count + 1
        )
        self.used_settlement_nonce_keys[nonce_key] = True
        return digest

    def _complete_mutual_settlement(
        self,
        order_id: str,
        order: Order,
        proposal: SettlementProposal,
        settlement_id: str,
    ) -> str:
        return self._apply_allocation(
            order_id,
            order,
            settlement_id,
            int(proposal.customer_wei),
            int(proposal.restaurant_wei),
            int(proposal.courier_wei),
            "SETTLED",
        )

    @gl.public.write
    def sign_mutual_settlement(self, order_id: str, digest: str) -> None:
        if order_id not in self.orders:
            raise gl.vm.UserError("[EXPECTED] order not found")
        proposal_key = self._proposal_key(order_id, digest)
        if proposal_key not in self.settlement_proposal_by_key:
            raise gl.vm.UserError("[EXPECTED] settlement proposal not found")
        order = self.orders[order_id]
        role = self._participant_role(order, gl.message.sender_address)
        if not role:
            raise gl.vm.UserError("[EXPECTED] affected actor required")
        proposal = self.settlement_proposal_by_key[proposal_key]
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
        current_round = (
            int(self.resolution_round_by_order[order_id])
            if order_id in self.resolution_round_by_order
            else 0
        )
        current_active_digest = self._active_evidence_digest(
            order_id,
            self._active_evidence_indices(order_id),
        )
        resolved_active_digest = (
            self.last_resolution_active_digest_by_order[order_id]
            if order_id in self.last_resolution_active_digest_by_order
            else current_active_digest
        )
        if (
            int(proposal.resolution_round) != current_round
            or proposal.active_evidence_digest != resolved_active_digest
            or proposal.active_evidence_digest != current_active_digest
        ):
            raise gl.vm.UserError("[EXPECTED] settlement proposal is stale")

        completes_settlement = (
            (
                role == "customer"
                and proposal.restaurant_signed
                and proposal.courier_signed
            )
            or (
                role == "restaurant"
                and proposal.customer_signed
                and proposal.courier_signed
            )
            or (
                role == "courier"
                and proposal.customer_signed
                and proposal.restaurant_signed
            )
        )
        settlement_id = ""
        if completes_settlement:
            settlement_id = self._preflight_allocation(
                order_id,
                order,
                "mutual:" + proposal.digest,
                int(proposal.customer_wei),
                int(proposal.restaurant_wei),
                int(proposal.courier_wei),
            )

        if role == "customer":
            proposal.customer_signed = True
        elif role == "restaurant":
            proposal.restaurant_signed = True
        else:
            proposal.courier_signed = True
        self.settlement_proposal_by_key[proposal_key] = proposal
        if completes_settlement:
            self._complete_mutual_settlement(
                order_id,
                order,
                proposal,
                settlement_id,
            )

    @gl.public.write
    def set_creation_paused(self, paused: bool) -> None:
        if gl.message.sender_address != self.deployer:
            raise gl.vm.UserError("[EXPECTED] only deployer may pause creation")
        self.creation_paused = paused

    @gl.public.write
    def cancel_fulfillment_timeout(self, order_id: str) -> str:
        if order_id not in self.orders:
            raise gl.vm.UserError("[EXPECTED] order not found")
        if order_id in self.settlement_by_order:
            return self.settlement_by_order[order_id].settlement_id
        order = self.orders[order_id]
        if order.state == "ACCEPTED":
            deadline = int(order.packing_deadline)
        elif order.state in ("READY_FOR_PICKUP", "IN_TRANSIT"):
            deadline = int(order.delivery_deadline)
        else:
            raise gl.vm.UserError("[EXPECTED] order cannot be timeout refunded")
        if self._now() < deadline:
            raise gl.vm.UserError("[EXPECTED] fulfillment deadline not reached")
        return self._allocate_once(
            order_id,
            order,
            "fulfillment-timeout:" + order.state,
            int(order.total_value),
            0,
            0,
            "FULFILLMENT_TIMEOUT_REFUNDED",
        )

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

        if order.refund_emitted:
            raise gl.vm.UserError("[EXPECTED] accounting conservation violated")

        self._allocate_once(
            order_id,
            order,
            "unaccepted-cancellation",
            int(order.total_value),
            0,
            0,
            "CANCELLED_REFUNDED",
        )

    @gl.public.view
    def get_order(self, order_id: str) -> Order:
        return self.orders[order_id]

    @gl.public.view
    def get_creation_paused(self) -> bool:
        return self.creation_paused

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
    def get_settlement_proposal(
        self, order_id: str, digest: str
    ) -> SettlementProposal:
        if order_id not in self.orders:
            raise gl.vm.UserError("[EXPECTED] order not found")
        proposal_key = self._proposal_key(order_id, digest)
        if proposal_key not in self.settlement_proposal_by_key:
            raise gl.vm.UserError("[EXPECTED] settlement proposal not found")
        return self.settlement_proposal_by_key[proposal_key]

    @gl.public.view
    def get_settlement_proposal_count(self, order_id: str) -> u256:
        if order_id not in self.orders:
            raise gl.vm.UserError("[EXPECTED] order not found")
        if order_id not in self.settlement_proposal_count_by_order:
            return u256(0)
        return self.settlement_proposal_count_by_order[order_id]

    @gl.public.view
    def get_settlement_proposal_digest(
        self, order_id: str, proposal_index: u256
    ) -> str:
        if order_id not in self.orders:
            raise gl.vm.UserError("[EXPECTED] order not found")
        count = (
            int(self.settlement_proposal_count_by_order[order_id])
            if order_id in self.settlement_proposal_count_by_order
            else 0
        )
        index = int(proposal_index)
        if index < 0 or index >= count:
            raise gl.vm.UserError("[EXPECTED] settlement proposal not found")
        return self.settlement_proposal_digest_by_index[
            self._proposal_index_key(order_id, index)
        ]

    @gl.public.view
    def get_order_settlement(self, order_id: str) -> Settlement:
        if order_id not in self.orders:
            raise gl.vm.UserError("[EXPECTED] order not found")
        if order_id not in self.settlement_by_order:
            raise gl.vm.UserError("[EXPECTED] settlement not found")
        return self.settlement_by_order[order_id]

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
