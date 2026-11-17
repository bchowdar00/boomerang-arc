// The pledge box's receipt: the two outcomes of one pledge, side by side, before it is sent.
// Built from the form's quote (the contract's own answer once it arrives), never from new sums.
import type { CampaignView } from "../data/load.ts";
import { about, formatUsd } from "../data/money.ts";
import type { PledgeForm } from "./pledge.ts";

export type Half = { heading: string; figure: string; line: string };
export type ReceiptView = { kind: "two"; met: Half; missed: Half & { live: boolean } } | { kind: "completes"; line: string } | { kind: "none"; line: string };

export function receiptView(o: { form: PledgeForm; campaign: CampaignView }): ReceiptView {
  const q = o.form.quote;
  if (q === null || q.kind === "refused" || o.form.amount === null) return { kind: "none", line: o.form.line };
  if (q.kind === "completes") return { kind: "completes", line: q.line };

  const match = o.campaign.terms.matchAmount;
  const met: Half = {
    heading: "If the target is met",
    figure: `${formatUsd(q.counted)} USDC`,
    line: match > 0n ? `goes to the recipient, and the sponsor adds its ${formatUsd(match)} USDC match.` : "goes to the recipient.",
  };
  const line =
    q.bonus > 0n
      ? `comes back to you: your ${formatUsd(o.form.amount)} plus ${about(q.bonus)}${q.early ? " for backing early" : ""}.`
      : q.early
        ? "comes back to you in full."
        : "comes back to you in full. The early bonus window has closed.";
  return { kind: "two", met, missed: { heading: "If it falls short", figure: `${formatUsd(q.back)} USDC`, line, live: q.early && q.bonus > 0n } };
}
