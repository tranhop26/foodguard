"use client";

import type { OrderState } from "../../lib/domain";
import { useLocale } from "../../lib/i18n";
import type { OrderDetailView } from "./ItemOutcomeTable";

const orderStates: OrderState[] = [
  "FUNDED",
  "PARTIALLY_ACCEPTED",
  "ACCEPTED",
  "READY_FOR_PICKUP",
  "IN_TRANSIT",
  "REVIEW_WINDOW",
  "RESOLVING",
  "EVIDENCE_CURE",
  "RESOLVED",
  "APPEALED",
  "ESCALATED",
  "SETTLED",
  "CANCELLED_REFUNDED",
];

const deadlineFields = [
  "acceptance_deadline",
  "packing_deadline",
  "delivery_deadline",
  "review_deadline",
  "appeal_deadline",
] as const;

function rawDeadline(value: unknown): string | null {
  if (typeof value === "bigint" && value >= 0n) return value.toString();
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value)) return value;
  return null;
}

export function OrderTimeline({ order }: { order: OrderDetailView }) {
  const { copy } = useLocale();

  return (
    <section className="order-card" aria-labelledby="timeline-title">
      <h2 id="timeline-title">{copy.detail.timeline}</h2>
      <ol className="order-timeline">
        {orderStates.map((state) => (
          <li data-active={state === order.state || undefined} key={state}>
            <code aria-current={state === order.state ? "step" : undefined}>{state}</code>
          </li>
        ))}
      </ol>
      <dl className="order-deadlines">
        {deadlineFields.map((field) => {
          const value = rawDeadline(order[field]);
          if (value === null) return null;
          return (
            <div key={field}>
              <dt>{copy.detail.deadlineLabels[field]}</dt>
              <dd><code>{value}</code> <span>{copy.detail.unixSecondsUtc}</span></dd>
            </div>
          );
        })}
      </dl>
    </section>
  );
}

