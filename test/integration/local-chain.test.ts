import { beforeAll, describe, expect, it } from "vitest";
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  defineChain,
  encodeFunctionData,
  http,
  parseUnits,
  toFunctionSelector,
  type Address,
  type Hex,
  type Log,
  type TransactionReceipt,
} from "viem";
import {
  describeError,
  erc20ReadAbi,
  factoryArtifactReady,
  tokenFactoryAbi,
  tokenFactoryBytecode,
} from "../../lib/contracts";
import { validateTokenInput } from "../../lib/validation";
import { blocksSuccess, verifyTokenCreation } from "../../lib/chain-verify";

/**
 * End-to-end against a real EVM.
 *
 * This mirrors the browser's code path as closely as possible without a wallet:
 *  - the factory is deployed from the very bytecode `/setup` uses,
 *  - `createToken` is called with the same ABI the frontend imports,
 *  - the token address is recovered by decoding the TokenCreated event exactly
 *    like components/creator-form.tsx does,
 *  - the token is then read back through the standard ERC-20 interface.
 *
 * Accounts are Hardhat's local development accounts, which exist only inside the
 * throwaway node started by scripts/run-integration-tests.mjs. No operator key
 * or real funds are involved anywhere in this suite.
 */
const RPC_URL = process.env.LOCAL_RPC_URL ?? "http://127.0.0.1:8545";

const localChain = defineChain({
  id: 31337,
  name: "Hardhat Local",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
});

const transport = http(RPC_URL);
const publicClient = createPublicClient({ chain: localChain, transport });

let accounts: readonly Address[] = [];
let factory: Address;
let creator: Address;
let secondCreator: Address;

/** eth_accounts is a wallet RPC; call it untyped to keep the client generic. */
async function fetchAccounts(): Promise<readonly Address[]> {
  const request = publicClient.request as unknown as (args: {
    method: string;
    params?: unknown[];
  }) => Promise<unknown>;
  return (await request({ method: "eth_accounts", params: [] })) as readonly Address[];
}

function findTokenCreated(logs: readonly Log[]): Address {
  for (const log of logs) {
    if (log.address.toLowerCase() !== factory.toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({
        abi: tokenFactoryAbi,
        eventName: "TokenCreated",
        data: log.data,
        topics: log.topics,
      });
      if (typeof decoded.args.token === "string") return decoded.args.token;
    } catch {
      // unrelated log
    }
  }
  throw new Error("No TokenCreated event was found in the receipt.");
}

