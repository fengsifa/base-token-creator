/**
 * Contract interfaces used by the frontend.
 *
 * IMPORTANT: these ABIs are hand written so TypeScript keeps literal types (which
 * gives wagmi full autocompletion and compile-time argument checking). They must
 * stay byte-for-byte equivalent to the compiled artifacts —
 * `test/unit/abi-consistency.test.ts` compares them and fails on any drift.
 *
 * Two generations live here, and both are needed:
 *
 *  - `tokenFactoryAbi` — the current factories (`TokenFactoryCore` and
 *    `TokenFactoryBurnable`). Both publish exactly the same interface, so one ABI
 *    serves both; only the address differs.
 *  - `legacyTokenFactoryAbi` — the original feature-less factory. Its instance is
 *    still on Base Sepolia and `scripts/verify-live-factory.mjs` checks that
 *    bytecode, so its ABI must not be deleted or altered.
 */
import type { Abi, Address, Hex } from "viem";
import { BaseError, ContractFunctionRevertedError, UserRejectedRequestError } from "viem";
import { isProviderNotFoundError, providerNotFoundMessage } from "./wallet";
import legacyArtifact from "./tokenfactory-artifact.json";
import v2Artifact from "./tokenfactory-v2-artifact.json";

/** Which factory can create which feature set. */
export type FactoryKind = "core" | "burnable";

/**
 * The feature flags the creation form collects, in one place.
 *
 * This is the single source of truth the UI, the fee calculation and the factory
 * routing all read. Duplicating the list is how a page ends up offering an option
 * the contract cannot honour.
 */
export const TOKEN_FEATURES = [
  {
    key: "burnable",
    label: "Burnable",
    /** Which factory deploys this combination once the flag is on. */
    factory: "burnable" as FactoryKind,
    blurb:
      "Holders can destroy their own tokens. Needs no admin: burning only ever reduces the caller's own balance.",
  },
  {
    key: "mintable",
    label: "Mintable",
    factory: "core" as FactoryKind,
    blurb:
      "You can create more tokens later. Only your wallet can mint, and it cannot take anyone else's balance.",
  },
  {
    key: "pausable",
    label: "Pausable",
    factory: "core" as FactoryKind,
    blurb:
      "You can freeze all token movement. While frozen, transfers, minting and burning all stop until you unfreeze.",
  },
] as const;

export type TokenFeatureKey = (typeof TOKEN_FEATURES)[number]["key"];

/**
 * The factory that must deploy a given combination.
 *
 * Burn is the only feature needing no creator power, so it is the split point:
 * `TokenFactoryBurnable` handles every combination that includes it, and
 * `TokenFactoryCore` handles the rest. See contracts/TokenFactoryV2.sol for why
 * there are two factories at all (the EIP-170 limit).
 */
export function factoryKindFor(features: {
  burnable: boolean;
  mintable: boolean;
  pausable: boolean;
}): FactoryKind {
  return features.burnable ? "burnable" : "core";
}

/**
 * What both factories have in common: the creation entry point, the price table,
 * the event and the errors.
 *
 * The constructor is deliberately NOT part of this ABI. The two factories take a
 * different number of price arguments — the core factory has no burn price to
 * pass, because it cannot create a burnable token — so there is no shared
 * constructor to describe. Deployment uses each factory's own ABI from the
 * compiled artifact; see `factoryDeployAbi`.
 */
