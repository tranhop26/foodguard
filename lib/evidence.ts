import type {
  CorrectionEffectiveAction,
  CorrectionStatement,
  EvidenceAction,
  EvidenceDocument,
  HexDigest,
  JsonValue,
  OrderItem,
} from "./domain";

export type {
  BatchCorrectionFacts,
  CorrectionEffectiveAction,
  CorrectionStatement,
  EvidenceDocument,
  HexDigest,
  OrderItem,
} from "./domain";

const evidenceActions = new Set<EvidenceAction>([
  "ORDER_MANIFEST", "PACKED", "PICKED_UP", "DELIVERED", "CUSTOMER_CLAIM", "CURE", "APPEAL",
]);

const requiredStringFields = [
  "order_id", "subject", "actor_wallet", "issuer_id", "source_url", "sha256", "observed_at",
  "submitted_at", "expires_at", "chain_id", "contract_address", "nonce",
] as const;
const baseEvidenceFields = new Set([
  "action", "actor_wallet", "chain_id", "contract_address", "expires_at", "issuer_id",
  "nonce", "observed_at", "order_id", "schema_version", "sha256", "source_url", "subject",
  "submitted_at",
]);
const packedObservationCodes = new Set(["PACKED_AS_ORDERED", "NOT_PACKED", "PACKED_DIFFERENT"]);
const deliveryObservationCodes = new Set(["HANDOFF_CONFIRMED", "HANDOFF_FAILED"]);
const claimCategoryCodes = new Set(["ABSENT_AT_RECEIPT", "NOT_AS_ORDERED", "HANDOFF_NOT_RECEIVED"]);
const MAX_ACTIVE_EVIDENCE = 103;

export const PACKED_ITEM_STATUS_OPTIONS = ["AS_ORDERED", "PERMITTED_SUBSTITUTION", "ABSENT", "DIFFERENT", "UNKNOWN"] as const;
export const QUANTITY_STATUS_OPTIONS = ["EXACT", "SHORT", "EXCESS", "UNKNOWN"] as const;
export const CONDITION_STATUS_OPTIONS = ["MET", "NOT_MET", "UNKNOWN"] as const;
export const PICKUP_OBSERVATION_OPTIONS = ["PICKUP_CONFIRMED", "PICKUP_FAILED", "UNKNOWN"] as const;
export const DELIVERY_OBSERVATION_OPTIONS = ["HANDOFF_CONFIRMED", "HANDOFF_FAILED", "UNKNOWN"] as const;
export const CLAIM_CATEGORY_OPTIONS = ["ABSENT_AT_RECEIPT", "NOT_AS_ORDERED", "HANDOFF_NOT_RECEIVED"] as const;
export const CLAIM_CRITERION_KIND_OPTIONS = ["ITEM", "SUBSTITUTION", "CONDITION", "QUANTITY", "DELIVERY"] as const;

const correctionActions = new Set<CorrectionEffectiveAction>(["PACKED", "PICKED_UP", "DELIVERED", "CUSTOMER_CLAIM"]);

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

function valueIn<const T extends readonly string[]>(options: T, value: unknown): value is T[number] {
  return typeof value === "string" && (options as readonly string[]).includes(value);
}

