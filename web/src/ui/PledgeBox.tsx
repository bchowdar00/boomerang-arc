// The pledge box on the campaign page: the two-part receipt, the amount and the Pledge button.
// The logic is the Pledge page's, moved here unchanged: the contract is asked about what is typed
// a moment after typing stops and at each new block; one submit runs at a time; and just before
// sending the contract is asked again, and a worse answer is shown instead of sent.
//
// When the keeper relays signed pledges, the pledge is one signature in the wallet and no gas.
// If that does not go through, the box says why and the next press sends the two-step pledge.
// Before any pledge, signed or two-step, a signature to this campaign that may still land (the app
// remembers it across reloads and tabs) is waited out, so nobody pledges twice by mistake.
import { useEffect, useRef, useState } from "react";

import type { Ctx } from "../app/context.ts";
import { ownIn } from "../app/world.ts";
import { quotePledge } from "../data/campaign.ts";
import type { CampaignView } from "../data/load.ts";
import { parseUsd } from "../data/money.ts";
import { oneAtATime } from "../flows/calls.ts";
import { pledgeForm, pledgeRoute, requote, stillValidLine, type Answer } from "../views/pledge.ts";
import { receiptView, type Half } from "../views/receipt.ts";
import { deskOffer, WORDS } from "../views/shell.ts";
import { SendStatus } from "./parts.tsx";

/** A receipt figure: when it changes while the typed amount stays the same (a new block, the contract's answer), it rises into place. */
function HalfFigure({ half, typed, live }: { half: Half; typed: string; live: boolean }) {
  const [seen, setSeen] = useState({ figure: half.figure, typed });
  const [bump, setBump] = useState(0);
  if (seen.figure !== half.figure || seen.typed !== typed) {
    if (seen.figure !== half.figure && seen.typed === typed) setBump((b) => b + 1);
    setSeen({ figure: half.figure, typed });
  }
  return (
    <div className={`half${live ? " live" : ""}`}>
      <p className="half-head">{half.heading}</p>
      <p className={`half-figure${bump > 0 ? " fresh" : ""}`} key={bump}>
        {half.figure}
      </p>
      <p className="half-line">{half.line}</p>
    </div>
  );
}

