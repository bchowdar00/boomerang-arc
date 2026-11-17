import type { Ctx } from "../app/context.ts";
import { hrefFor } from "../app/route.ts";
import { campaignIn } from "../app/world.ts";
import { finalizeCall } from "../flows/calls.ts";
import { Band } from "../ui/Board.tsx";
import { Chart } from "../ui/Chart.tsx";
import { Feed, Rows, Section, SendStatus } from "../ui/parts.tsx";
import { PledgeBox } from "../ui/PledgeBox.tsx";
import { agoOf, settledLine } from "../views/board.ts";
import { campaignPage, noSuchCampaign } from "../views/campaign.ts";
import { feedView } from "../views/feed.ts";
import { WORDS } from "../views/shell.ts";

export function Missing({ ctx, id }: { ctx: Ctx; id: bigint }) {
  const page = noSuchCampaign(id, ctx.world.count);
  return (
    <section>
      <h1>{page.title}</h1>
      <p>{page.line}</p>
      <p>
        <a href={page.homeHref}>{WORDS.campaign.back}</a>
      </p>
    </section>
  );
}

/** The campaign page. `focus` puts the cursor in the amount field (the old Pledge page's address). */
export function Campaign({ ctx, id, focus = false }: { ctx: Ctx; id: bigint; focus?: boolean }) {
  const { world, config } = ctx;
  const campaign = campaignIn(world, id);
  if (!campaign) return <Missing ctx={ctx} id={id} />;
  const page = campaignPage({ campaign, labels: ctx.labels, desk: config.desk, now: world.now, block: world.block });
  const ledger = world.keeper.up ? world.keeper.ledger : null;
  const feed = feedView({ ledger, campaign: id, limit: 4 });
  const key = `settle:${id}`;
  const sending = ctx.sendState(key);
  const taking = page.phase === "early" || page.phase === "open" || page.phase === "waiting";

  return (
    <article className={`campaign phase-${page.phase}`}>
      <p>
        <a className="back" href={hrefFor({ page: "home" })}>
          {WORDS.campaign.back}
        </a>
      </p>
      <header className="camp-head">
        <h1>{page.name.title}</h1>
        <p className="by">{page.name.by}</p>
        {page.name.about ? <p className="about">{page.name.about}</p> : null}
        {page.name.example ? <p className="tag">{page.name.labelled ? WORDS.campaign.example : WORDS.campaign.demo}</p> : null}
      </header>

      <div className="board">
        <Band campaign={campaign} now={world.now} />
        <div className="board-body">
          <Chart campaign={campaign} ledger={ledger} now={world.now} raised={page.raised} backers={page.backers} live={page.phase === "early" || page.phase === "open"} />
          {taking ? (
            <PledgeBox ctx={ctx} campaign={campaign} focus={focus} />
          ) : (
            <section className="receipt">
              <p className="receipt-status">{page.status}</p>
              {settledLine(campaign) ? <p className="receipt-one">{settledLine(campaign)}</p> : null}
              <p className="receipt-line">{page.promise}</p>
              {page.settle ? (
                <div className="settle">
                  {ctx.account ? (
                    <button type="button" className="go" disabled={!ctx.maySend} onClick={() => void ctx.send(key, [finalizeCall({ boomerang: config.boomerang, id })])}>
                      {page.settle.button}
                    </button>
                  ) : null}
                  <p className="quiet">{page.settle.note}</p>
                  <SendStatus state={sending} />
                </div>
              ) : page.pledgeWhy ? (
                <p className="quiet">{page.pledgeWhy}</p>
              ) : null}
            </section>
          )}
        </div>
      </div>

      {taking ? <p className="rule">{page.promise}</p> : null}

      <div className="under">
        <Section title={WORDS.campaign.feed}>
          <Feed feed={feed} explorer={config.chain.explorer} ago={agoOf(ledger, world.now)} />
        </Section>
        <Section title={WORDS.campaign.terms}>
          <Rows rows={page.rows} explorer={config.chain.explorer} />
          <p className="control">{page.control}</p>
          <p className="quiet">{page.name.labelled ? WORDS.campaign.siteWords : page.name.example ? WORDS.campaign.deskWords : WORDS.campaign.chainWords}</p>
        </Section>
      </div>
    </article>
  );
}