function assertCorrectionStatement(
  value: unknown,
  path = "statement",
  manifestItems?: readonly OrderItem[],
): asserts value is CorrectionStatement {
  if (!isPlainObject(value) || typeof value.effective_action !== "string" || !correctionActions.has(value.effective_action as CorrectionEffectiveAction)) {
    throw new TypeError(`${path} must use a supported effective_action`);
  }
  if (value.effective_action === "PACKED") {
    if (!hasExactKeys(value, ["effective_action", "item_observations"]) || !Array.isArray(value.item_observations) || value.item_observations.length === 0) {
      throw new TypeError(`${path} PACKED facts are malformed`);
    }
    if (manifestItems && value.item_observations.length !== manifestItems.length) {
      throw new TypeError(`${path} PACKED observations must match every manifest item`);
    }
    const itemIds = new Set<string>();
    for (const [itemIndex, item] of value.item_observations.entries()) {
      const manifestItem = manifestItems?.[itemIndex];
      if (
        !isPlainObject(item) ||
        !hasExactKeys(item, ["condition_statuses", "item_id", "item_status", "quantity_status", "substitution_index"]) ||
        typeof item.item_id !== "string" || !item.item_id || itemIds.has(item.item_id) ||
        !valueIn(PACKED_ITEM_STATUS_OPTIONS, item.item_status) ||
        !valueIn(QUANTITY_STATUS_OPTIONS, item.quantity_status) ||
        !Number.isSafeInteger(item.substitution_index) ||
        (item.item_status === "PERMITTED_SUBSTITUTION"
          ? (item.substitution_index as number) < 0 || (manifestItem !== undefined && (item.substitution_index as number) >= manifestItem.permitted_substitutions.length)
          : item.substitution_index !== -1) ||
        !Array.isArray(item.condition_statuses) ||
        (manifestItem !== undefined && (
          item.item_id !== manifestItem.item_id ||
          item.condition_statuses.length !== manifestItem.conditions.length
        ))
      ) throw new TypeError(`${path}.item_observations[${itemIndex}] is malformed`);
      itemIds.add(item.item_id);
      for (const [conditionIndex, condition] of item.condition_statuses.entries()) {
        if (
          !isPlainObject(condition) ||
          !hasExactKeys(condition, ["condition_index", "status"]) ||
          condition.condition_index !== conditionIndex ||
          !valueIn(CONDITION_STATUS_OPTIONS, condition.status)
        ) throw new TypeError(`${path}.item_observations[${itemIndex}].condition_statuses is malformed`);
      }
    }
    return;
  }
  if (value.effective_action === "PICKED_UP") {
    if (!hasExactKeys(value, ["effective_action", "pickup_observation"]) || !valueIn(PICKUP_OBSERVATION_OPTIONS, value.pickup_observation)) {
      throw new TypeError(`${path} PICKED_UP facts are malformed`);
    }
    return;
  }
  if (value.effective_action === "DELIVERED") {
    if (!hasExactKeys(value, ["delivery_observation", "effective_action"]) || !valueIn(DELIVERY_OBSERVATION_OPTIONS, value.delivery_observation)) {
      throw new TypeError(`${path} DELIVERED facts are malformed`);
    }
    return;
  }
  if (
    !hasExactKeys(value, ["claim_category", "criterion_index", "criterion_kind", "effective_action", "item_id"]) ||
    typeof value.item_id !== "string" || !value.item_id ||
    !valueIn(CLAIM_CATEGORY_OPTIONS, value.claim_category) ||
    !valueIn(CLAIM_CRITERION_KIND_OPTIONS, value.criterion_kind) ||
    !Number.isSafeInteger(value.criterion_index) ||
    (value.criterion_kind === "DELIVERY" ? value.criterion_index !== -1 : (value.criterion_index as number) < 0)
  ) throw new TypeError(`${path} CUSTOMER_CLAIM facts are malformed`);
}

function correctionSlots(document: EvidenceDocument): Array<[CorrectionEffectiveAction, string]> {
  if (document.action === "CURE" || document.action === "APPEAL") {
    if (!Array.isArray(document.statements)) throw new TypeError("target batch statements are missing");
    return document.statements.map((statement, index) => {
      assertCorrectionStatement(statement, `target.statements[${index}]`);
      return [statement.effective_action, statement.effective_action === "CUSTOMER_CLAIM" ? statement.item_id : ""];
    });
  }
  if (!correctionActions.has(document.action as CorrectionEffectiveAction)) {
    throw new TypeError("a correction target must have a semantic evidence action");
  }
  return [[document.action as CorrectionEffectiveAction, document.action === "CUSTOMER_CLAIM" ? document.item_id ?? "" : ""]];
}

