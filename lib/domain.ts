export type OrderState =
  | "FUNDED"
  | "PARTIALLY_ACCEPTED"
  | "ACCEPTED"
  | "READY_FOR_PICKUP"
  | "IN_TRANSIT"
  | "REVIEW_WINDOW"
  | "RESOLVING"
  | "EVIDENCE_CURE"
  | "RESOLVED"
  | "APPEALED"
  | "ESCALATED"
  | "SETTLED"
  | "CANCELLED_REFUNDED"
  | "FULFILLMENT_TIMEOUT_REFUNDED";

export type ItemOutcome =
  | "MATCHED"
  | "MISSING"
  | "MISMATCHED"
  | "DELIVERY_FAILED"
  | "UNRESOLVED";

export type DeliveryOutcome = "DELIVERED" | "DELIVERY_FAILED" | "UNRESOLVED";

export type EvidenceAction =
  | "ORDER_MANIFEST"
  | "PACKED"
  | "PICKED_UP"
  | "DELIVERED"
  | "CUSTOMER_CLAIM"
  | "CURE"
  | "APPEAL";

export type CorrectionEffectiveAction = "PACKED" | "PICKED_UP" | "DELIVERED" | "CUSTOMER_CLAIM";

export type PackedItemStatus = "AS_ORDERED" | "PERMITTED_SUBSTITUTION" | "ABSENT" | "DIFFERENT" | "UNKNOWN";
export type QuantityStatus = "EXACT" | "SHORT" | "EXCESS" | "UNKNOWN";
export type ConditionStatus = "MET" | "NOT_MET" | "UNKNOWN";
export type PickupObservation = "PICKUP_CONFIRMED" | "PICKUP_FAILED" | "UNKNOWN";
export type DeliveryObservation = "HANDOFF_CONFIRMED" | "HANDOFF_FAILED" | "UNKNOWN";
export type ClaimCategory = "ABSENT_AT_RECEIPT" | "NOT_AS_ORDERED" | "HANDOFF_NOT_RECEIVED";
export type ClaimCriterionKind = "ITEM" | "SUBSTITUTION" | "CONDITION" | "QUANTITY" | "DELIVERY";

export interface PackedItemObservation {
  item_id: string;
  item_status: PackedItemStatus;
  quantity_status: QuantityStatus;
  substitution_index: number;
  condition_statuses: Array<{
    condition_index: number;
    status: ConditionStatus;
  }>;
}

export type CorrectionStatement =
  | {
      effective_action: "PACKED";
      item_observations: PackedItemObservation[];
    }
  | {
      effective_action: "PICKED_UP";
      pickup_observation: PickupObservation;
    }
  | {
      effective_action: "DELIVERED";
      delivery_observation: DeliveryObservation;
    }
  | {
      effective_action: "CUSTOMER_CLAIM";
      item_id: string;
      claim_category: ClaimCategory;
      criterion_kind: ClaimCriterionKind;
      criterion_index: number;
    };

export interface BatchCorrectionFacts {
  supersedes_evidence_indices: number[];
  statements: CorrectionStatement[];
}

export type HexDigest = `0x${string}`;

export type JsonPrimitive = boolean | null | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface OrderItem {
  item_id: string;
  name: string;
  quantity: number;
  permitted_substitutions: string[];
  price_wei: string;
  conditions: string[];
}

export interface Restaurant {
  restaurant_id: string;
  name: string;
  description: string;
  neighborhood: string;
  categories: string[];
  delivery_time_minutes: [number, number];
  image_src: string;
  image_alt: string;
  featured_item: OrderItem;
}

export interface EvidenceDocument {
  schema_version: "foodguard-evidence/1";
  order_id: string;
  item_id?: string;
  subject: string;
  action: EvidenceAction;
  actor_wallet: string;
  issuer_id: string;
  source_url: string;
  sha256: HexDigest;
  observed_at: string;
  submitted_at: string;
  expires_at: string;
  chain_id: string;
  contract_address: string;
  nonce: string;
  items?: OrderItem[];
  item_observations?: PackedItemObservation[];
  pickup_observation?: PickupObservation;
  delivery_observation?: DeliveryObservation;
  claim_category?: ClaimCategory;
  criterion_kind?: ClaimCriterionKind;
  criterion_index?: number;
  statements?: CorrectionStatement[];
  supersedes_evidence_indices?: number[];
  [key: string]: JsonValue | OrderItem[] | PackedItemObservation[] | CorrectionStatement[] | undefined;
}
