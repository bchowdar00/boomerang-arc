import type { Ctx } from "../app/context.ts";
import { ownIn } from "../app/world.ts";
import { payCall } from "../flows/calls.ts";
import { Rows, Section, SendStatus } from "../ui/parts.tsx";
import { minePage } from "../views/mine.ts";
import { WORDS } from "../views/shell.ts";

export function Mine({ ctx }: { ctx: Ctx }) {
  const { world, config } = ctx;
  // The pledges read belong to `world.account`; until a read for the connected account arrives, show nothing of another's.
  const own = ownIn(world, ctx.account);
  const account = own.known ? ctx.account : null;
  const page = minePage({ account, mine: own.mine, labels: ctx.labels, desk: config.desk, block: world.block });

  return (
    <article className="mine">
      <h1>{WORDS.mine.title}</h1>
      {page.account ? <p className="by">{page.account}</p> : null}
      {ctx.account !== null && account === null ? <p className="quiet">{WORDS.loading}</p> : null}
      {page.empty && !(ctx.account !== null && account === null) ? (
        <p>
          {page.empty}{" "}
          {ctx.account === null ? (
            <button type="button" onClick={ctx.connect}>
              {WORDS.connect}
            </button>
          ) : null}
        </p>
      ) : null}

      {page.rows.length > 0 ? (
        <ul className="pledges">
          {page.rows.map((r) => {
            const key = r.send ? `pay:${r.send.campaign}` : "";
            return (
              <li key={r.href} className={`pledge-row kind-${r.kind}`}>
                <a href={r.href}>{r.title}</a>
                <p>{r.line}</p>
                {r.refundTo ? <p className="quiet">{r.refundTo}</p> : null}
                {r.send && account ? (
                  <div>
                    <button type="button" disabled={!ctx.maySend} onClick={() => void ctx.send(key, [payCall({ boomerang: config.boomerang, id: r.send!.campaign, backer: account })])}>
                      {r.send.button}
                    </button>
                    <p className="quiet">{r.send.note}</p>
                    <SendStatus state={ctx.sendState(key)} />
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}

      {page.totals.length > 0 ? (
        <Section title={WORDS.mine.totals}>
          <Rows rows={page.totals} explorer={null} />
        </Section>
      ) : null}
    </article>
  );
}