function validateBatchCorrection(
  value: Record<string, unknown>,
  targets?: readonly EvidenceDocument[],
  manifestItems?: readonly OrderItem[],
): void {
  assertExactEvidenceFields(value, ["statements", "supersedes_evidence_indices"]);
  if (
    value.item_id !== undefined ||
    !Array.isArray(value.supersedes_evidence_indices) || value.supersedes_evidence_indices.length === 0 ||
    !Array.isArray(value.statements) || value.statements.length === 0 || value.statements.length > MAX_ACTIVE_EVIDENCE
  ) throw new TypeError("typed corrective evidence is required");
  const directTargets = value.supersedes_evidence_indices as unknown[];
  const statements = value.statements as unknown[];
  let previous = -1;
  for (const target of directTargets) {
    if (!Number.isSafeInteger(target) || (target as number) <= previous) throw new TypeError("correction targets must be strictly increasing safe integers");
    previous = target as number;
  }
  statements.forEach((statement, index) => assertCorrectionStatement(statement, `statements[${index}]`, manifestItems));
  const expectedSlots = targets
    ? targets.flatMap(correctionSlots)
    : directTargets.map((_target, index) => {
        const statement = statements[index] as CorrectionStatement | undefined;
        return statement ? [statement.effective_action, statement.effective_action === "CUSTOMER_CLAIM" ? statement.item_id : ""] : null;
      }).filter((slot): slot is [CorrectionEffectiveAction, string] => slot !== null);
  if (targets && targets.length !== directTargets.length) throw new TypeError("authoritative correction targets do not match direct target indices");
  if (targets && expectedSlots.length !== statements.length) throw new TypeError("correction target slots and statements must have equal length");
  expectedSlots.forEach(([action, itemId], index) => {
    const statement = statements[index] as CorrectionStatement;
    const actualItemId = statement.effective_action === "CUSTOMER_CLAIM" ? statement.item_id : "";
    if (statement.effective_action !== action || actualItemId !== itemId) throw new TypeError("correction statements must preserve ordered semantic slots");
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertJsonValue(value: unknown, path: string, ancestors = new WeakSet<object>()): asserts value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (Number.isSafeInteger(value)) return;
    throw new TypeError(`${path} must be a safe integer, not a floating-point amount`);
  }
  if (typeof value !== "object") throw new TypeError(`${path} must be JSON-compatible`);
  if (ancestors.has(value)) throw new TypeError(`${path} must not contain a cycle`);
  ancestors.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!(index in value)) throw new TypeError(`${path} must not be a sparse array`);
      assertJsonValue(value[index], `${path}[${index}]`, ancestors);
    }
  } else if (isPlainObject(value)) {
    for (const [key, item] of Object.entries(value)) assertJsonValue(item, `${path}.${key}`, ancestors);
  } else {
    throw new TypeError(`${path} must contain plain JSON objects only`);
  }
  ancestors.delete(value);
}

function assertOrderItem(value: unknown, index: number): asserts value is OrderItem {
  if (!isPlainObject(value)) throw new TypeError(`items[${index}] must be an object`);
  if (Object.keys(value).sort().join(",") !== "conditions,item_id,name,permitted_substitutions,price_wei,quantity") {
    throw new TypeError(`items[${index}] must use the exact order-item schema`);
  }
  for (const field of ["item_id", "name", "price_wei"] as const) {
    if (typeof value[field] !== "string" || value[field].length === 0) {
      throw new TypeError(`items[${index}].${field} must be a non-empty string`);
    }
  }
  if (!Number.isSafeInteger(value.quantity) || (value.quantity as number) <= 0) {
    throw new TypeError(`items[${index}].quantity must be a positive integer`);
  }
  for (const field of ["permitted_substitutions", "conditions"] as const) {
    if (!Array.isArray(value[field]) || !value[field].every((entry) => typeof entry === "string")) {
      throw new TypeError(`items[${index}].${field} must be an array of strings`);
    }
  }
}

function assertExactEvidenceFields(
  value: Record<string, unknown>,
  requiredActionFields: string[],
  optionalActionFields: string[] = [],
): void {
  const allowed = new Set([...baseEvidenceFields, ...requiredActionFields, ...optionalActionFields]);
  if (Object.keys(value).some((field) => !allowed.has(field))) {
    throw new TypeError("evidence contains a field outside its exact action schema");
  }
  if (requiredActionFields.some((field) => !(field in value))) {
    throw new TypeError("evidence is missing an action-specific typed fact");
  }
}

