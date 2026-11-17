import { useState } from "react";

import type { Ctx } from "../app/context.ts";
import { hrefFor } from "../app/route.ts";
import type { CampaignView } from "../data/load.ts";
import { Rows, Section } from "../ui/parts.tsx";
import { boardView } from "../views/board.ts";
import { homePage, type Card } from "../views/home.ts";
import { WORDS } from "../views/shell.ts";

/** One line of the out-of-town board: the name, then the board's first two readings, then the status. */
function Score({ card, campaign, now }: { card: Card; campaign: CampaignView | undefined; now: bigint }) {
  const b = campaign ? boardView({ campaign, now }) : null;
  const first = b?.result ? { caption: "", figure: b.result.flag, unit: "", live: false } : (b?.plates[0] ?? null);
  const second = b ? (b.result ? b.plates[0] : b.plates[1]) : null;
  return (
    <li className="score">
      <a href={card.href}>
        <span className="s s-name">
          <span className="s-title">{card.title}</span>
          <span className="s-by">{card.by}</span>
          {card.example ? <span className="tag">{WORDS.home.example}</span> : null}
        </span>
        {[first, second].map((p, i) =>
          p ? (
            <span className={`s${p.live ? " live" : ""}`} key={i}>
              {p.caption ? <span className="caption">{p.caption}</span> : null}
              <span className="s-figure">
                {p.figure}
                {p.unit ? <span className="unit">{p.unit}</span> : null}
              </span>
            </span>
          ) : (
            <span className="s" key={i} />
          ),
        )}
        <span className="s">
          <span className="s-status">{card.status}</span>
          <span className="s-by">{card.raised}</span>
        </span>
      </a>
    </li>
  );
}

export function Home({ ctx }: { ctx: Ctx }) {
  const { world, config } = ctx;
  const page = homePage({ campaigns: world.campaigns, labels: ctx.labels, desk: config.desk, now: world.now, block: world.block });
  const byHref = new Map(world.campaigns.map((c) => [hrefFor({ page: "campaign", id: c.id }), c]));
  const [desk, setDesk] = useState<{ busy: boolean; line: string | null; ok: boolean }>({ busy: false, line: null, ok: false });

  const open = async () => {
    setDesk({ busy: true, line: null, ok: false });
    const answer = await ctx.askForCampaign();
    setDesk({ busy: false, line: answer.line, ok: answer.ok });
    ctx.refresh();
    if (answer.ok && answer.id !== null) window.location.hash = hrefFor({ page: "campaign", id: answer.id });
  };

  return (
    <>
      {page.demo ? (
        <section className="demo">
          <button type="button" onClick={open} disabled={desk.busy}>
            {page.demo.button}
          </button>
          <p className="quiet">{page.demo.note}</p>
          {desk.line ? (
            <p className={desk.ok ? "" : "problem"} role="status">
              {desk.line}
            </p>
          ) : null}
        </section>
      ) : null}

      {page.empty ? <p>{page.empty}</p> : null}

      {page.running.length > 0 ? (
        <Section title={WORDS.home.running}>
          <ul className="scores">
            {page.running.map((c) => (
              <Score card={c} campaign={byHref.get(c.href)} now={world.now} key={c.href} />
            ))}
          </ul>
        </Section>
      ) : null}

      {page.settled.length > 0 ? (
        <Section title={WORDS.home.settled}>
          <ul className="scores">
            {page.settled.map((c) => (
              <Score card={c} campaign={byHref.get(c.href)} now={world.now} key={c.href} />
            ))}
          </ul>
        </Section>
      ) : null}

      <Section title={WORDS.home.totals}>
        <Rows rows={page.totals} explorer={null} />
      </Section>
    </>
  );
}