export function PledgeBox({ ctx, campaign, focus }: { ctx: Ctx; campaign: CampaignView; focus: boolean }) {
  const { world, config } = ctx;
  const id = campaign.id;
  const [text, setText] = useState("");
  // The contract's answer, kept with the amount it was asked about and never used for another.
  const [answered, setAnswered] = useState<{ amount: bigint; answer: Answer } | null>(null);
  const [changed, setChanged] = useState<string | null>(null);
  const [desk, setDesk] = useState<{ busy: boolean; line: string | null; ok: boolean }>({ busy: false, line: null, ok: false });
  const asked = useRef(0);
  const field = useRef<HTMLInputElement>(null);
  const once = useRef(oneAtATime()).current; // one submit at a time, its last check included
  // Set once the one-signature pledge has not gone through: this visit then pledges in two steps,
  // and the line says why.
  const [twoStep, setTwoStep] = useState(false);
  const [fellBack, setFellBack] = useState<string | null>(null);

  const typed = text.trim() === "" ? null : parseUsd(text.trim());
  const block = world.block;

  useEffect(() => {
    if (focus) field.current?.focus();
  }, [focus]);

  // Ask the contract about what is typed, a moment after typing stops, and again at each new block.
  useEffect(() => {
    if (typed === null || typed <= 0n) return;
    const mine = ++asked.current;
    const timer = setTimeout(() => {
      ctx
        .quote(id, typed)
        .then((answer) => {
          if (asked.current === mine) setAnswered({ amount: typed, answer });
        })
        .catch(() => {});
    }, 300);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, typed, block]);

  const own = ownIn(world, ctx.account);
  const form = pledgeForm({
    campaign,
    where: { boomerang: config.boomerang, usdc: config.usdc },
    amountText: text,
    now: world.now,
    account: ctx.account,
    balance: own.balance,
    allowance: own.allowance,
    onRightChain: ctx.onRightChain,
    answer: answered !== null && typed !== null && answered.amount === typed ? answered.answer : null,
  });
  const receipt = receiptView({ form, campaign });
  const key = `pledge:${id}`;
  const sending = ctx.sendState(key);
  const offer = deskOffer({ desk: ctx.desk, account: ctx.account });
  const route = pledgeRoute({ signedPledge: config.signedPledge, relay: ctx.relay, fellBack: twoStep });

  const submit = () => {
    const account = ctx.account;
    if (account === null) return ctx.connect();
    const { amount, quote, calls } = form;
    if (!form.canSend || amount === null || quote === null) return;
    void once(async () => {
      setChanged(null);
      // Ask the contract once more. If its answer is no longer what is on the screen, show the
      // new one and stop: the visitor decides again.
      let fresh: Answer;
      try {
        fresh = await ctx.quote(id, amount);
      } catch {
        return;
      }
      const isSponsor = account.toLowerCase() === campaign.state.sponsor.toLowerCase();
      const latest = quotePledge(campaign.terms, campaign.state, amount, world.now, { isSponsor, answer: fresh });
      const now = requote(quote, latest);
      if (!now.same) {
        setAnswered({ amount, answer: fresh });
        setChanged(now.line);
        return;
      }
      // A signature to this campaign that may still land holds every pledge back until it cannot.
      const guard = await ctx.signedGuard(id);
      if (guard.kind === "unknown") {
        setChanged(WORDS.pledge.cannotCheck); // the chain cannot be asked: send nothing rather than risk pledging twice
        return;
      }
      if (guard.kind === "wait") {
        setChanged(stillValidLine(guard.left));
        return;
      }
      if (guard.kind === "landed") {
        setFellBack(null);
        setChanged(WORDS.pledge.landed);
        setText("");
        ctx.refresh();
        return;
      }
      if (route === "signed" && latest.kind !== "refused") {
        // The signature is for what the contract will take, so the wallet shows exactly that.
        const r = await ctx.relayPledge(key, { id, amount: latest.counted, closesAt: campaign.terms.closesAt });
        if (r.kind === "done") setText("");
        else if (r.kind === "fallback") {
          setTwoStep(true);
          setFellBack(r.line);
        }
        return;
      }
      const ok = await ctx.send(key, calls);
      if (ok) {
        setText("");
        setFellBack(null);
      }
    });
  };

  const getUsdc = async () => {
    setDesk({ busy: true, line: null, ok: false });
    const answer = await ctx.askForUsdc();
    setDesk({ busy: false, line: answer.line, ok: answer.ok });
    ctx.refresh();
  };

  const others = form.blocks.filter((b) => b !== form.line);
  return (
    <section className="receipt" aria-labelledby="pledge-title">
      <h2 className="sr-only" id="pledge-title">
        {WORDS.pledge.title}
      </h2>
      <div id="pledge-line" aria-live="polite">
        {receipt.kind === "two" ? (
          <div className="halves">
            <HalfFigure half={receipt.met} typed={text} live={false} />
            <HalfFigure half={receipt.missed} typed={text} live={receipt.missed.live} />
          </div>
        ) : receipt.kind === "completes" ? (
          <p className="receipt-one">{receipt.line}</p>
        ) : (
          <p className="receipt-line">{receipt.line}</p>
        )}
      </div>
      {form.source === "contract" ? <p className="source">{WORDS.pledge.fromContract}</p> : form.source === "estimate" ? <p className="source">{WORDS.pledge.estimate}</p> : null}

      <form
        className="slip"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <label htmlFor="pledge-amount">{WORDS.pledge.amount}</label>
        <input id="pledge-amount" ref={field} name="amount" inputMode="decimal" autoComplete="off" value={text} onChange={(e) => setText(e.target.value)} aria-describedby="pledge-line" />
        {changed ? (
          <p className="problem" role="alert">
            {changed}
          </p>
        ) : null}
        {others.length > 0 ? (
          <ul className="blocks">
            {others.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
        ) : null}
        <button type="submit" disabled={ctx.account !== null && (!form.canSend || !ctx.maySend)}>
          {form.button}
        </button>
        {route === "signed" && ctx.account !== null ? <p className="quiet">{WORDS.pledge.oneSignature}</p> : null}
        {fellBack ? (
          <p className="problem" role="status">
            {fellBack}
          </p>
        ) : null}
        {/* Once a new amount is typed, the last pledge's finished steps give way to it; a send in progress or its error stays. */}
        <SendStatus state={sending && (sending.busy || sending.error !== null || text === "") ? sending : null} />
        {sending && sending.done && text === "" ? <p role="status">{WORDS.pledge.sent}</p> : null}
      </form>

      {offer ? (
        <div className="desk">
          <button type="button" onClick={getUsdc} disabled={desk.busy}>
            {offer.button}
          </button>
          <p className="quiet">{offer.note}</p>
          {desk.line ? (
            <p className={desk.ok ? "" : "problem"} role="status">
              {desk.line}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