function validateActionSchema(
  value: Record<string, unknown>,
  action: EvidenceAction,
  manifestItems?: readonly OrderItem[],
): void {
  if (action === "ORDER_MANIFEST") {
    assertExactEvidenceFields(value, ["items"]);
    if (!Array.isArray(value.items) || value.items.length === 0) throw new TypeError("items must be a non-empty array");
    value.items.forEach(assertOrderItem);
    return;
  }
  if (action === "PACKED") {
    assertExactEvidenceFields(value, ["item_observations"]);
    if (!Array.isArray(value.item_observations) || value.item_observations.length === 0) {
      throw new TypeError("PACKED evidence requires item_observations");
    }
    const ids = new Set<string>();
    for (const observation of value.item_observations) {
      if (
        !isPlainObject(observation) ||
        Object.keys(observation).sort().join(",") !== "item_id,observation" ||
        typeof observation.item_id !== "string" || !observation.item_id || ids.has(observation.item_id) ||
        typeof observation.observation !== "string" || !packedObservationCodes.has(observation.observation)
      ) throw new TypeError("PACKED evidence item_observations are malformed");
      ids.add(observation.item_id);
    }
    return;
  }
  if (action === "DELIVERED") {
    assertExactEvidenceFields(value, ["delivery_observation"]);
    if (typeof value.delivery_observation !== "string" || !deliveryObservationCodes.has(value.delivery_observation)) {
      throw new TypeError("DELIVERED evidence delivery_observation is malformed");
    }
    return;
  }
  if (action === "CUSTOMER_CLAIM") {
    assertExactEvidenceFields(value, ["claim_category", "item_id"]);
    if (
      typeof value.item_id !== "string" || !value.item_id ||
      typeof value.claim_category !== "string" || !claimCategoryCodes.has(value.claim_category)
    ) throw new TypeError("CUSTOMER_CLAIM evidence typed facts are malformed");
    return;
  }
  if (action === "CURE" || action === "APPEAL") {
    validateBatchCorrection(value, undefined, manifestItems);
    return;
  }
  assertExactEvidenceFields(value, []);
}

function parseTimestamp(value: string, field: string): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw new TypeError(`${field} must be an ISO-8601 UTC timestamp`);
  }
  return timestamp;
}

function validateEvidenceShape(value: unknown, manifestItems?: readonly OrderItem[]): EvidenceDocument {
  if (!isPlainObject(value)) throw new TypeError("evidence must be a plain object");
  assertJsonValue(value, "evidence");
  if (value.schema_version !== "foodguard-evidence/1") {
    throw new TypeError("schema_version must be foodguard-evidence/1");
  }
  if (typeof value.action !== "string" || !evidenceActions.has(value.action as EvidenceAction)) {
    throw new TypeError("action must be a FoodGuard evidence action");
  }
  validateActionSchema(value, value.action as EvidenceAction, manifestItems);
  for (const field of requiredStringFields) {
    if (typeof value[field] !== "string" || value[field].trim().length === 0) {
      throw new TypeError(`${field} must be a non-empty string`);
    }
  }
  if (!/^0x[0-9a-f]{64}$/i.test(value.sha256 as string)) {
    throw new TypeError("sha256 must be a 0x-prefixed SHA-256 digest");
  }
  if (value.item_id !== undefined && (typeof value.item_id !== "string" || value.item_id.length === 0)) {
    throw new TypeError("item_id must be a non-empty string when present");
  }
  return value as EvidenceDocument;
}

function canonicalize(value: JsonValue): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
}

function digestPreimage(value: EvidenceDocument): JsonValue {
  const { sha256, ...withoutDigest } = value;
  void sha256;
  return withoutDigest as JsonValue;
}

