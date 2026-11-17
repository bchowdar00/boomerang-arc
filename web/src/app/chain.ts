// The chain as viem wants it, from the app's configuration.
import { defineChain, type Chain } from "viem";

import { arcTestnet } from "../../../packages/kit/src/index.ts";
import type { Config } from "./config.ts";

export function chainOf(config: Config): Chain {
  if (!config.chain.local && config.chain.id === arcTestnet.id) return arcTestnet;
  return defineChain({
    id: config.chain.id,
    name: config.chain.name,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [config.chain.rpcUrl] } },
    testnet: true,
  });
}
