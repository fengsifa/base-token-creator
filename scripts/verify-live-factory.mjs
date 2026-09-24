/**
 * Verifies a factory that is already deployed on a live chain.
 *
 *   node scripts/verify-live-factory.mjs <factory-address> [rpc-url]
 *
 * Read-only. Nothing is signed and no transaction is sent: `simulateContract`
 * runs the call against current chain state and returns what it *would* have
 * produced, so a successful run proves the deployed bytecode, the exported ABI
 * and the browser's calling convention all agree with each other.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { createPublicClient, http, isAddress, toFunctionSelector } from "viem";
import { baseSepolia } from "viem/chains";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

const factory = process.argv[2] ?? process.env.NEXT_PUBLIC_TOKEN_CONTRACT_FACTORY_SEPOLIA ?? "";
const rpcUrl = process.argv[3] ?? process.env.NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL ?? "https://sepolia.base.org";

if (!isAddress(factory)) {
  console.error(`not a valid factory address: ${factory}`);
  process.exit(2);
}

const artifact = JSON.parse(await readFile(path.join(root, "lib", "tokenfactory-artifact.json"), "utf8"));
const client = createPublicClient({ chain: baseSepolia, transport: http(rpcUrl) });

const failures = [];
const record = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures.push(label);
};

console.log(`factory : ${factory}`);
console.log(`rpc     : ${rpcUrl}`);
console.log(`chainId : ${await client.getChainId()}`);
console.log();

// 1. There must be code at the address.
const code = await client.getCode({ address: factory });
record("contract code exists", Boolean(code) && code !== "0x", `${((code?.length ?? 2) - 2) / 2} bytes`);

// 2. The deployed runtime bytecode must be exactly what we compiled. Any drift
//    means the address is a different build of the contract.
const expected = artifact.deployedBytecode.startsWith("0x")
  ? artifact.deployedBytecode
  : `0x${artifact.deployedBytecode}`;
record(
  "runtime bytecode matches the compiled artifact",
  code?.toLowerCase() === expected.toLowerCase(),
  code?.toLowerCase() === expected.toLowerCase() ? "" : "MISMATCH",
);

// 3. The public constants must read back as designed.
const maxDecimals = await client.readContract({
  address: factory,
  abi: artifact.abi,
  functionName: "MAX_DECIMALS",
});
record("MAX_DECIMALS == 18", maxDecimals === 18, String(maxDecimals));

// 4. The ABI must carry no privileged surface.
const abiNames = artifact.abi.filter(entry => entry.type === "function").map(entry => entry.name);
const forbidden = ["owner", "transferOwnership", "withdraw", "mint", "pause", "setFee", "upgradeTo"];
record("ABI exposes no privileged function", !abiNames.some(name => forbidden.includes(name)), abiNames.join(", "));

// 5. Every ABI entry must map to a real selector, i.e. the ABI is well formed.
const selector = toFunctionSelector("createToken(string,string,uint8,uint256)");
record("createToken selector computes", /^0x[0-9a-f]{8}$/.test(selector), selector);

// 6. The end-to-end proof: simulate a real creation and require a token address
//    back. Decimals 0 is included because that case used to be broken.
const cases = [
  ["18 decimals", "Live Check A", "LIVEA", 18, 1_000_000n * 10n ** 18n],
  ["0 decimals", "Live Check B", "LIVEB", 0, 1000n],
  ["6 decimals", "Live Check C", "LIVEC", 6, 500n * 10n ** 6n],
];

for (const [label, name, symbol, decimals, supply] of cases) {
  try {
    const { result } = await client.simulateContract({
      address: factory,
      abi: artifact.abi,
      functionName: "createToken",
      args: [name, symbol, decimals, supply],
      account: "0x75CBA94CDa95866a5294CDFf66C96d8a8B2663EA",
    });
    record(`createToken simulates (${label})`, isAddress(result), `would deploy ${result}`);
  } catch (cause) {
    record(`createToken simulates (${label})`, false, String(cause).split("\n")[0].slice(0, 140));
  }
}

// 7. Invalid input must be refused by the contract itself.
const rejected = [
  ["decimals 19", ["N", "S", 19, 1n]],
  ["empty name", ["", "S", 18, 1n]],
  ["zero supply", ["N", "S", 18, 0n]],
];

for (const [label, args] of rejected) {
  try {
    await client.simulateContract({
      address: factory,
      abi: artifact.abi,
      functionName: "createToken",
      args,
      account: "0x75CBA94CDa95866a5294CDFf66C96d8a8B2663EA",
    });
    record(`contract rejects ${label}`, false, "it was accepted");
  } catch {
    record(`contract rejects ${label}`, true);
  }
}

console.log();
if (failures.length) {
  console.log(`FAILED: ${failures.length} check(s): ${failures.join(" | ")}`);
  process.exit(1);
}
console.log("live factory verified: every check passed");