async function createToken(
  from: Address,
  name: string,
  symbol: string,
  decimals: number,
  supply: bigint,
): Promise<{ token: Address; txHash: Hex }> {
  const wallet = createWalletClient({ account: from, chain: localChain, transport });
  const txHash = await wallet.writeContract({
    address: factory,
    abi: tokenFactoryAbi,
    functionName: "createToken",
    args: [name, symbol, decimals, supply],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  expect(receipt.status).toBe("success");
  return { token: findTokenCreated(receipt.logs), txHash };
}

async function readToken(token: Address) {
  const [name, symbol, decimals, totalSupply] = await Promise.all([
    publicClient.readContract({ address: token, abi: erc20ReadAbi, functionName: "name" }),
    publicClient.readContract({ address: token, abi: erc20ReadAbi, functionName: "symbol" }),
    publicClient.readContract({ address: token, abi: erc20ReadAbi, functionName: "decimals" }),
    publicClient.readContract({ address: token, abi: erc20ReadAbi, functionName: "totalSupply" }),
  ]);
  return { name, symbol, decimals, totalSupply };
}

/** True when the call reverts, which proves the function does not exist. */
async function callReverts(to: Address, data: Hex, from?: Address): Promise<boolean> {
  try {
    await publicClient.call(from ? { to, data, account: from } : { to, data });
    return false;
  } catch {
    return true;
  }
}

beforeAll(async () => {
  expect(factoryArtifactReady, "the committed factory bytecode must be built").toBe(true);

  accounts = await fetchAccounts();
  expect(accounts.length).toBeGreaterThan(1);
  creator = accounts[0];
  secondCreator = accounts[1];

  const wallet = createWalletClient({ account: creator, chain: localChain, transport });
  const hash = await wallet.deployContract({
    abi: tokenFactoryAbi,
    bytecode: tokenFactoryBytecode,
    args: [],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  expect(receipt.status).toBe("success");
  expect(receipt.contractAddress).toBeTruthy();
  factory = receipt.contractAddress as Address;
});

describe("factory deployed from the browser bytecode", () => {
  it("exists on-chain with bytecode", async () => {
    const code = await publicClient.getBytecode({ address: factory });
    expect(code).toBeTruthy();
    expect(code).not.toBe("0x");
  });

  it("reports the same limits the frontend validates against", async () => {
    const maxName = await publicClient.readContract({
      address: factory,
      abi: tokenFactoryAbi,
      functionName: "MAX_NAME_BYTES",
    });
    const maxSymbol = await publicClient.readContract({
      address: factory,
      abi: tokenFactoryAbi,
      functionName: "MAX_SYMBOL_BYTES",
    });
    const maxDecimals = await publicClient.readContract({
      address: factory,
      abi: tokenFactoryAbi,
      functionName: "MAX_DECIMALS",
    });
    expect(maxName).toBe(32n);
    expect(maxSymbol).toBe(12n);
    expect(maxDecimals).toBe(18);
  });
});

describe("creating a token", () => {
  it("creates a standard 18 decimal token and mints the supply to the creator", async () => {
    const supply = parseUnits("1000000", 18);
    const { token } = await createToken(creator, "Integration Token", "INT", 18, supply);

    const read = await readToken(token);
    expect(read.name).toBe("Integration Token");
    expect(read.symbol).toBe("INT");
    expect(read.decimals).toBe(18);
    expect(read.totalSupply).toBe(supply);

    const balance = await publicClient.readContract({
      address: token,
      abi: erc20ReadAbi,
      functionName: "balanceOf",
      args: [creator],
    });
    expect(balance).toBe(supply);
  });

  it("creates a 0 decimal token — the case that breaks naive truthiness checks", async () => {
    const { token } = await createToken(creator, "Whole Units", "WHOLE", 0, 1000n);
    const read = await readToken(token);
    expect(read.decimals).toBe(0);
    expect(read.totalSupply).toBe(1000n);
  });

  it("keeps the frontend's unit conversion identical to the contract's", async () => {
    const validation = validateTokenInput({
      name: "Precision",
      symbol: "PRC",
      supply: "1234.56789",
      decimals: "6",
    });
    expect(validation.ok).toBe(true);
    if (!validation.ok) return;

    const { token } = await createToken(
      creator,
      validation.value.name,
      validation.value.symbol,
      validation.value.decimals,
      validation.value.rawSupply,
    );

    const read = await readToken(token);
    expect(read.decimals).toBe(6);
    // What the form promised is what the chain holds, to the base unit.
    expect(read.totalSupply).toBe(parseUnits("1234.56789", 6));
    expect(read.totalSupply).toBe(validation.value.rawSupply);
  });

  it("mints to whichever wallet signed, not to the factory deployer", async () => {
    const { token } = await createToken(secondCreator, "Second Wallet", "SEC", 18, 500n);
    const secondBalance = await publicClient.readContract({
      address: token,
      abi: erc20ReadAbi,
      functionName: "balanceOf",
      args: [secondCreator],
    });
    const firstBalance = await publicClient.readContract({
      address: token,
      abi: erc20ReadAbi,
      functionName: "balanceOf",
      args: [creator],
    });
    expect(secondBalance).toBe(500n);
    expect(firstBalance).toBe(0n);
  });

  it("accepts a 32 byte name and a 12 byte symbol", async () => {
    const name = "n".repeat(32);
    const symbol = "s".repeat(12);
    const { token } = await createToken(creator, name, symbol, 18, 1n);
    const read = await readToken(token);
    expect(read.name).toBe(name);
    expect(read.symbol).toBe(symbol);
  });

  it("produces a different contract each time", async () => {
    const first = await createToken(creator, "Unique A", "UNA", 18, 1n);
    const second = await createToken(creator, "Unique B", "UNB", 18, 1n);
    expect(first.token).not.toBe(second.token);
  });
});

describe("on-chain rejection of invalid parameters", () => {
  it("rejects an empty name and explains why to the user", async () => {
    const error = await publicClient
      .simulateContract({
        address: factory,
        abi: tokenFactoryAbi,
        functionName: "createToken",
        args: ["", "SYM", 18, 1n],
        account: creator,
      })
      .then(() => null)
      .catch(cause => cause);

    expect(error).not.toBeNull();
    expect(describeError(error)).toMatch(/name cannot be empty/i);
  });

  it("rejects decimals above 18", async () => {
    const error = await publicClient
      .simulateContract({
        address: factory,
        abi: tokenFactoryAbi,
        functionName: "createToken",
        args: ["Name", "SYM", 19, 1n],
        account: creator,
      })
      .then(() => null)
      .catch(cause => cause);

    expect(error).not.toBeNull();
    expect(describeError(error)).toMatch(/18 or fewer/i);
  });

  it("rejects a zero supply", async () => {
    const error = await publicClient
      .simulateContract({
        address: factory,
        abi: tokenFactoryAbi,
        functionName: "createToken",
        args: ["Name", "SYM", 18, 0n],
        account: creator,
      })
      .then(() => null)
      .catch(cause => cause);

    expect(error).not.toBeNull();
    expect(describeError(error)).toMatch(/greater than zero/i);
  });

  it("rejects an invalid call before it is ever sent, so the user pays no gas", async () => {
    const wallet = createWalletClient({ account: creator, chain: localChain, transport });
    const blockBefore = await publicClient.getBlockNumber();

    const error = await wallet
      .writeContract({
        address: factory,
        abi: tokenFactoryAbi,
        functionName: "createToken",
        args: ["Name", "SYMBOLISTOOLONG", 18, 1n],
      })
      .then(() => null)
      .catch(cause => cause);

    expect(error).not.toBeNull();
    expect(describeError(error)).toMatch(/12 characters/i);

    // viem simulates the call first, so nothing was mined and no gas was spent.
    const blockAfter = await publicClient.getBlockNumber();
    expect(blockAfter).toBe(blockBefore);
  });

  it("never reports success when a transaction fails on-chain", async () => {
    const wallet = createWalletClient({ account: creator, chain: localChain, transport });

    // sendTransaction does not simulate, and 30k gas is far below what deploying
    // a token costs, so this genuinely reaches the chain and reverts there.
    const data = encodeFunctionData({
      abi: tokenFactoryAbi,
      functionName: "createToken",
      args: ["Out Of Gas", "OOG", 18, 1n],
    });

    let receipt: TransactionReceipt | undefined;
    try {
      const hash = await wallet.sendTransaction({ to: factory, data, gas: 30_000n });
      receipt = await publicClient.waitForTransactionReceipt({ hash });
    } catch (cause) {
      // Some nodes refuse an under-gassed transaction at submission instead.
      // That is still a refusal — never a fabricated success.
      expect(String(cause)).toMatch(/gas|revert/i);
      return;
    }

    if (!receipt) {
      expect.unreachable("the transaction was accepted but produced no receipt");
      return;
    }

    expect(receipt.status).toBe("reverted");
    expect(receipt.logs).toHaveLength(0);
    // The frontend's "mined but no TokenCreated event" guard would fire here
    // rather than showing a token address it cannot substantiate.
    expect(() => findTokenCreated(receipt.logs)).toThrow();
  });
});

describe("the created token has no privileged surface", () => {
  let token: Address;

  beforeAll(async () => {
    ({ token } = await createToken(creator, "Hardened", "HARD", 18, 1_000n));
  });

  it("has no mint function, even for the creator", async () => {
    const selector = toFunctionSelector("function mint(address,uint256)");
    const args = `${creator.slice(2).padStart(64, "0")}${(1n).toString(16).padStart(64, "0")}`;
    expect(await callReverts(token, `${selector}${args}` as Hex, creator)).toBe(true);
  });

  it("has no owner function", async () => {
    const selector = toFunctionSelector("function owner()");
    expect(await callReverts(token, selector as Hex, creator)).toBe(true);
  });

  it("has no pause function", async () => {
    const selector = toFunctionSelector("function pause()");
    expect(await callReverts(token, selector as Hex, creator)).toBe(true);
  });

  it("still allows an ordinary transfer, so it is a normal ERC-20", async () => {
    const wallet = createWalletClient({ account: creator, chain: localChain, transport });
    const erc20WriteAbi = [
      {
        type: "function",
        name: "transfer",
        stateMutability: "nonpayable",
        inputs: [
          { name: "to", type: "address" },
          { name: "amount", type: "uint256" },
        ],
        outputs: [{ type: "bool" }],
      },
    ] as const;

    const hash = await wallet.writeContract({
      address: token,
      abi: erc20WriteAbi,
      functionName: "transfer",
      args: [secondCreator, 250n],
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    expect(receipt.status).toBe("success");

    const balance = await publicClient.readContract({
      address: token,
      abi: erc20ReadAbi,
      functionName: "balanceOf",
      args: [secondCreator],
    });
    expect(balance).toBe(250n);
  });
});

/**
 * The server-side check that decides whether a creation record may be stored as
 * a success.
 *
 * These run against the same local EVM the rest of the suite uses, so the receipt
 * and the TokenCreated log are real. The point of the block is that a record can
 * only become successful when the chain agrees — a claim the server cannot
 * substantiate is refused, and that refusal is what stops a fabricated success
 * from ever reaching the records table.
 */
describe("server-side verification of a recorded creation", () => {
  /** The verifier reads config from the environment, so point it at this node. */
  const envFor = () => ({
    NEXT_PUBLIC_BASE_NETWORK: "sepolia",
    NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL: RPC_URL,
    NEXT_PUBLIC_TOKEN_CONTRACT_FACTORY_SEPOLIA: factory,
  });

  it("accepts a real creation and returns the address the factory emitted", async () => {
    const { token, txHash } = await createToken(creator, "Verifiable", "VER", 18, 1000n);

    const outcome = await verifyTokenCreation({
      transactionHash: txHash,
      claimedTokenAddress: token,
      env: envFor(),
    });

    expect(outcome.outcome).toBe("verified");
    if (outcome.outcome !== "verified") return;
    expect(outcome.tokenAddress.toLowerCase()).toBe(token.toLowerCase());
    // A verified outcome must never block the write.
    expect(blocksSuccess(outcome)).toBe(false);
  });

  it("refuses a record that claims a different token than the receipt created", async () => {
    const { txHash } = await createToken(creator, "Honest", "HON", 18, 1000n);
    const claimed = "0x000000000000000000000000000000000000dEaD";

    const outcome = await verifyTokenCreation({
      transactionHash: txHash,
      claimedTokenAddress: claimed,
      env: envFor(),
    });

    expect(outcome.outcome).toBe("mismatch");
    expect(blocksSuccess(outcome)).toBe(true);
  });

  it("refuses a transaction that reverted instead of succeeding", async () => {
    const wallet = createWalletClient({ account: creator, chain: localChain, transport });
    const data = encodeFunctionData({
      abi: tokenFactoryAbi,
      functionName: "createToken",
      args: ["Out Of Gas", "OOG2", 18, 1n],
    });

    let hash: Hex;
    try {
      // 30k gas is far below the cost of deploying a token, so this reaches the
      // chain and reverts there rather than being simulated away.
      hash = await wallet.sendTransaction({ to: factory, data, gas: 30_000n });
    } catch (cause) {
      expect(String(cause)).toMatch(/gas|revert/i);
      return;
    }

    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    expect(receipt.status).toBe("reverted");

    const outcome = await verifyTokenCreation({
      transactionHash: hash,
      claimedTokenAddress: "0x000000000000000000000000000000000000dEaD",
      env: envFor(),
    });

    expect(outcome.outcome).toBe("reverted");
    expect(blocksSuccess(outcome)).toBe(true);
  });

  it("reports an unknown transaction as unverifiable, not as a failure", async () => {
    // A hash nothing mined. This must not be taken for a success, and it must not
    // be treated as a reverted transaction either: a real creation whose RPC is
    // lagging should not lose its record.
    const outcome = await verifyTokenCreation({
      transactionHash: `0x${"c".repeat(64)}`,
      claimedTokenAddress: "0x000000000000000000000000000000000000dEaD",
      env: envFor(),
    });

    expect(outcome.outcome).toBe("unverifiable");
    expect(blocksSuccess(outcome)).toBe(false);
  });

  it("refuses a malformed hash or address before touching the chain", async () => {
    const badHash = await verifyTokenCreation({
      transactionHash: "0x1234",
      claimedTokenAddress: "0x000000000000000000000000000000000000dEaD",
      env: envFor(),
    });
    expect(badHash.outcome).toBe("mismatch");
    expect(blocksSuccess(badHash)).toBe(true);

    const badAddress = await verifyTokenCreation({
      transactionHash: `0x${"d".repeat(64)}`,
      claimedTokenAddress: "0xnotanaddress",
      env: envFor(),
    });
    expect(badAddress.outcome).toBe("mismatch");
    expect(blocksSuccess(badAddress)).toBe(true);
  });

  it("does not accept a token created by a different factory", async () => {
    // A genuine creation from this deployment's factory...
    const { token, txHash } = await createToken(creator, "Claimed Elsewhere", "CE", 18, 1000n);

    // ...but the app is configured with a different factory address. The receipt
    // is real and the token is real; it simply is not *this* deployment's token,
    // so the record must not be accepted as verified.
    const wallet = createWalletClient({ account: secondCreator, chain: localChain, transport });
    const deployHash = await wallet.deployContract({
      abi: tokenFactoryAbi,
      bytecode: tokenFactoryBytecode,
      args: [],
    });
    const deployReceipt = await publicClient.waitForTransactionReceipt({ hash: deployHash });
    const otherFactory = deployReceipt.contractAddress as Address;
    expect(otherFactory.toLowerCase()).not.toBe(factory.toLowerCase());

    const outcome = await verifyTokenCreation({
      transactionHash: txHash,
      claimedTokenAddress: token,
      env: { ...envFor(), NEXT_PUBLIC_TOKEN_CONTRACT_FACTORY_SEPOLIA: otherFactory },
    });

    expect(outcome.outcome).toBe("mismatch");
    expect(blocksSuccess(outcome)).toBe(true);
  });
});
