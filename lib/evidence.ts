import type {
  EvidenceAction,
  EvidenceDocument,
  HexDigest,
  JsonValue,
  OrderItem,
} from "./domain";

export type { EvidenceDocument, HexDigest, OrderItem } from "./domain";

const evidenceActions = new Set<EvidenceAction>([
  "ORDER_MANIFEST",
  "PACKED",
  "PICKED_UP",
  "DELIVERED",
  "CUSTOMER_CLAIM",
  "CURE",
  "APPEAL",
]);

const requiredStringFields = [
  "order_id",
  "actor_wallet",
  "issuer_id",
  "source_url",
  "sha256",
  "observed_at",
  "submitted_at",
  "expires_at",
  "chain_id",
  "contract_address",
  "nonce",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertJsonValue(value: unknown, path: string): asserts value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return;
  }
  if (typeof value === "number") {
    if (Number.isSafeInteger(value)) return;
    throw new TypeError(`${path} must be a safe integer, not a floating-point amount`);
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJsonValue(item, `${path}[${index}]`));
    return;
  }
  if (isRecord(value)) {
    Object.entries(value).forEach(([key, item]) => assertJsonValue(item, `${path}.${key}`));
    return;
  }
  throw new TypeError(`${path} must be JSON-compatible`);
}

function assertOrderItem(value: unknown, index: number): asserts value is OrderItem {
  if (!isRecord(value)) throw new TypeError(`items[${index}] must be an object`);
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

export function validateEvidenceDocument(value: unknown): EvidenceDocument {
  if (!isRecord(value)) throw new TypeError("evidence must be an object");
  assertJsonValue(value, "evidence");

  if (value.schema_version !== "foodguard-evidence/1") {
    throw new TypeError("schema_version must be foodguard-evidence/1");
  }
  if (typeof value.action !== "string" || !evidenceActions.has(value.action as EvidenceAction)) {
    throw new TypeError("action must be a FoodGuard evidence action");
  }
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
  if (value.items !== undefined) {
    if (!Array.isArray(value.items)) throw new TypeError("items must be an array");
    value.items.forEach(assertOrderItem);
  }

  return value as EvidenceDocument;
}

function canonicalize(value: JsonValue): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;

  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`)
    .join(",")}}`;
}

export function canonicalizeEvidence(value: EvidenceDocument): string {
  return canonicalize(validateEvidenceDocument(value) as JsonValue);
}

export async function hashEvidence(value: EvidenceDocument): Promise<HexDigest> {
  const bytes = new TextEncoder().encode(canonicalizeEvidence(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `0x${Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("")}`;
}