export const tokenFactoryAbi = [
  { type: "error", name: "DecimalsTooHigh", inputs: [{ name: "decimals_", type: "uint8" }] },
  { type: "error", name: "EmptyName", inputs: [] },
  { type: "error", name: "EmptySymbol", inputs: [] },
  { type: "error", name: "FeatureNotSupportedHere", inputs: [] },
  { type: "error", name: "FeeTransferFailed", inputs: [] },
  { type: "error", name: "InvalidFeeRecipient", inputs: [] },
  { type: "error", name: "NameTooLong", inputs: [{ name: "length", type: "uint256" }] },
  { type: "error", name: "SymbolTooLong", inputs: [{ name: "length", type: "uint256" }] },
  {
    type: "error",
    name: "WrongFee",
    inputs: [
      { name: "required", type: "uint256" },
      { name: "sent", type: "uint256" },
    ],
  },
  { type: "error", name: "ZeroSupply", inputs: [] },
  {
    type: "event",
    name: "TokenCreated",
    inputs: [
      { indexed: true, name: "token", type: "address" },
      { indexed: true, name: "creator", type: "address" },
      { indexed: false, name: "name", type: "string" },
      { indexed: false, name: "symbol", type: "string" },
      { indexed: false, name: "burnable", type: "bool" },
      { indexed: false, name: "mintable", type: "bool" },
      { indexed: false, name: "pausable", type: "bool" },
    ],
    anonymous: false,
  },
  {
    type: "function",
    name: "MAX_DECIMALS",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
  {
    type: "function",
    name: "MAX_NAME_BYTES",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "MAX_SYMBOL_BYTES",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "baseFee",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "burnFee",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "createToken",
    stateMutability: "payable",
    inputs: [
      { name: "name_", type: "string" },
      { name: "symbol_", type: "string" },
      { name: "decimals_", type: "uint8" },
      { name: "supply_", type: "uint256" },
      { name: "burnable_", type: "bool" },
      { name: "mintable_", type: "bool" },
      { name: "pausable_", type: "bool" },
    ],
    outputs: [{ name: "token", type: "address" }],
  },
  {
    type: "function",
    name: "feeFor",
    stateMutability: "view",
    inputs: [
      { name: "burnable_", type: "bool" },
      { name: "mintable_", type: "bool" },
      { name: "pausable_", type: "bool" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "feeRecipient",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "mintFee",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "pauseFee",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const satisfies Abi;

/**
 * The original factory, which creates fixed-supply tokens with no optional
 * features and takes no fee. Kept because its instance is live and verified by
 * bytecode comparison; nothing new should point at it.
 */
export const legacyTokenFactoryAbi = [
  {
    type: "function",
    name: "createToken",
    stateMutability: "nonpayable",
    inputs: [
      { name: "name_", type: "string" },
      { name: "symbol_", type: "string" },
      { name: "decimals_", type: "uint8" },
      { name: "supply_", type: "uint256" },
    ],
    outputs: [{ name: "token", type: "address" }],
  },
  {
    type: "function",
    name: "MAX_NAME_BYTES",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "MAX_SYMBOL_BYTES",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "MAX_DECIMALS",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
  {
    type: "event",
    name: "TokenCreated",
    inputs: [
      { indexed: true, name: "token", type: "address" },
      { indexed: true, name: "creator", type: "address" },
      { indexed: false, name: "name", type: "string" },
      { indexed: false, name: "symbol", type: "string" },
    ],
    anonymous: false,
  },
  { type: "error", name: "EmptyName", inputs: [] },
  { type: "error", name: "NameTooLong", inputs: [{ name: "length", type: "uint256" }] },
  { type: "error", name: "EmptySymbol", inputs: [] },
  { type: "error", name: "SymbolTooLong", inputs: [{ name: "length", type: "uint256" }] },
  { type: "error", name: "ZeroSupply", inputs: [] },
  { type: "error", name: "DecimalsTooHigh", inputs: [{ name: "decimals_", type: "uint8" }] },
] as const satisfies Abi;

/**
 * Both ABIs, for decoding a `TokenCreated` log when we do not know in advance
 * which factory emitted it. The two events have different signatures, so exactly
 * one will match a given log.
 */
export const factoryEventAbis = [tokenFactoryAbi, legacyTokenFactoryAbi] as const;

/** Minimal read-only ERC-20 surface, used to verify a freshly created token. */
export const erc20ReadAbi = [
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "totalSupply", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const satisfies Abi;

/**
 * Read surface for the optional features, so a created token can be inspected
 * after the fact. Deliberately read-only where it can be: the product does not
 * offer a page that mints or burns, and the on-chain creator is the only
 * authority that matters.
 */
export const tokenFeatureReadAbi = [
  {
    type: "function",
    name: "creator",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  { type: "function", name: "paused", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
] as const satisfies Abi;

/**
 * Creation code for the factories `/setup` deploys.
 *
 * Both are required together: the page routes a creation to one or the other
 * depending on whether Burnable is selected, so a deployment that produced only
 * one address would leave half the options broken.
 */
export const factoryBytecode: Record<FactoryKind, Hex> = {
  core: (v2Artifact.factories.core.bytecode ?? "0x") as Hex,
  burnable: (v2Artifact.factories.burnable.bytecode ?? "0x") as Hex,
};

/**
 * Deployment ABIs, straight from the compiled artifacts.
 *
 * Taken from the artifact rather than hand written because these differ only in
 * the constructor's argument list, which is not something the page ever calls —
 * it only needs the shape to pass the right prices at deploy time.
 */
export const factoryDeployAbi: Record<FactoryKind, Abi> = {
  core: v2Artifact.factories.core.abi as unknown as Abi,
  burnable: v2Artifact.factories.burnable.abi as unknown as Abi,
};

/** The compiled ABIs, kept for the drift check and for tooling. */
export const compiledTokenFactoryAbi = v2Artifact.factories.core.abi as unknown as Abi;
export const compiledLegacyTokenFactoryAbi = legacyArtifact.abi as unknown as Abi;
export const legacyFactoryBytecode = (legacyArtifact.bytecode ?? "0x") as Hex;

/** True when both factory artifacts carry real creation code. */
export const factoryArtifactsReady =
  factoryBytecode.core !== "0x" && factoryBytecode.burnable !== "0x";

/** Human wording for the custom errors declared in the factory contracts. */
const REVERT_MESSAGES: Record<string, string> = {
  EmptyName: "The contract rejected the call: the token name cannot be empty.",
  NameTooLong: "The contract rejected the call: the token name is longer than 32 characters.",
  EmptySymbol: "The contract rejected the call: the token symbol cannot be empty.",
  SymbolTooLong: "The contract rejected the call: the token symbol is longer than 12 characters.",
  ZeroSupply: "The contract rejected the call: the supply must be greater than zero.",
  DecimalsTooHigh: "The contract rejected the call: decimals must be 18 or fewer.",
  WrongFee:
    "The contract rejected the call: the amount sent did not match the service fee it charges. Nothing was deployed and no fee was taken.",
  FeatureNotSupportedHere:
    "The token was sent to the wrong factory for the features selected. Nothing was deployed.",
  FeeTransferFailed:
    "The service fee could not be delivered to the recipient, so the token was not created. No fee was taken.",
  InvalidFeeRecipient: "The factory was configured with a zero fee recipient.",
  NotCreator: "The contract rejected the call: only the wallet that created this token may do that.",
  EnforcedPause: "The contract rejected the call: this token is paused, so transfers are frozen.",
  ExpectedPause: "The contract rejected the call: this token is not paused.",
  // OpenZeppelin ERC20
  ERC20InvalidReceiver: "The contract rejected the call: invalid token recipient.",
  ERC20InvalidSender: "The contract rejected the call: invalid token sender.",
  ERC20InsufficientBalance: "The contract rejected the call: the balance is too low.",
  ERC20InsufficientAllowance: "The contract rejected the call: the allowance is too low.",
  InvalidDecimals: "The contract rejected the call: decimals must be 18 or fewer.",
  InvalidRecipient: "The contract rejected the call: the recipient address cannot be zero.",
};

/**
 * Turn a wallet/viem error into something a user can act on, preferring the
 * contract's own revert reason over the raw RPC stack.
 */
export function describeError(error: unknown): string {
  // Checked first: this one is not a viem BaseError, and the raw library text
  // ("Provider not found.") does not tell the user what to actually do.
  if (isProviderNotFoundError(error)) {
    return providerNotFoundMessage();
  }

  if (error instanceof BaseError) {
    if (error.walk(inner => inner instanceof UserRejectedRequestError)) {
      return "You rejected the request in your wallet. Nothing was sent on-chain.";
    }

    const reverted = error.walk(
      inner => inner instanceof ContractFunctionRevertedError,
    ) as ContractFunctionRevertedError | null;

    if (reverted) {
      const errorName = getRevertErrorName(reverted);
      if (errorName) {
        return REVERT_MESSAGES[errorName] ?? `The contract rejected the call (${errorName}).`;
      }
      return (
        reverted.reason ??
        reverted.shortMessage ??
        "The transaction would revert on-chain, so it was not sent. No gas was spent."
      );
    }

    return error.shortMessage || error.message;
  }

  if (error instanceof Error) return error.message;
  return "Unknown error.";
}

function getRevertErrorName(error: unknown): string | undefined {
  const data = (error as { data?: unknown }).data;
  if (data && typeof data === "object" && "errorName" in data) {
    const name = (data as { errorName?: unknown }).errorName;
    if (typeof name === "string" && name) return name;
  }
  return undefined;
}

export type FactoryAddress = Address;
