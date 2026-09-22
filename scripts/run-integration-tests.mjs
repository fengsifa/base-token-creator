#!/usr/bin/env node
/**
 * Runs the integration suite against a throwaway local Hardhat node.
 *
 *   node scripts/run-integration-tests.mjs
 *
 * Why a local node instead of Base Sepolia: these tests need to deploy a factory
 * and create tokens dozens of times. Running that against a testnet would need a
 * funded wallet (the operator's) and would be slow and flaky. The Hardhat node is
 * a real EVM, so the bytecode, ABI and event decoding under test are the same
 * ones used on Base Sepolia — only the consensus layer differs.
 *
 * The node is always torn down, including on failure.
 */
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const RPC_URL = process.env.LOCAL_RPC_URL ?? "http://127.0.0.1:8545";

async function resolveBin(pkg, name) {
  const manifest = JSON.parse(
    await readFile(path.join(root, "node_modules", pkg, "package.json"), "utf8"),
  );
  const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.[name];
  if (!bin) throw new Error(`Package ${pkg} does not expose a "${name}" executable.`);
  return path.join(root, "node_modules", pkg, bin);
}

async function waitForRpc(timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(RPC_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
      });
      const body = await response.json();
      if (typeof body.result === "string") return;
    } catch {
      // node not listening yet
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`Hardhat node did not respond on ${RPC_URL} within ${timeoutMs}ms.`);
}

function run(command, args) {
  return new Promise(resolve => {
    const child = spawn(command, args, { cwd: root, stdio: "inherit", env: process.env });
    child.on("exit", code => resolve(code ?? 1));
    child.on("error", () => resolve(1));
  });
}

async function main() {
  const hardhatCli = await resolveBin("hardhat", "hardhat");
  const vitestCli = await resolveBin("vitest", "vitest");

  console.log(`Starting a local Hardhat node on ${RPC_URL} ...`);
  const node = spawn(process.execPath, [hardhatCli, "node"], {
    cwd: root,
    env: { ...process.env, TS_NODE_PROJECT: "tsconfig.hardhat.json" },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let nodeOutput = "";
  node.stdout.on("data", chunk => {
    nodeOutput += chunk.toString();
  });
  node.stderr.on("data", chunk => {
    nodeOutput += chunk.toString();
  });

  let exitCode = 1;
  try {
    await waitForRpc();
    console.log("Node is ready. Running the integration suite ...\n");

    exitCode = await run(process.execPath, [
      vitestCli,
      "run",
      "--config",
      "vitest.integration.config.ts",
    ]);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    console.error("\n--- hardhat node output ---");
    console.error(nodeOutput);
  } finally {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(node.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      node.kill("SIGTERM");
    }
  }

  if (exitCode !== 0) {
    console.error("\nIntegration suite failed.");
  }
  process.exit(exitCode);
}

await main();
