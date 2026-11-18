// The keeper's GET /health, read strictly. Its text fields (errors the keeper recorded) are the
// keeper's words and are only ever shown as plain text, cut short.
import type { Address } from "../../../packages/kit/src/index.ts";

export type HealthView = {
  lastSeq: bigint;
  missing: { from: bigint; to: bigint } | null;
  pending: number;
  repeats: number;
  lastBlock: number;
  lastTime: bigint;
  /** The keeper machine's wall time at its last delivery, in milliseconds; null before the first. */
  lastDeliveryAt: number | null;
  lastBeatBlock: number | null;
  kvError: string | null;
  deliveries: number;
  sent: number;
  failedSends: number;
  rejected: number;
  gaveUp: string[];
  lastErrors: string[];
  settled: boolean;
  desk: Address | null;
  /** The helper the keeper relays one-signature pledges through; null when it relays none (or says nothing of it). */
  relay: Address | null;
  /** Up to twenty campaign numbers the keeper's events name that the contract says it does not have; none when the keeper sends no list. */
  absent: bigint[];
};

const fail = (path: string, want: string): never => {
  throw new Error(`the keeper's health has no ${want} at ${path}`);
};
const big = (v: unknown, path: string): bigint => (typeof v === "string" && /^\d+$/.test(v) ? BigInt(v) : fail(path, "whole number"));
const num = (v: unknown, path: string): number => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : fail(path, "count"));
const numOrNull = (v: unknown, path: string): number | null => (v === null ? null : num(v, path));
// Bidi controls and zero-width characters, removed; C0/C1 control characters and DEL, turned to a space.
const STRIP = /[\u{200e}\u{200f}\u{202a}-\u{202e}\u{2066}-\u{2069}\u{200b}-\u{200d}\u{feff}]/gu;
const CONTROL = /[\u{0}-\u{1f}\u{7f}-\u{9f}]/gu;
const text = (v: unknown): string => String(v).replace(STRIP, "").replace(CONTROL, " ").slice(0, 200);
const texts = (v: unknown, path: string): string[] => (Array.isArray(v) ? v.slice(-20).map(text) : fail(path, "list"));

/** Read what GET /health returned. Throws if a field the page relies on is missing or of the wrong kind. */
export function readHealth(json: unknown): HealthView {
  if (json === null || typeof json !== "object" || Array.isArray(json)) return fail("health", "object");
  const h = json as Record<string, unknown>;
  const m = h.missing;
  const missing = m === null ? null : m !== undefined && typeof m === "object" ? { from: big((m as Record<string, unknown>).from, "missing.from"), to: big((m as Record<string, unknown>).to, "missing.to") } : fail("missing", "range or null");
  return {
    lastSeq: big(h.lastSeq, "lastSeq"),
    missing,
    pending: num(h.pending, "pending"),
    repeats: num(h.repeats, "repeats"),
    lastBlock: num(h.lastBlock, "lastBlock"),
    lastTime: big(h.lastTime, "lastTime"),
    lastDeliveryAt: numOrNull(h.lastDeliveryAt, "lastDeliveryAt"),
    lastBeatBlock: numOrNull(h.lastBeatBlock, "lastBeatBlock"),
    kvError: h.kvError === null ? null : typeof h.kvError === "string" ? text(h.kvError) : fail("kvError", "text or null"),
    deliveries: num(h.deliveries, "deliveries"),
    sent: num(h.sent, "sent"),
    failedSends: num(h.failedSends, "failedSends"),
    rejected: num(h.rejected, "rejected"),
    gaveUp: texts(h.gaveUp, "gaveUp"),
    lastErrors: texts(h.lastErrors, "lastErrors"),
    settled: typeof h.settled === "boolean" ? h.settled : fail("settled", "yes/no"),
    absent: h.absent === undefined ? [] : Array.isArray(h.absent) ? h.absent.slice(0, 20).map((v, i) => big(v, `absent[${i}]`)) : fail("absent", "list"),
    desk: h.desk === null ? null : typeof h.desk === "string" && /^0x[0-9a-fA-F]{40}$/.test(h.desk) ? (h.desk as Address) : fail("desk", "address or null"),
    relay: h.relay === undefined || h.relay === null ? null : typeof h.relay === "string" && /^0x[0-9a-fA-F]{40}$/.test(h.relay) ? (h.relay as Address) : fail("relay", "address or null"),
  };
}
