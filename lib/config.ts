/**
 * Application configuration resolution.
 *
 * Shared by server components (which read the real runtime `process.env`) and by
 * anything that needs the same logic in tests. The returned object contains no
 * secrets and is safe to pass across the server/client boundary.
 *
 * Why this exists: `NEXT_PUBLIC_*` values are inlined by Next.js at *build*
 * time, so editing them in `.env.local` used to require a full image rebuild.
 * Resolving the config on the server at request time means the operator only has
 * to restart the container after pasting a freshly deployed Factory address.
 */
import { getAddress, isAddress, parseEther, type Address } from "viem";
import { base, baseSepolia } from "viem/chains";

export type NetworkKey = "sepolia" | "mainnet";

export type EnvSource = Record<string, string | undefined>;

/**
 * Machine-readable configuration problems.
 *
 * These describe *values the operator supplied that are wrong*. A factory that
 * has not been deployed yet is deliberately NOT one of them: "not configured" is
 * a normal state, expressed by `factoryAddress === ""`, and the UI owns the call
 * to action for it. Reporting it here as well would duplicate that message in
 * both the rendered page and the serialised client payload.
 */
export type ConfigIssueCode =
  | "factory-address-invalid"
  | "fee-invalid"
  | "fee-below-minimum"
  | "fee-recipient-missing"
  | "fee-recipient-invalid";

export type ConfigIssue = { code: ConfigIssueCode; message: string };

export type AppConfig = {
  networkKey: NetworkKey;
  chainId: number;
  chainName: string;
  explorerBase: string;
  rpcUrl: string;
  /** Empty string means "not configured" — never a guessed or fake address. */
  factoryAddress: Address | "";
  /** Service fee in ETH as a decimal string. "0" disables the payment leg. */
  feeEth: string;
  feeRecipient: Address | "";
  walletConnectProjectId: string;
  /** Configuration problems to surface in the UI. Contains no secret values. */
  issues: ConfigIssue[];
};

const FEE_PATTERN = /^\d+(\.\d{1,18})?$/;

export const BASE_SEPOLIA_CHAIN_ID = baseSepolia.id; // 84532
export const BASE_MAINNET_CHAIN_ID = base.id; // 8453

/**
 * Lowest service fee the app will accept when a fee is configured.
 *
 * Rationale: a fee of a few wei (or even 0.000001 ETH) is worse than no fee at
 * all — it costs the user an extra gas-paying transaction while delivering a
 * dust amount the recipient can never economically move. Anything non-zero but
 * below this floor is raised to it.
 *
 * Setting the fee to "0" (or leaving it empty) is the supported free mode: the
 * token is then created in a single user-signed transaction and no fee
 * recipient is required.
 */
export const MIN_SERVICE_FEE_ETH = "0.0001";

const MIN_SERVICE_FEE_WEI = 100_000_000_000_000n; // 0.0001 ETH

function pick(source: EnvSource, keys: string[]): string {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return "";
}

/**
 * Return a checksummed address, or "" when the input is absent/invalid.
 *
 * Checksum is not enforced on input: operators paste addresses from many
 * sources and a case-mangled copy is not a wrong address. The canonical
 * checksummed form is what gets stored.
 */
export function normalizeAddress(value: string): Address | "" {
  if (!value) return "";
  const trimmed = value.trim();
  if (!isAddress(trimmed, { strict: false })) return "";
  try {
    return getAddress(trimmed);
  } catch {
    return "";
  }
}

/** Normalise a fee string; invalid input degrades to "0" rather than throwing. */
export function normalizeFee(value: string): { feeEth: string; valid: boolean } {
  const trimmed = value.trim();
  if (trimmed === "") return { feeEth: "0", valid: true };
  if (!FEE_PATTERN.test(trimmed)) return { feeEth: "0", valid: false };
  return { feeEth: trimmed, valid: true };
}

/** Safe wei conversion for UI comparisons. Never throws. */
export function feeToWei(feeEth: string): bigint {
  try {
    if (!FEE_PATTERN.test(feeEth)) return 0n;
    return parseEther(feeEth as `${number}`);
  } catch {
    return 0n;
  }
}

