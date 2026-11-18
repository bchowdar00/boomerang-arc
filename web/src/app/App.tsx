// The app's one stateful piece. It keeps the route, the wallet, the latest read of the chain and
// the state of whatever is being sent, and hands the pages a context. It writes no words of its
// own: every sentence on screen comes from a view, an error explainer or the desk's answers.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createWalletClient, custom, type Abi, type PublicClient } from "viem";

import { authorizationStateAbi, boomerangAbi, type Address } from "../../../packages/kit/src/index.ts";
import { askForCampaign, askForUsdc, askKeeper, askRelay, type Fetch } from "../data/ask.ts";
import { explain } from "../data/errors.ts";
import type { Label } from "../data/labels.ts";
import { oneAtATime, sendEach, type Call } from "../flows/calls.ts";
import { outstandingStore, signedWait } from "../flows/outstanding.ts";
import { authorization, newSalt, relayBody } from "../flows/signed.ts";
import { Campaign } from "../pages/Campaign.tsx";
import { Home } from "../pages/Home.tsx";
import { Lost } from "../pages/Lost.tsx";
import { Mine } from "../pages/Mine.tsx";
import { Pledge } from "../pages/Pledge.tsx";
import { Proof } from "../pages/Proof.tsx";
import { scrollToSection } from "../ui/motion.ts";
import { explorerLink } from "../views/links.ts";
import { fallbackLine, relayLine, relayRefusedBeforeSending } from "../views/pledge.ts";
import { shell, stepLine, WORDS } from "../views/shell.ts";
import { connect as askWallet, connected, declined, discover, ensureChain, type FoundWallet } from "../wallet/injected.ts";
import { chainOf, clientFor } from "./chain.ts";
import type { Config } from "./config.ts";
import type { Ctx, RelayOutcome, SendState, SignedGuard } from "./context.ts";
import { startPoll, type Poll, type PollHost } from "./poll.ts";
import { hrefFor, routeOf, type Route } from "./route.ts";
import { readWorld, type World } from "./world.ts";

const EVERY_MS = 4000;

const netFetch: Fetch = (url, init) => fetch(url, init);

// The browser's storage, for signed pledges that may still land; null where it is blocked.
function browserStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

const pollHost: PollHost = {
  visible: () => document.visibilityState === "visible",
  onVisibility: (fn) => {
    document.addEventListener("visibilitychange", fn);
    return () => document.removeEventListener("visibilitychange", fn);
  },
  setTimer: (fn, ms) => window.setTimeout(fn, ms),
  clearTimer: (handle) => window.clearTimeout(handle as number),
};

const chainNumber = (v: unknown): number | null => {
  if (typeof v !== "string" || !/^0x[0-9a-fA-F]{1,13}$/.test(v)) return null;
  return Number.parseInt(v, 16);
};

