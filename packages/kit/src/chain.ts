// The Arc testnet, the chain Boomerang is built for. The RPC URL is the one the Hardhat
// config names for the `arcTestnet` network, kept in step with it by hand.
import { defineChain } from "viem";

export const arcTestnet = defineChain({
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://rpc.testnet.arc.io"] },
  },
  blockExplorers: {
    default: { name: "Arc Explorer", url: "https://explorer.testnet.arc.io" },
  },
  testnet: true,
});

// USDC carries six decimals, whatever the chain's native currency does.
export const USDC_DECIMALS = 6;
