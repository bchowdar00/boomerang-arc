import type { Ctx } from "../app/context.ts";
import { Rows, Section } from "../ui/parts.tsx";
import { proofPage } from "../views/proof.ts";
import { WORDS } from "../views/shell.ts";

// A verdict holds, fails, or cannot be told yet. A drawn check reads for the first, a cross for the
// second, a dash for the third; the colour comes from the verdict line's own state class.
const HOLDS = new Set(["ok", "agrees"]);
const FAILS = new Set(["short", "differs", "ahead"]);

function Mark({ state }: { state: string }) {
  if (HOLDS.has(state)) {
    return (
      <svg className="vmark" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M3 8.5 6.5 12 13 4.2" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (FAILS.has(state)) {
    return (
      <svg className="vmark" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M4 4 12 12M12 4 4 12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg className="vmark" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M4 8 12 8" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

export function Proof({ ctx }: { ctx: Ctx }) {
  const { world, config } = ctx;
  const page = proofPage({
    custody: world.custody,
    campaigns: world.campaigns,
    count: world.count,
    ledger: world.keeper.up ? world.keeper.ledger : null,
    health: world.keeper.up ? world.keeper.health : null,
    backerChecks: world.backerChecks,
    backerTotal: world.backerTotal,
    where: { boomerang: config.boomerang, usdc: config.usdc, router: config.router },
  });

  return (
    <article className="proof">
      <h1>{WORDS.proof.title}</h1>

      <Section title={WORDS.proof.custody}>
        <p className={`verdict verdict-${page.custody.state}`}>
          <Mark state={page.custody.state} />
          {page.custody.line}
        </p>
        {page.custody.detail ? <p className="quiet">{page.custody.detail}</p> : null}
      </Section>

      <Section title={WORDS.proof.second}>
        <p className={`verdict verdict-${page.second.state}`}>
          <Mark state={page.second.state} />
          {page.second.line}
        </p>
        {page.second.differences.length > 0 ? (
          <ul className="differences">
            {page.second.differences.map((d) => (
              <li key={d}>{d}</li>
            ))}
          </ul>
        ) : null}
      </Section>

      {page.stream ? (
        <Section title={WORDS.proof.stream}>
          <Rows rows={page.stream} explorer={null} />
        </Section>
      ) : null}

      {page.keeperErrors.length > 0 ? (
        <Section title={WORDS.proof.errors}>
          <ul className="differences">
            {page.keeperErrors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        </Section>
      ) : null}

      <Section title={WORDS.proof.facts}>
        <Rows rows={page.facts} explorer={config.chain.explorer} />
      </Section>

      <Section title={WORDS.proof.yourself}>
        <p className="proof-line">{page.yourself.line}</p>
        <pre>
          <code>{page.yourself.commands.join("\n")}</code>
        </pre>
      </Section>

      <Section title={WORDS.proof.limits}>
        <ul className="limits">
          {page.limits.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      </Section>
    </article>
  );
}
