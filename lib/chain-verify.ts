/**
 * Server-side confirmation that a creation actually happened on chain.
 *
 * The client only marks a record successful after it has decoded a TokenCreated
 * event out of a mined receipt, and that is good. But the client is not a
 * trustworthy witness: the record table is writable through an API, so a
 * hand-crafted request could otherwise assert any token address it liked. Since
 * the whole point of this feature is an accurate record of what the chain did,
 * the server re-checks the chain itself before it will store `success`.
 *
 * The outcomes are deliberately distinct:
 *
 *   verified      the receipt succeeded and one of our factories emitted the claimed token
 *   reverted      the receipt exists and says the transaction failed
 *   mismatch      the receipt succeeded but produced a different token address
 *   unverifiable  the chain could not be consulted, or the transaction is not
 *                 visible yet
 *
 * Only `reverted` and `mismatch` are treated as grounds to refuse a success
 * write. `unverifiable` stores the record but leaves `chain_verified` false and
 * records why, because refusing a real creation due to a flaky RPC would lose
 * the record of a token that genuinely exists. Nothing here ever upgrades an
 * unverifiable claim into a verified one.
 */
import { createPublicClient, decodeEventLog, http, isAddress, type Hex } from "viem";
import { base, baseSepolia } from "viem/chains";
import { resolveConfig } from "./config";
import { factoryEventAbis } from "./contracts";

export type VerifyOutcome =
  | { outcome: "verified"; tokenAddress: string; factoryAddress: string }
  | { outcome: "reverted"; reason: string }
  | { outcome: "mismatch"; reason: string }
  | { outcome: "unverifiable"; reason: string };

const TX_HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;

/** Never let a slow RPC hold a record write open indefinitely. */
const RPC_TIMEOUT_MS = 8_000;

/**
 * Confirm a claimed token creation.
 *
 * `claimedTokenAddress` may be empty: a caller might want to know whether the
 * transaction succeeded at all. An empty claim can still be verified as
 * "produced some token", but only an exact match is reported as verified.
 */
export async function verifyTokenCreation(args: {
  transactionHash: string;
  claimedTokenAddress: string;
  env?: Record<string, string | undefined>;
}): Promise<VerifyOutcome> {
  const { transactionHash, claimedTokenAddress } = args;

  if (!TX_HASH_PATTERN.test(transactionHash)) {
    return { outcome: "mismatch", reason: "The transaction hash is not a 32-byte hex value." };
  }
  if (claimedTokenAddress && !isAddress(claimedTokenAddress)) {
    return { outcome: "mismatch", reason: "The claimed token address is not a valid EVM address." };
  }

  const config = resolveConfig(args.env ?? process.env);
  /**
   * Both factories count, and neither is optional: a creation is routed to one
   * or the other depending on whether Burnable was selected, so checking only
   * the core address would report every burnable token as unverifiable.
   */
  const factoryAddresses = [config.factoryCoreAddress, config.factoryBurnableAddress]
    .filter(value => value.length > 0)
    .map(value => value.toLowerCase());

  if (factoryAddresses.length === 0) {
    return {
      outcome: "unverifiable",
      reason: "No factory address is configured on this deployment, so the chain cannot be consulted.",
    };
  }

  try {
    const client = createPublicClient({
      chain: config.networkKey === "mainnet" ? base : baseSepolia,
      transport: http(config.rpcUrl, { timeout: RPC_TIMEOUT_MS, retryCount: 1 }),
    });

    const receipt = await client.getTransactionReceipt({ hash: transactionHash as Hex });

    if (!receipt) {
      return { outcome: "unverifiable", reason: "The transaction is not visible on this RPC yet." };
    }
    if (receipt.status !== "success") {
      return {
        outcome: "reverted",
        reason: `The transaction reverted on chain (block ${receipt.blockNumber}), so no token was created.`,
      };
    }

    const emitted: string[] = [];
    /** The factory that actually emitted, taken from the log rather than assumed. */
    let emittingFactory = "";

    for (const log of receipt.logs) {
      if (!factoryAddresses.includes(log.address.toLowerCase())) continue;

      // Two event shapes exist: the current factory's TokenCreated carries the
      // three feature flags, the original one does not. Their signatures differ,
      // so exactly one ABI will decode a given log; try both and keep whichever
      // works rather than guessing from the address.
      for (const abi of factoryEventAbis) {
        try {
          const decoded = decodeEventLog({
            abi,
            eventName: "TokenCreated",
            data: log.data,
            topics: log.topics,
          });
          const token = (decoded.args as { token?: unknown }).token;
          if (typeof token === "string" && isAddress(token)) {
            emitted.push(token);
            emittingFactory = log.address;
          }
          break;
        } catch {
          // Not this shape; try the next one.
        }
      }
    }

    if (emitted.length === 0) {
      return {
        outcome: "mismatch",
        reason:
          "The transaction succeeded but emitted no TokenCreated event from a configured factory, so it did not create a token through this deployment.",
      };
    }

    if (!claimedTokenAddress) {
      return {
        outcome: "unverifiable",
        reason: `The transaction created token ${emitted[0]} but no address was claimed, so the match cannot be confirmed.`,
      };
    }

    const match = emitted.find(token => token.toLowerCase() === claimedTokenAddress.toLowerCase());
    if (!match) {
      return {
        outcome: "mismatch",
        reason: `The receipt created ${emitted.join(", ")} but the record claims ${claimedTokenAddress}.`,
      };
    }

    return { outcome: "verified", tokenAddress: match, factoryAddress: emittingFactory };
  } catch (cause) {
    return {
      outcome: "unverifiable",
      reason: `The chain could not be consulted: ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }
}

/** True when the outcome must block a record from being stored as `success`. */
export function blocksSuccess(outcome: VerifyOutcome): boolean {
  return outcome.outcome === "reverted" || outcome.outcome === "mismatch";
}

export function describeOutcome(outcome: VerifyOutcome): string {
  switch (outcome.outcome) {
    case "verified":
      return `Verified on chain: the factory emitted this token address at ${outcome.factoryAddress}.`;
    case "reverted":
      return `Not verified: ${outcome.reason}`;
    case "mismatch":
      return `Not verified: ${outcome.reason}`;
    case "unverifiable":
      return `Not verified: ${outcome.reason}`;
  }
}
