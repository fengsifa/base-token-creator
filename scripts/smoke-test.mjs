#!/usr/bin/env node
/**
 * Smoke test for the built application.
 *
 *   npm run build && npm run test:smoke
 *
 * Boots the production server and checks that every page renders server-side
 * with no wallet connected, and that the creation API rejects invalid input
 * while accepting a valid decimals = 0 payload.
 *
 * The database is expected to be unreachable here. That is deliberate: the chain
 * is the source of truth and the app must keep working when PostgreSQL is down,
 * so a 503 from the record mirror is a pass, while a 400 (validation refusal)
 * would be a real failure.
 */
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const PORT = Number(process.env.SMOKE_PORT ?? 3123);
const BASE_URL = `http://127.0.0.1:${PORT}`;

const results = [];

function record(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

async function resolveNextBin() {
  const manifest = JSON.parse(
    await readFile(path.join(root, "node_modules", "next", "package.json"), "utf8"),
  );
  const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.next;
  return path.join(root, "node_modules", "next", bin);
}

async function waitForServer(timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE_URL}/`, { redirect: "manual" });
      if (response.status > 0) return;
    } catch {
      // not listening yet
    }
    await new Promise(resolve => setTimeout(resolve, 400));
  }
  throw new Error(`Server did not start on ${BASE_URL} within ${timeoutMs}ms.`);
}

async function get(pathname) {
  const response = await fetch(`${BASE_URL}${pathname}`);
  return { status: response.status, html: await response.text() };
}

async function postJson(pathname, body) {
  const response = await fetch(`${BASE_URL}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const parsed = await response.json().catch(() => ({}));
  return { status: response.status, body: parsed };
}

const VALID_ADDRESS = "0x000000000000000000000000000000000000dEaD";

async function main() {
  const nextBin = await resolveNextBin();

  console.log(`Starting the production server on ${BASE_URL} ...`);
  const server = spawn(process.execPath, [nextBin, "start", "-p", String(PORT)], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      NODE_ENV: "production",
      // Deliberately no factory address and no database: the app must degrade
      // with a clear message rather than crash.
      DATABASE_URL: "",
      NEXT_PUBLIC_TOKEN_CONTRACT_FACTORY_SEPOLIA: "",
    },
  });

  let serverLog = "";
  server.stdout.on("data", chunk => {
    serverLog += chunk.toString();
  });
  server.stderr.on("data", chunk => {
    serverLog += chunk.toString();
  });

  let exitCode = 0;
  try {
    await waitForServer();

    // ---- pages render without a wallet ------------------------------------
    const home = await get("/");
    record("GET / returns 200", home.status === 200, `status ${home.status}`);
    record("GET / shows the brand", home.html.includes("Tokenbase"));

    const creator = await get("/creator");
    record("GET /creator returns 200", creator.status === 200, `status ${creator.status}`);
    record(
      "GET /creator renders without a connected wallet",
      creator.html.includes("Connect Wallet"),
    );
    record(
      "GET /creator states the missing factory instead of pretending",
      creator.html.includes("Token Factory is not configured yet"),
    );
    // The generic config issue for a missing factory must not be printed as well:
    // the page already shows one dedicated, actionable notice for it.
    record(
      "GET /creator does not repeat the missing-factory notice twice",
      !creator.html.includes("Token Factory address is not configured for"),
    );
    record("GET /creator shows the token parameter form", creator.html.includes("Decimals"));
    record("GET /creator shows base units preview logic", creator.html.includes("base units"));

    const setup = await get("/setup");
    record("GET /setup returns 200", setup.status === 200, `status ${setup.status}`);
    // Without a wallet the action button reads "Connect Wallet", so assert on the
    // page heading, which is what actually identifies the factory setup screen.
    record(
      "GET /setup offers the factory deployment",
      setup.html.includes("Deploy the Token Factory"),
    );
    // The wallet requirement must be visible before anything is clicked, so a
    // missing extension is never discovered as a raw library error.
    record(
      "GET /setup states the wallet requirement up front",
      setup.html.includes("Requires a browser wallet extension such as MetaMask"),
    );
    // Server render has no window.ethereum, so the creator page must already
    // explain the missing wallet rather than showing a bare connect button.
    record(
      "GET /creator explains the missing wallet instead of failing silently",
      creator.html.includes("No browser wallet was found on this page"),
    );

    const admin = await get("/admin");
    record("GET /admin returns 200", admin.status === 200, `status ${admin.status}`);
    record("GET /admin asks for the admin secret", admin.html.includes("Admin sign-in"));

    // ---- creation API validation ----------------------------------------
    const zeroDecimals = await postJson("/api/creations", {
      wallet_address: VALID_ADDRESS,
      network: "Base Sepolia",
      token_name: "Zero Decimals",
      token_symbol: "ZERO",
      total_supply: "1000",
      decimals: 0,
      status: "deploying",
    });
    record(
      "POST /api/creations accepts decimals = 0",
      zeroDecimals.status !== 400,
      `status ${zeroDecimals.status}${zeroDecimals.body?.error ? ` — ${zeroDecimals.body.error}` : ""}`,
    );

    const badDecimals = await postJson("/api/creations", {
      wallet_address: VALID_ADDRESS,
      network: "Base Sepolia",
      token_name: "Bad Decimals",
      token_symbol: "BAD",
      total_supply: "1000",
      decimals: 19,
    });
    record("POST /api/creations rejects decimals = 19", badDecimals.status === 400, `status ${badDecimals.status}`);

    const badName = await postJson("/api/creations", {
      wallet_address: VALID_ADDRESS,
      network: "Base Sepolia",
      token_name: "",
      token_symbol: "NONAME",
      total_supply: "1000",
      decimals: 18,
    });
    record("POST /api/creations rejects an empty name", badName.status === 400, `status ${badName.status}`);

    const badWallet = await postJson("/api/creations", {
      wallet_address: "not-an-address",
      network: "Base Sepolia",
      token_name: "Name",
      token_symbol: "SYM",
      total_supply: "1000",
      decimals: 18,
    });
    record("POST /api/creations rejects a bad wallet address", badWallet.status === 400, `status ${badWallet.status}`);

    const supplyZero = await postJson("/api/creations", {
      wallet_address: VALID_ADDRESS,
      network: "Base Sepolia",
      token_name: "Name",
      token_symbol: "SYM",
      total_supply: "0",
      decimals: 18,
    });
    record("POST /api/creations rejects a zero supply", supplyZero.status === 400, `status ${supplyZero.status}`);
  } catch (error) {
    record("smoke run", false, error instanceof Error ? error.message : String(error));
    console.error("\n--- server output ---");
    console.error(serverLog.slice(-4000));
  } finally {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(server.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      server.kill("SIGTERM");
    }
  }

  const failed = results.filter(result => !result.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length > 0) exitCode = 1;
  process.exit(exitCode);
}

await main();