function sha256Hex(text: string): HexDigest {
  const bytes = new TextEncoder().encode(text);
  const bitLength = bytes.length * 8;
  const paddedLength = (((bytes.length + 9 + 63) >> 6) << 6);
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const length = BigInt(bitLength);
  for (let index = 0; index < 8; index += 1) padded[padded.length - 1 - index] = Number((length >> BigInt(index * 8)) & 0xffn);
  const words = new Uint32Array(64);
  const hash = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const constants = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) words[index] = (padded[offset + index * 4] << 24) | (padded[offset + index * 4 + 1] << 16) | (padded[offset + index * 4 + 2] << 8) | padded[offset + index * 4 + 3];
    for (let index = 16; index < 64; index += 1) { const a = words[index - 15]; const b = words[index - 2]; words[index] = (((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3)) + words[index - 7] + (((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10)) + words[index - 16]; }
    let [a,b,c,d,e,f,g,h] = hash;
    for (let index = 0; index < 64; index += 1) { const s1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7)); const choice = (e & f) ^ (~e & g); const temp1 = h + s1 + choice + constants[index] + words[index]; const s0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10)); const majority = (a & b) ^ (a & c) ^ (b & c); [h,g,f,e,d,c,b,a] = [g,f,e,(d + temp1) >>> 0,c,b,a,(temp1 + s0 + majority) >>> 0]; }
    hash[0] = (hash[0] + a) >>> 0; hash[1] = (hash[1] + b) >>> 0; hash[2] = (hash[2] + c) >>> 0; hash[3] = (hash[3] + d) >>> 0; hash[4] = (hash[4] + e) >>> 0; hash[5] = (hash[5] + f) >>> 0; hash[6] = (hash[6] + g) >>> 0; hash[7] = (hash[7] + h) >>> 0;
  }
  return `0x${Array.from(hash, (word) => word.toString(16).padStart(8, "0")).join("")}`;
}

export function validateEvidenceDocument<T extends EvidenceDocument>(
  value: T,
  now?: Date,
  correctionTargets?: readonly EvidenceDocument[],
  manifestItems?: readonly OrderItem[],
): T;
export function validateEvidenceDocument(
  value: unknown,
  now?: Date,
  correctionTargets?: readonly EvidenceDocument[],
  manifestItems?: readonly OrderItem[],
): EvidenceDocument;
export function validateEvidenceDocument(
  value: unknown,
  now = new Date(),
  correctionTargets?: readonly EvidenceDocument[],
  manifestItems?: readonly OrderItem[],
): EvidenceDocument {
  const evidence = validateEvidenceShape(value);
  if (evidence.action === "CURE" || evidence.action === "APPEAL") {
    validateBatchCorrection(evidence as unknown as Record<string, unknown>, correctionTargets, manifestItems);
  }
  const observedAt = parseTimestamp(evidence.observed_at, "observed_at");
  const submittedAt = parseTimestamp(evidence.submitted_at, "submitted_at");
  const expiresAt = parseTimestamp(evidence.expires_at, "expires_at");
  if (observedAt > submittedAt || submittedAt > expiresAt) throw new TypeError("evidence timestamps must be ordered");
  if (expiresAt <= now.getTime()) throw new TypeError("evidence has expired");
  if (evidence.sha256.toLowerCase() !== sha256Hex(canonicalize(digestPreimage(evidence)))) {
    throw new TypeError("sha256 does not bind the canonical evidence preimage");
  }
  return evidence;
}

export function canonicalizeEvidence(value: EvidenceDocument, manifestItems?: readonly OrderItem[]): string {
  return canonicalize(digestPreimage(validateEvidenceShape(value, manifestItems)));
}

export function canonicalizeEvidenceEnvelope(value: EvidenceDocument, manifestItems?: readonly OrderItem[]): string {
  return canonicalize(validateEvidenceShape(value, manifestItems) as JsonValue);
}

export async function hashEvidence(value: EvidenceDocument, manifestItems?: readonly OrderItem[]): Promise<HexDigest> {
  const bytes = new TextEncoder().encode(canonicalizeEvidence(value, manifestItems));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `0x${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
