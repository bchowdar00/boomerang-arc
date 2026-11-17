import type { Ctx } from "../app/context.ts";
import { Rows, Section } from "../ui/parts.tsx";
import { proofPage } from "../views/proof.ts";
import { WORDS } from "../views/shell.ts";

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
        <p className={`verdict verdict-${page.custody.state}`}>{page.custody.line}</p>
        {page.custody.detail ? <p className="quiet">{page.custody.detail}</p> : null}
      </Section>

      <Section title={WORDS.proof.second}>
        <p className={`verdict verdict-${page.second.state}`}>{page.second.line}</p>
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
        <p>{page.yourself.line}</p>
        <pre>
          <code>{page.yourself.command}</code>
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
