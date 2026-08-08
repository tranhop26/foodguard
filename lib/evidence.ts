import type {
  EvidenceAction,
  EvidenceDocument,
  HexDigest,
  JsonValue,
  OrderItem,
} from "./domain";

export type { EvidenceDocument, HexDigest, OrderItem } from "./domain";

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

function validateActionSchema(value: Record<string, unknown>, action: EvidenceAction): void {
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
    assertExactEvidenceFields(value, [], ["item_id"]);
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

function validateEvidenceShape(value: unknown): EvidenceDocument {
  if (!isPlainObject(value)) throw new TypeError("evidence must be a plain object");
  assertJsonValue(value, "evidence");
  if (value.schema_version !== "foodguard-evidence/1") {
    throw new TypeError("schema_version must be foodguard-evidence/1");
  }
  if (typeof value.action !== "string" || !evidenceActions.has(value.action as EvidenceAction)) {
    throw new TypeError("action must be a FoodGuard evidence action");
  }
  validateActionSchema(value, value.action as EvidenceAction);
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

export function validateEvidenceDocument(value: unknown, now = new Date()): EvidenceDocument {
  const evidence = validateEvidenceShape(value);
  const observedAt = parseTimestamp(evidence.observed_at, "observed_at");
  const submittedAt = parseTimestamp(evidence.submitted_at, "submitted_at");
  const expiresAt = parseTimestamp(evidence.expires_at, "expires_at");
  if (observedAt > submittedAt || submittedAt > expiresAt) throw new TypeError("evidence timestamps must be ordered");
  if (expiresAt < now.getTime()) throw new TypeError("evidence has expired");
  if (evidence.sha256.toLowerCase() !== sha256Hex(canonicalize(digestPreimage(evidence)))) {
    throw new TypeError("sha256 does not bind the canonical evidence preimage");
  }
  return evidence;
}

export function canonicalizeEvidence(value: EvidenceDocument): string {
  return canonicalize(digestPreimage(validateEvidenceShape(value)));
}

export function canonicalizeEvidenceEnvelope(value: EvidenceDocument): string {
  return canonicalize(validateEvidenceShape(value) as JsonValue);
}

export async function hashEvidence(value: EvidenceDocument): Promise<HexDigest> {
  const bytes = new TextEncoder().encode(canonicalizeEvidence(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `0x${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
