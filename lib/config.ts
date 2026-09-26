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
 * to restart the container after pasting a freshly deployed factory address.
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
 * a normal state, expressed by an empty address, and the UI owns the call to
 * action for it. Reporting it here as well would duplicate that message in both
 * the rendered page and the serialised client payload.
 */
export type ConfigIssueCode =
  | "factory-core-address-invalid"
  | "factory-burnable-address-invalid"
  | "fee-invalid"
  | "fee-recipient-missing"
  | "fee-recipient-invalid";

export type ConfigIssue = { code: ConfigIssueCode; message: string };

/** The four price components, as decimal ETH strings. */
export type FeatureFees = {
  base: string;
  burnable: string;
  mintable: string;
  pausable: string;
};

export type AppConfig = {
  networkKey: NetworkKey;
  chainId: number;
  chainName: string;
  explorerBase: string;
  rpcUrl: string;
  /**
   * Empty string means "not configured" — never a guessed or fake address.
   *
   * Two addresses rather than one because a single factory cannot hold all eight
   * feature combinations: EIP-170 caps a contract at 24576 bytes and the eight
   * variants need 30664. See contracts/TokenFactoryV2.sol.
   */
  factoryCoreAddress: Address | "";
  factoryBurnableAddress: Address | "";
  /**
   * What each feature costs, from the environment.
   *
   * These are the values the factories are *deployed* with, and they are the
   * fallback the page shows before a factory exists. Once a factory is
   * configured the page displays what that contract reports via `feeFor()`, so
   * the number on screen is always the number the chain will demand.
   */
  featureFees: FeatureFees;
  feeRecipient: Address | "";
  walletConnectProjectId: string;
  /** Configuration problems to surface in the UI. Contains no secret values. */
  issues: ConfigIssue[];
};

const FEE_PATTERN = /^\d+(\.\d{1,18})?$/;

export const BASE_SEPOLIA_CHAIN_ID = baseSepolia.id; // 84532
export const BASE_MAINNET_CHAIN_ID = base.id; // 8453

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
 * Checksum is not enforced on input: operators paste addresses from many sources
 * and a case-mangled copy is not a wrong address. The canonical checksummed form
 * is what gets stored.
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

/**
 * Note there is deliberately no minimum-fee floor.
 *
 * An earlier revision raised any non-zero fee below 0.0001 ETH up to that value,
 * on the grounds that a dust charge costs the user a transfer for nothing. The
 * product now prices features at 0.000001 ETH during the test phase, and a floor
 * would silently rewrite the operator's own price table — the page would show one
 * number while the factory required another. Whatever the environment says is
 * what gets used; on mainnet the operator sets realistic values there.
 */
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

  const readFactoryAddress = (
    kind: "CORE" | "BURNABLE",
    issueCode: ConfigIssueCode,
  ): Address | "" => {
    const raw = pick(source, [
      `NEXT_PUBLIC_TOKEN_CONTRACT_FACTORY_${kind}_${suffix}`,
      `NEXT_PUBLIC_TOKEN_CONTRACT_FACTORY_${kind}`,
    ]);
    const address = normalizeAddress(raw);
    if (raw && !address) {
      addIssue(
        issueCode,
        `NEXT_PUBLIC_TOKEN_CONTRACT_FACTORY_${kind}_${suffix} is not a valid EVM address and was ignored.`,
      );
    }
    return address;
  };

  const factoryCoreAddress = readFactoryAddress("CORE", "factory-core-address-invalid");
  const factoryBurnableAddress = readFactoryAddress("BURNABLE", "factory-burnable-address-invalid");

  const readFee = (envKey: string): string => {
    const raw = pick(source, [`NEXT_PUBLIC_${envKey}_${suffix}`, `NEXT_PUBLIC_${envKey}`]);
    const normalized = normalizeFee(raw);
    if (!normalized.valid) {
      addIssue(
        "fee-invalid",
        `NEXT_PUBLIC_${envKey}_${suffix} is not a valid ETH amount and was treated as 0.`,
      );
    }
    return normalized.feeEth;
  };

  const featureFees: FeatureFees = {
    base: readFee("TOKEN_CREATOR_FEE"),
    burnable: readFee("BURNABLE_FEE"),
    mintable: readFee("MINTABLE_FEE"),
    pausable: readFee("PAUSABLE_FEE"),
  };

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

  // A non-zero price with nowhere to send it would fail at the last step, so say
  // so up front. Any factory is enough to make the flow meaningful.
  const anyFee = Object.values(featureFees).some(value => feeToWei(value) > 0n);
  if (anyFee && !feeRecipient) {
    addIssue(
      "fee-recipient-missing",
      "A non-zero service fee is configured but no valid fee recipient address is set, so the paid flow cannot run.",
    );
  }

  // A missing factory is intentionally not an issue: see the note on
  // ConfigIssueCode. An empty address is the signal for it.

  return {
    networkKey,
    chainId: chain.id,
    chainName: chain.name,
    explorerBase: networkKey === "mainnet" ? "https://basescan.org" : "https://sepolia.basescan.org",
    rpcUrl,
    factoryCoreAddress,
    factoryBurnableAddress,
    featureFees,
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