export function resolveConfig(source: EnvSource = {}): AppConfig {
  const issues: ConfigIssue[] = [];
  const addIssue = (code: ConfigIssueCode, message: string) => {
    issues.push({ code, message });
  };

  const rawNetwork = pick(source, ["NEXT_PUBLIC_BASE_NETWORK", "BASE_NETWORK"]).toLowerCase();
  const networkKey: NetworkKey = rawNetwork === "mainnet" ? "mainnet" : "sepolia";
  const chain = networkKey === "mainnet" ? base : baseSepolia;

  const rpcUrl =
    networkKey === "mainnet"
      ? pick(source, ["NEXT_PUBLIC_BASE_MAINNET_RPC_URL", "NEXT_PUBLIC_BASE_RPC_URL"]) ||
        "https://mainnet.base.org"
      : pick(source, ["NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL", "NEXT_PUBLIC_BASE_RPC_URL"]) ||
        "https://sepolia.base.org";

  const suffix = networkKey === "mainnet" ? "MAINNET" : "SEPOLIA";

  const rawFactory = pick(source, [
    `NEXT_PUBLIC_TOKEN_CONTRACT_FACTORY_${suffix}`,
    "NEXT_PUBLIC_TOKEN_CONTRACT_FACTORY",
  ]);
  const factoryAddress = normalizeAddress(rawFactory);
  if (rawFactory && !factoryAddress) {
    addIssue(
      "factory-address-invalid",
      `NEXT_PUBLIC_TOKEN_CONTRACT_FACTORY_${suffix} is not a valid EVM address and was ignored.`,
    );
  }

  const rawFee = pick(source, [
    `NEXT_PUBLIC_TOKEN_CREATOR_FEE_${suffix}`,
    "NEXT_PUBLIC_TOKEN_CREATOR_FEE",
  ]);
  const normalizedFee = normalizeFee(rawFee);
  let feeEth = normalizedFee.feeEth;
  if (!normalizedFee.valid) {
    addIssue(
      "fee-invalid",
      `NEXT_PUBLIC_TOKEN_CREATOR_FEE_${suffix} is not a valid ETH amount and was treated as 0.`,
    );
  } else if (feeToWei(feeEth) > 0n && feeToWei(feeEth) < MIN_SERVICE_FEE_WEI) {
    // Non-zero but dust: raise it rather than charge an economically pointless amount.
    addIssue(
      "fee-below-minimum",
      `NEXT_PUBLIC_TOKEN_CREATOR_FEE_${suffix} is below the ${MIN_SERVICE_FEE_ETH} ETH minimum and was raised to ${MIN_SERVICE_FEE_ETH}.`,
    );
    feeEth = MIN_SERVICE_FEE_ETH;
  }

  const rawRecipient = pick(source, [
    `NEXT_PUBLIC_TOKEN_CREATOR_FEE_RECIPIENT_${suffix}`,
    "NEXT_PUBLIC_TOKEN_CREATOR_FEE_RECIPIENT",
  ]);
  const feeRecipient = normalizeAddress(rawRecipient);
  if (rawRecipient && !feeRecipient) {
    addIssue(
      "fee-recipient-invalid",
      `NEXT_PUBLIC_TOKEN_CREATOR_FEE_RECIPIENT_${suffix} is not a valid EVM address and was ignored.`,
    );
  }
  if (feeToWei(feeEth) > 0n && !feeRecipient) {
    addIssue(
      "fee-recipient-missing",
      "A non-zero service fee is configured but no valid fee recipient address is set, so the paid flow cannot run.",
    );
  }

  // A missing factory is intentionally not an issue: see the note on
  // ConfigIssueCode. `factoryAddress === ""` is the signal for it.

  return {
    networkKey,
    chainId: chain.id,
    chainName: chain.name,
    explorerBase: networkKey === "mainnet" ? "https://basescan.org" : "https://sepolia.basescan.org",
    rpcUrl,
    factoryAddress,
    feeEth,
    feeRecipient,
    walletConnectProjectId: pick(source, ["NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID"]),
    issues,
  };
}

/**
 * The chain objects the app exposes to wagmi. Both networks are always present
 * so `switchChain` can prompt for Base Sepolia even when configured for mainnet.
 */
export function supportedChains() {
  return [baseSepolia, base] as const;
}
