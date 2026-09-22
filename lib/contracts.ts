/**
 * Contract interfaces used by the frontend.
 *
 * IMPORTANT: this ABI is hand written so TypeScript keeps literal types (which
 * gives wagmi full autocompletion and compile-time argument checking). It must
 * stay byte-for-byte equivalent to `contracts/TokenFactory.sol`.
 * `test/unit/abi-consistency.test.ts` compares it against the compiled artifact
 * and fails if the two ever drift apart.
 */
import type { Abi, Address, Hex } from "viem";
import { BaseError, ContractFunctionRevertedError, UserRejectedRequestError } from "viem";
import artifact from "./tokenfactory-artifact.json";

export const tokenFactoryAbi = [
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

/** Compiled factory creation code, produced by `npm run sync:artifact`. */
export const tokenFactoryBytecode = (artifact.bytecode ?? "0x") as Hex;

/** The ABI as emitted by solc, kept for the drift check and for tooling. */
export const compiledTokenFactoryAbi = artifact.abi as unknown as Abi;

export const factoryArtifactReady = tokenFactoryBytecode !== "0x";

/** Human wording for the custom errors declared in TokenFactory.sol. */
const REVERT_MESSAGES: Record<string, string> = {
  EmptyName: "The contract rejected the call: the token name cannot be empty.",
  NameTooLong: "The contract rejected the call: the token name is longer than 32 characters.",
  EmptySymbol: "The contract rejected the call: the token symbol cannot be empty.",
  SymbolTooLong: "The contract rejected the call: the token symbol is longer than 12 characters.",
  ZeroSupply: "The contract rejected the call: the supply must be greater than zero.",
  DecimalsTooHigh: "The contract rejected the call: decimals must be 18 or fewer.",
  InvalidDecimals: "The contract rejected the call: decimals must be 18 or fewer.",
  InvalidRecipient: "The contract rejected the call: the recipient address cannot be zero.",
  // OpenZeppelin ERC20
  ERC20InvalidReceiver: "The contract rejected the call: invalid token recipient.",
  ERC20InvalidSender: "The contract rejected the call: invalid token sender.",
};

/**
 * Turn a wallet/viem error into something a user can act on, preferring the
 * contract's own revert reason over the raw RPC stack.
 */
export function describeError(error: unknown): string {
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
