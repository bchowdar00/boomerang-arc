// The board's band: three plates while the campaign takes pledges or waits, a result flag and two
// plates once it is over. A changed total is announced once to screen readers, never on load.
import { useState } from "react";

import type { CampaignView } from "../data/load.ts";
import { formatUsd } from "../data/money.ts";
import { boardView } from "../views/board.ts";
import { Plate } from "./Plate.tsx";

export function Band({ campaign, now }: { campaign: CampaignView; now: bigint }) {
  const b = boardView({ campaign, now });
  const total = campaign.state.pledged;
  const [seen, setSeen] = useState(total);
  const [said, setSaid] = useState("");
  if (seen !== total) {
    setSeen(total);
    setSaid(`${formatUsd(total)} of ${formatUsd(campaign.terms.target)} USDC pledged.`);
  }
  return (
    <>
      <div className={`band${b.result ? " settled" : ""}`}>
        {b.result ? (
          <div className={`plate flag flag-${b.result.kind}`}>
            <span className="flag-word">{b.result.flag}</span>
            <p className="flag-line">{b.result.line}</p>
          </div>
        ) : null}
        {b.plates.map((p) => (
          <Plate plate={p} key={p.key} />
        ))}
      </div>
      <p className="sr-only" role="status" aria-atomic="true">
        {said}
      </p>
    </>
  );
}
