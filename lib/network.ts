/**
 * Wallet network plumbing.
 *
 * A normal user must never be asked to type an RPC URL, a chain id, or an
 * explorer URL. Everything the wallet needs is derived from the app's own
 * server-resolved config and handed to the wallet through its own API:
 *
 *   1. `wallet_switchEthereumChain` to move to the target network
 *   2. `wallet_addEthereumChain`  when the wallet does not know the network yet
 *
 * Step 2 is normally performed inside wagmi's injected connector, but only when
 * the wallet reports the specific error code 4902. Wallets differ in how they
 * report an unknown chain, so this module detects the situation more broadly and
 * performs the add itself as a fallback. The result is that a fresh MetaMask
 * install reaches Base Sepolia with no manual configuration at all.
 */
import type { AppConfig } from "./config";

export type NativeCurrency = { name: string; symbol: string; decimals: number };

/** The full payload for a raw `wallet_addEthereumChain` request. */
export type AddChainParams = {
  chainId: string;
  chainName: string;
  nativeCurrency: NativeCurrency;
  rpcUrls: string[];
  blockExplorerUrls: string[];
};

/**
 * What wagmi's `switchChain` accepts: the same fields minus `chainId`, which it
 * passes separately.
 */
export type AddChainOverrides = Omit<AddChainParams, "chainId">;

/** Base Sepolia's native currency, as wallets expect to see it. */
export const NATIVE_CURRENCY: NativeCurrency = { name: "Ether", symbol: "ETH", decimals: 18 };

/** The wallet-facing network definition, derived from our own configuration. */
export type NetworkConfig = Pick<AppConfig, "chainId" | "chainName" | "rpcUrl" | "explorerBase">;

export function toChainIdHex(chainId: number): string {
  return `0x${chainId.toString(16)}`;
}

/**
 * The wallet-facing fields, built in one place so the switch overrides and the
 * raw add-chain payload can never drift apart.
 *
 * The RPC URL comes from the app's config, not from a hard-coded default, so a
 * self-hosted or paid RPC is what actually ends up stored in the user's wallet.
 */
function walletFacingFields(config: NetworkConfig): AddChainOverrides {
  return {
    chainName: config.chainName,
    nativeCurrency: NATIVE_CURRENCY,
    rpcUrls: [config.rpcUrl],
    blockExplorerUrls: [config.explorerBase],
  };
}

/** The full payload for a raw `wallet_addEthereumChain` request. */
export function chainAddParams(config: NetworkConfig): AddChainParams {
  return { chainId: toChainIdHex(config.chainId), ...walletFacingFields(config) };
}

/** The subset wagmi forwards to the wallet's own add-chain call. */
export function addChainOverrides(config: NetworkConfig): AddChainOverrides {
  return walletFacingFields(config);
}

/** Error codes a wallet uses to say "I do not have this chain". */
const UNKNOWN_CHAIN_CODES = [4902];

/** Wallets that return a generic code still say it in words. */
const UNKNOWN_CHAIN_PATTERNS = [
  /unrecognized chain id/i,
  /unrecognised chain id/i,
  /chain .{0,40}not (?:been )?added/i,
  /chain has not been added/i,
  /try adding the chain/i,
  /unknown chain/i,
  /missing or invalid parameters/i,
  /not supported by metamask/i,
];

/** Codes/messages that mean the user said no. These must never be retried. */
const USER_REJECTION_CODES = [4001];
const USER_REJECTION_PATTERNS = [/user rejected/i, /user denied/i, /rejected the request/i];

/**
 * Walk an error's usual nesting points collecting numeric codes and messages.
 *
 * Providers disagree on where they put the real cause: some set `error.code`,
 * MetaMask Mobile nests it under `data.originalError.code`, viem wraps things in
 * `cause`. Reading all of them avoids treating a plain rejection as an unknown
 * chain (which would trigger a second, unwanted prompt).
 */
