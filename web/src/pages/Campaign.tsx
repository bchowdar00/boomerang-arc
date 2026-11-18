import type { Ctx } from "../app/context.ts";
import { hrefFor } from "../app/route.ts";
import { campaignIn } from "../app/world.ts";
import { finalizeCall } from "../flows/calls.ts";
import { Band, OutcomeStamp } from "../ui/Board.tsx";
import { Chart } from "../ui/Chart.tsx";
import { Cheque } from "../ui/Cheque.tsx";
import { Feed, Rows, Section, SendStatus } from "../ui/parts.tsx";
import { agoOf, boardView, settledLine } from "../views/board.ts";
import { campaignPage, noSuchCampaign } from "../views/campaign.ts";
import { feedView } from "../views/feed.ts";
import { WORDS } from "../views/shell.ts";

export function Missing({ ctx, id }: { ctx: Ctx; id: bigint }) {
  const page = noSuchCampaign(id, ctx.world.count);
  return (
    <section className="lost">
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
  const board = boardView({ campaign, now: world.now });
  const ledger = world.keeper.up ? world.keeper.ledger : null;
  const feed = feedView({ ledger, campaign: id, limit: 4 });
  const key = `settle:${id}`;
  const sending = ctx.sendState(key);
  const taking = page.phase === "early" || page.phase === "open" || page.phase === "waiting";
  const live = page.phase === "early" || page.phase === "open";
  const settled = settledLine(campaign);
  // The stamp lands only once the outcome is final; a campaign still waiting to be settled shows none.
  const showStamp = board.result !== null && !page.settle;

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

      <div className="camp-body">
        <div className="camp-main">
          <Band campaign={campaign} now={world.now} />
          <div className="camp-chart">
            <Chart campaign={campaign} ledger={ledger} now={world.now} raised={page.raised} backers={page.backers} live={live} />
          </div>
        </div>
        <div className="camp-side">
          {taking ? (
            <Cheque ctx={ctx} campaign={campaign} focus={focus} />
          ) : (
            <section className="voucher">
              {showStamp && board.result ? <OutcomeStamp result={board.result} /> : null}
              <p className="voucher-status">{page.status}</p>
              {settled ? <p className="voucher-figure">{settled}</p> : null}
              <p className="voucher-promise">{page.promise}</p>
              {page.settle ? (
                <div className="settle">
                  {ctx.account ? (
                    <button type="button" className="btn btn-ink" disabled={!ctx.maySend} onClick={() => void ctx.send(key, [finalizeCall({ boomerang: config.boomerang, id })])}>
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

      {taking ? <p className="promise">{page.promise}</p> : null}

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