export function App({ config, labels, extraWallet }: { config: Config; labels: readonly Label[]; extraWallet: FoundWallet | null }) {
  const chain = useMemo(() => chainOf(config), [config]);
  const client = useMemo(() => clientFor(config), [config]);

  // Where the visitor is.
  const [route, setRoute] = useState<Route>(() => routeOf(window.location.hash));
  useEffect(() => {
    const onHash = () => setRoute(routeOf(window.location.hash));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // The wallet: which ones this browser has, the one in use, its account and its chain.
  const [wallets, setWallets] = useState<FoundWallet[]>(extraWallet ? [extraWallet] : []);
  const [wallet, setWallet] = useState<FoundWallet | null>(null);
  const [account, setAccount] = useState<Address | null>(null);
  const [walletChainId, setWalletChainId] = useState<number | null>(null);
  const [choosing, setChoosing] = useState(false);
  const [walletError, setWalletError] = useState<string | null>(null);

  const use = useCallback(async (w: FoundWallet, ask: boolean) => {
    setWalletError(null);
    try {
      const a = ask ? await askWallet(w.provider) : await connected(w.provider);
      if (a === null) return false;
      const id = chainNumber(await w.provider.request({ method: "eth_chainId" }));
      setWallet(w);
      setAccount(a);
      setWalletChainId(id);
      return true;
    } catch (e) {
      if (ask && !declined(e)) setWalletError(explain(e));
      return false;
    }
  }, []);

  // Find the wallets once. One that already shares an account with this page is used without asking.
  useEffect(() => {
    let gone = false;
    void discover(window, (type) => new Event(type)).then(async (found) => {
      if (gone) return;
      setWallets(extraWallet ? [...found, extraWallet] : found);
      for (const w of found) if (await use(w, false)) break;
    });
    return () => {
      gone = true;
    };
  }, [extraWallet, use]);

  // Follow the wallet when the person changes its account or its network.
  useEffect(() => {
    const p = wallet?.provider;
    if (!p?.on) return;
    const onAccounts = (list: unknown) => {
      const first = Array.isArray(list) ? list[0] : undefined;
      if (typeof first === "string" && /^0x[0-9a-fA-F]{40}$/.test(first)) setAccount(first as Address);
      else {
        setAccount(null);
        setWallet(null);
        setWalletChainId(null);
      }
    };
    const onChain = (id: unknown) => setWalletChainId(chainNumber(id));
    p.on("accountsChanged", onAccounts);
    p.on("chainChanged", onChain);
    return () => {
      p.removeListener?.("accountsChanged", onAccounts);
      p.removeListener?.("chainChanged", onChain);
    };
  }, [wallet]);

  const connect = useCallback(() => {
    if (wallets.length === 1) void use(wallets[0], true);
    else if (wallets.length > 1) setChoosing(true);
  }, [wallets, use]);

  const switchNetwork = useCallback(async () => {
    if (!wallet) return;
    setWalletError(null);
    try {
      await ensureChain(wallet.provider, chain);
      setWalletChainId(chainNumber(await wallet.provider.request({ method: "eth_chainId" })));
    } catch (e) {
      if (!declined(e)) setWalletError(explain(e));
    }
  }, [wallet, chain]);

  // The chain, read again every few seconds; the account read for is the one connected at the time.
  const [world, setWorld] = useState<World | null>(null);
  const [readFailed, setReadFailed] = useState(false);
  const accountRef = useRef<Address | null>(null);
  accountRef.current = account;
  const poll = useRef<Poll | null>(null);
  useEffect(() => {
    const p = startPoll({
      every: EVERY_MS,
      host: pollHost,
      read: async (live) => {
        try {
          const w = await readWorld({
            client,
            where: { boomerang: config.boomerang, usdc: config.usdc },
            account: accountRef.current,
            keeper: () => askKeeper({ url: config.keeperUrl, fetch: netFetch }),
          });
          if (!live()) return; // given up on: a newer read is under way or already shown
          setWorld(w);
          setReadFailed(false);
        } catch {
          if (live()) setReadFailed(true);
        }
      },
    });
    poll.current = p;
    return () => {
      p.stop();
      poll.current = null;
    };
  }, [client, config]);
  const refresh = useCallback(() => poll.current?.now(), []);
  useEffect(() => {
    refresh(); // a new account's figures are read at once
  }, [account, refresh]);

  // What is being sent, by key, one send at a time.
  const [sends, setSends] = useState<Record<string, SendState>>({});
  const gate = useRef(oneAtATime()).current;
  const [busyKey, setBusyKey] = useState<string | null>(null);
  useEffect(() => {
    // Leaving a page forgets its finished sends; one still under way is kept.
    setSends((s) => Object.fromEntries(Object.entries(s).filter(([, v]) => v.busy)));
  }, [route]);

  const send = useCallback(
    async (key: string, calls: readonly Call[]): Promise<boolean> => {
      if (!wallet || !account || calls.length === 0) return false;
      const went = await gate(async () => {
        setBusyKey(key);
        const put = (change: (s: SendState) => SendState) => setSends((all) => ({ ...all, [key]: change(all[key] ?? { key, lines: [], error: null, busy: true, done: false }) }));
        setSends((all) => ({ ...all, [key]: { key, lines: [], error: null, busy: true, done: false } }));
        let ok = false;
        try {
          await ensureChain(wallet.provider, chain);
          setWalletChainId(chainNumber(await wallet.provider.request({ method: "eth_chainId" })));
          const walletClient = createWalletClient({ account, chain, transport: custom(wallet.provider) });
          await sendEach({
            publicClient: client,
            walletClient,
            account,
            calls,
            onStep: (step) =>
              put((s) => {
                const lines = [...s.lines];
                lines[step.index] = stepLine(step, calls.length);
                return { ...s, lines };
              }),
          });
          put((s) => ({ ...s, busy: false, done: true }));
          ok = true;
        } catch (e) {
          put((s) => ({ ...s, busy: false, error: explain(e) }));
        }
        setBusyKey(null);
        refresh();
        return ok;
      });
      return went ?? false;
    },
    [wallet, account, chain, client, refresh, gate],
  );

  // A pledge from one signature: the wallet signs, the keeper sends. Anything short of a pledge on
  // the chain hands back to the two-step pledge, unless the signature may still land (a
  // transaction the keeper sent that the chain has not confirmed), which is said and not retried.
  const worldNow = world?.now ?? null;
  const worldBlock = world?.block ?? null;
  const outstanding = useMemo(() => outstandingStore(browserStorage()), []);
  const relayPledge = useCallback(
    async (key: string, o: { id: bigint; amount: bigint; closesAt: bigint }): Promise<RelayOutcome> => {
      const helper = config.signedPledge;
      if (!wallet || !account || helper === null || worldNow === null) return { kind: "stopped" };
      const went = await gate(async (): Promise<RelayOutcome> => {
        setBusyKey(key);
        const set = (s: Partial<SendState>) => setSends((all) => ({ ...all, [key]: { key, lines: [], error: null, busy: true, done: false, ...s } }));
        set({ lines: [WORDS.pledge.signing] });
        try {
          await ensureChain(wallet.provider, chain);
          setWalletChainId(chainNumber(await wallet.provider.request({ method: "eth_chainId" })));
          const salt = newSalt();
          const a = authorization({ chainId: config.chain.id, usdc: config.usdc, helper, backer: account, id: o.id, amount: o.amount, now: worldNow, closesAt: o.closesAt, salt });
          const used = async () =>
            (await client.readContract({ address: config.usdc, abi: authorizationStateAbi, functionName: "authorizationState", args: [account, a.nonce] })) as boolean;
          const forget = () => outstanding.drop(config.chain.id, account, a.nonce);
          const back = (line: string): RelayOutcome => {
            setSends((all) => Object.fromEntries(Object.entries(all).filter(([k]) => k !== key)));
            return { kind: "fallback", line };
          };
          let signature: `0x${string}`;
          try {
            const walletClient = createWalletClient({ account, chain, transport: custom(wallet.provider) });
            signature = await walletClient.signTypedData({ account, ...a.typed });
          } catch (e) {
            if (declined(e)) {
              set({ busy: false, error: explain(e) });
              return { kind: "stopped" };
            }
            return back(fallbackLine(WORDS.pledge.cannotSign));
          }
          set({ lines: [WORDS.pledge.relaying] });
          // Remembered before it leaves: from here it may land, until its window ends.
          outstanding.add(config.chain.id, account, { id: o.id, nonce: a.nonce, until: a.validBefore });
          const answer = await askRelay({ url: config.keeperUrl, fetch: netFetch, body: relayBody({ id: o.id, backer: account, amount: o.amount, validAfter: a.validAfter, validBefore: a.validBefore, salt, signature }) });
          if (answer.ok) {
            set({ lines: [WORDS.pledge.relaying, WORDS.pledge.waiting] });
            let status: string;
            try {
              status = (await client.waitForTransactionReceipt({ hash: answer.hash, timeout: 60_000 })).status;
            } catch {
              set({ busy: false, error: WORDS.pledge.unconfirmed });
              return { kind: "stopped" };
            }
            if (status === "success") {
              forget(); // used
              set({ lines: [WORDS.pledge.relaying, WORDS.pledge.waiting], busy: false, done: true });
              return { kind: "done" };
            }
            // A reverted call leaves the signature unused, and now public: it stays remembered
            // until its window has passed, like one with no answer.
            return back(relayLine("failed"));
          }
          // No pledge reported: the chain decides whether the signature was used after all.
          if (await used().catch(() => false)) {
            forget();
            set({ lines: [WORDS.pledge.landed], busy: false, done: true });
            return { kind: "done" };
          }
          // Refused before sending: forgotten. Otherwise it stays remembered, and every pledge to
          // this campaign waits until its window has passed (signedGuard).
          if (relayRefusedBeforeSending(answer.reason)) forget();
          return back(relayLine(answer.reason));
        } catch (e) {
          set({ busy: false, error: explain(e) });
          return { kind: "stopped" };
        } finally {
          setBusyKey(null);
          refresh();
        }
      });
      return went ?? { kind: "stopped" };
    },
    [wallet, account, chain, client, config, worldNow, refresh, gate, outstanding],
  );

  const signedGuard = useCallback(
    async (id: bigint): Promise<SignedGuard> => {
      if (account === null || worldNow === null || worldBlock === null) return { kind: "clear" };
      const { left, expired } = signedWait(outstanding.list(config.chain.id, account), id, worldNow);
      let landed = false;
      // Past its window by the chain's own clock, a signature can no longer be used: USDC says
      // whether it was, and it is forgotten either way.
      for (const o of expired) {
        let used: boolean;
        try {
          // Read at the block whose time was compared, so a node behind it cannot answer "unused" too early.
          used = (await client.readContract({ address: config.usdc, abi: authorizationStateAbi, functionName: "authorizationState", args: [account, o.nonce], blockNumber: worldBlock })) as boolean;
        } catch {
          return { kind: "unknown" };
        }
        outstanding.drop(config.chain.id, account, o.nonce);
        if (used) landed = true;
      }
      if (left !== null) return { kind: "wait", left };
      return landed ? { kind: "landed" } : { kind: "clear" };
    },
    [account, worldNow, worldBlock, client, config, outstanding],
  );

  const quote = useCallback(
    async (id: bigint, amount: bigint) => {
      const [wouldFund, counted, bonus] = (await client.readContract({ address: config.boomerang, abi: boomerangAbi as unknown as Abi, functionName: "quoteIfMissed", args: [id, amount] })) as [boolean, bigint, bigint];
      return { wouldFund, counted, bonus };
    },
    [client, config],
  );

  // The bar draws its rule once the page has moved under it.
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // A link to a part of the landing page: go there if elsewhere, then bring that part into view.
  // A new page otherwise starts at its top.
  const wanted = useRef<"how" | "ledger" | null>(null);
  const toSection = (e: { preventDefault(): void }, section: "how" | "ledger") => {
    e.preventDefault();
    if (route.page === "home") return scrollToSection(section);
    wanted.current = section;
    window.location.hash = hrefFor({ page: "home" });
  };
  const landed = route.page === "home" && world !== null;
  useEffect(() => {
    const section = wanted.current;
    if (section !== null) {
      if (!landed) return; // the landing page has not been drawn yet
      wanted.current = null;
      const frameId = window.requestAnimationFrame(() => scrollToSection(section));
      return () => window.cancelAnimationFrame(frameId);
    }
    if (route.page === "pledge") return; // that address puts the cursor in the amount field; the browser has brought it into view
    window.scrollTo(0, 0);
  }, [hrefFor(route), landed]); // eslint-disable-line react-hooks/exhaustive-deps

  const frame = shell({
    route,
    chain: config.chain,
    contractLink: explorerLink(config.chain.explorer, "address", config.boomerang),
    wallets: wallets.length,
    account,
    walletChainId,
    block: world?.block ?? null,
    readFailed,
  });

  let page = null;
  if (route.page === "lost") page = <Lost hash={route.hash} />;
  else if (world !== null) {
    const ctx: Ctx = {
      config,
      world,
      labels,
      desk: world.keeper.up ? world.keeper.health.desk : null,
      relay: world.keeper.up ? world.keeper.health.relay : null,
      account,
      onRightChain: account !== null && walletChainId === config.chain.id,
      maySend: !readFailed && busyKey === null,
      send,
      relayPledge,
      signedGuard,
      sendState: (key) => sends[key] ?? null,
      connect,
      quote,
      askForUsdc: () => (account === null ? Promise.resolve({ ok: false as const, line: WORDS.connect }) : askForUsdc({ url: config.keeperUrl, fetch: netFetch, address: account })),
      askForCampaign: () => askForCampaign({ url: config.keeperUrl, fetch: netFetch }),
      refresh,
    };
    page =
      route.page === "home" ? (
        <Home ctx={ctx} />
      ) : route.page === "campaign" ? (
        <Campaign ctx={ctx} id={route.id} />
      ) : route.page === "pledge" ? (
        <Pledge ctx={ctx} id={route.id} key={String(route.id)} />
      ) : route.page === "mine" ? (
        <Mine ctx={ctx} />
      ) : (
        <Proof ctx={ctx} />
      );
  } else if (!readFailed) page = <p className="quiet">{WORDS.loading}</p>;

  return (
    <div className="app">
      <nav className={`top${scrolled ? " scrolled" : ""}`} aria-label={frame.brand}>
        <div className="wrap">
          <a className="mark" href="#/">
            <svg viewBox="0 0 32 32" aria-hidden="true">
              <path d="M5 22 Q9 8 16 8 Q23 8 27 22 Q28.5 25 26 25.6 Q21 15 16 15 Q11 15 6 25.6 Q3.5 25 5 22Z" fill="currentColor" />
            </svg>
            {frame.brand}
          </a>
          <div className="links">
            {frame.nav.map((n) => (
              <a key={n.label} href={n.href} aria-current={n.current ? "page" : undefined} onClick={n.section ? (e) => toSection(e, n.section!) : undefined}>
                {n.label}
              </a>
            ))}
          </div>
          <div className={`wallet wallet-${frame.wallet.state}`}>
            {frame.wallet.account ? <span className="wallet-account">{frame.wallet.account}</span> : null}
            {frame.wallet.button ? (
              <button type="button" className="btn btn-line" onClick={frame.wallet.state === "wrong-network" ? () => void switchNetwork() : connect}>
                {frame.wallet.button}
              </button>
            ) : null}
          </div>
        </div>
      </nav>

      <div className="wrap notices">
        {frame.wallet.note ? <p className="wallet-note">{frame.wallet.note}</p> : null}
        {walletError ? (
          <p className="problem" role="alert">
            {walletError}
          </p>
        ) : null}
        {choosing ? (
          <div className="chooser" role="group" aria-label={WORDS.wallets.choose}>
            <p>{WORDS.wallets.choose}</p>
            <ul>
              {wallets.map((w) => (
                <li key={w.id}>
                  <button
                    type="button"
                    onClick={() => {
                      setChoosing(false);
                      void use(w, true);
                    }}
                  >
                    {w.icon ? <img src={w.icon} alt="" width={20} height={20} /> : null}
                    {w.name}
                  </button>
                </li>
              ))}
            </ul>
            <button type="button" className="btn-plain" onClick={() => setChoosing(false)}>
              {WORDS.wallets.cancel}
            </button>
          </div>
        ) : null}
        {frame.banner ? (
          <p className="banner" role="alert">
            {frame.banner}
          </p>
        ) : null}
      </div>

      {/* The landing page lays out its own full-width sections; every other page sits in the gutter. */}
      {route.page === "home" && world !== null ? <main>{page}</main> : <main className="wrap page">{page}</main>}

      <footer className="foot">
        <div className="wrap">
          <div>
            <p className="disclaimer">{frame.disclaimer}</p>
            {frame.asOf ? <p className="as-of">{frame.asOf}</p> : null}
          </div>
          <div className="fl">
            {frame.foot.map((f) =>
              f.external ? (
                <a key={f.label} href={f.href} target="_blank" rel="noreferrer noopener">
                  {f.label}
                </a>
              ) : (
                <a key={f.label} href={f.href}>
                  {f.label}
                </a>
              ),
            )}
          </div>
        </div>
      </footer>
    </div>
  );
}