function collectErrorSignals(error: unknown): { codes: number[]; messages: string[] } {
  const codes: number[] = [];
  const messages: string[] = [];
  const seen = new Set<unknown>();

  let node: unknown = error;
  for (let depth = 0; depth < 8 && node && typeof node === "object"; depth += 1) {
    if (seen.has(node)) break;
    seen.add(node);

    const obj = node as Record<string, unknown>;
    if (typeof obj.code === "number") codes.push(obj.code);
    for (const key of ["name", "shortMessage", "message", "reason", "details"]) {
      if (typeof obj[key] === "string") messages.push(obj[key] as string);
    }

    // MetaMask Mobile reports the real cause under `data.originalError` rather
    // than on the object viem hands us, so read that hop explicitly.
    const data = obj.data as Record<string, unknown> | undefined;
    if (data && typeof data === "object") {
      if (typeof data.code === "number") codes.push(data.code);
      const original = data.originalError as Record<string, unknown> | undefined;
      if (original && typeof original === "object") {
        if (typeof original.code === "number") codes.push(original.code);
        if (typeof original.message === "string") messages.push(original.message);
      }
    }

    const next = obj.cause ?? obj.error ?? obj.data ?? obj.originalError;
    node = next;
  }

  return { codes, messages };
}

export function isUserRejection(error: unknown): boolean {
  const { codes, messages } = collectErrorSignals(error);
  if (codes.some(code => USER_REJECTION_CODES.includes(code))) return true;
  if (messages.some(message => message.includes("UserRejectedRequestError"))) return true;
  return messages.some(message => USER_REJECTION_PATTERNS.some(re => re.test(message)));
}

/**
 * True when the wallet does not know the target chain, in any of the shapes
 * wallets actually report it.
 *
 * A user rejection wins over every other signal: if the wallet both complains
 * about the chain and says the user declined, the user declined.
 */
export function isUnknownChainError(error: unknown): boolean {
  if (isUserRejection(error)) return false;
  const { codes, messages } = collectErrorSignals(error);
  if (codes.some(code => UNKNOWN_CHAIN_CODES.includes(code))) return true;
  return messages.some(message => UNKNOWN_CHAIN_PATTERNS.some(re => re.test(message)));
}

/** The minimal EIP-1193 surface used to add a chain ourselves. */
export type Eip1193Provider = {
  request: (args: { method: string; params?: unknown }) => Promise<unknown>;
};

/**
 * Narrow whatever a connector hands back to the one method we need.
 *
 * wagmi types `getProvider()` as `unknown` because connectors differ wildly, and
 * a WalletConnect or Coinbase provider is not guaranteed to expose `request` at
 * all. Checking the shape at runtime keeps the single necessary narrowing in this
 * module instead of spreading type assertions across components.
 */
function asEip1193(value: unknown): Eip1193Provider | undefined {
  if (value && typeof value === "object") {
    const candidate = value as { request?: unknown };
    if (typeof candidate.request === "function") return value as Eip1193Provider;
  }
  return undefined;
}

export type EnsureTargetChainArgs = {
  /** The network the app needs the wallet to be on. */
  config: NetworkConfig;
  /** wagmi's `switchChainAsync`, which already prompts and adds when it can. */
  switchChainAsync: (args: {
    chainId: number;
    addEthereumChainParameter?: AddChainOverrides;
  }) => Promise<unknown>;
  /**
   * The connected wallet's provider, used only for the fallback add. Left
   * untyped on purpose: the shape is validated here rather than asserted by
   * every caller.
   */
  getProvider?: () => unknown;
};

/**
 * Put the wallet on the configured network.
 *
 * Tries the wallet's switch first (handing over our RPC/currency/explorer so the
 * wallet stores the right ones). If the wallet reports that it does not know the
 * chain in a way wagmi's connector did not handle, adds the chain and retries.
 * Anything else — including a plain user rejection — propagates untouched.
 */
export async function ensureTargetChain({
  config,
  switchChainAsync,
  getProvider,
}: EnsureTargetChainArgs): Promise<void> {
  const params = chainAddParams(config);

  try {
    await switchChainAsync({
      chainId: config.chainId,
      addEthereumChainParameter: addChainOverrides(config),
    });
    return;
  } catch (cause) {
    if (!isUnknownChainError(cause)) throw cause;

    // The wallet does not know this network and the connector's own add either
    // did not happen or was rejected. Add it explicitly, then switch again.
    const provider = getProvider ? asEip1193(await getProvider()) : undefined;
    if (!provider) throw cause;

    await provider.request({ method: "wallet_addEthereumChain", params: [params] });
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: params.chainId }],
    });
  }
}

/** Copy shown when the wallet is on the wrong network. */
export function wrongNetworkMessage(currentChainId: number | undefined, targetName: string): string {
  if (currentChainId === undefined) {
    return `Your wallet has not reported its network yet. Switch to ${targetName} to continue.`;
  }
  return `Your wallet is on chain ${currentChainId}. Switch to ${targetName} to continue — we ask your wallet directly, so there is nothing to configure by hand.`;
}
