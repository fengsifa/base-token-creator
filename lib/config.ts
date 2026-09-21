import { base, baseSepolia } from "wagmi/chains";
import type { Address } from "viem";
export const isMainnet = process.env.BASE_NETWORK === "mainnet";
export const activeChain = isMainnet ? base : baseSepolia;
export const explorerBase = isMainnet ? "https://basescan.org" : "https://sepolia.basescan.org";
export const rpcUrl = isMainnet ? (process.env.NEXT_PUBLIC_BASE_MAINNET_RPC_URL||"https://mainnet.base.org") : (process.env.NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL||"https://sepolia.base.org");
export const factoryAddress = (isMainnet ? process.env.NEXT_PUBLIC_TOKEN_CONTRACT_FACTORY_MAINNET : process.env.NEXT_PUBLIC_TOKEN_CONTRACT_FACTORY_SEPOLIA || process.env.NEXT_PUBLIC_TOKEN_CONTRACT_FACTORY) as Address|undefined;
export const feeEth = isMainnet ? (process.env.NEXT_PUBLIC_TOKEN_CREATOR_FEE_MAINNET||"") : (process.env.NEXT_PUBLIC_TOKEN_CREATOR_FEE_SEPOLIA||process.env.NEXT_PUBLIC_TOKEN_CREATOR_FEE||"");
export const feeRecipient = (isMainnet ? process.env.NEXT_PUBLIC_TOKEN_CREATOR_FEE_RECIPIENT_MAINNET : process.env.NEXT_PUBLIC_TOKEN_CREATOR_FEE_RECIPIENT_SEPOLIA || process.env.NEXT_PUBLIC_TOKEN_CREATOR_FEE_RECIPIENT) as Address|undefined;
