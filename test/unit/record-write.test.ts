/**
 * The record-write planner.
 *
 * The headline test is the regression one: a status update sent while no record
 * id exists must produce a POST that carries the wallet address. The original bug
 * sent a partial payload to POST, and the user was told
 * "wallet_address must be a valid EVM address."
 */
import { describe, expect, it } from "vitest";
import {
  CREATIONS_ENDPOINT,
  checkCreationContext,
  contextToPayload,
  failureWrite,
  isEvmAddress,
  isRecordId,
  planRecordWrite,
  shouldRecreateAsPost,
  successWrite,
  type CreationContext,
} from "../../lib/record-write";

const WALLET = "0x75CBA94CDa95866a5294CDFf66C96d8a8B2663EA";
const RECORD_ID = "5ae29d13-7353-4d21-892d-b23e14edb4e0";
const TOKEN = "0x1111111111111111111111111111111111111111";
const TX = `0x${"a".repeat(64)}`;

const context: CreationContext = {
  walletAddress: WALLET,
  network: "Base Sepolia",
  tokenName: "My Token",
  tokenSymbol: "MTK",
  totalSupply: "1000000",
  decimals: 18,
  logoUrl: null,
  burnable: false,
  mintable: false,
  pausable: false,
};

describe("planRecordWrite", () => {
  it("creates a record from the full context when there is no id yet", () => {
    const plan = planRecordWrite({ recordId: "", context, update: { status: "deploying" } });
    expect(plan.method).toBe("POST");
    expect(plan.url).toBe(CREATIONS_ENDPOINT);
    expect(plan.body.wallet_address).toBe(WALLET);
    expect(plan.body.network).toBe("Base Sepolia");
    expect(plan.body.token_name).toBe("My Token");
    expect(plan.body.status).toBe("deploying");
  });

  it("REGRESSION: a status-only update with no id still sends the wallet address", () => {
    // This is the exact shape that used to be POSTed on its own, producing
    // "wallet_address must be a valid EVM address."
    const plan = planRecordWrite({
      recordId: "",
      context,
      update: { status: "success", token_contract_address: TOKEN, transaction_hash: TX },
    });

    expect(plan.method).toBe("POST");
    expect(plan.body.wallet_address).toBe(WALLET);
    expect(plan.body.network).toBe("Base Sepolia");
    expect(plan.body.token_symbol).toBe("MTK");
    expect(plan.body.status).toBe("success");
    expect(plan.body.token_contract_address).toBe(TOKEN);
    expect(plan.body.transaction_hash).toBe(TX);
  });

  it("patches when the record exists and there is something to change", () => {
    const plan = planRecordWrite({
      recordId: RECORD_ID,
      context,
      update: { status: "success" },
    });
    expect(plan.method).toBe("PATCH");
    expect(plan.url).toBe(`${CREATIONS_ENDPOINT}/${RECORD_ID}`);
    expect(plan.body).toEqual({ status: "success" });
  });

  it("treats an unusable id as no id, so a bad stored value cannot cause a partial write", () => {
    for (const recordId of ["", "not-a-uuid", "5ae29d13-7353-4d21-892d", "   "]) {
      const plan = planRecordWrite({ recordId, context, update: { status: "success" } });
      expect(plan.method, recordId).toBe("POST");
      expect(plan.body.wallet_address, recordId).toBe(WALLET);
    }
  });

  it("never lets an update overwrite the identity of the creation", () => {
    const plan = planRecordWrite({
      recordId: "",
      context,
      update: { wallet_address: "0xdeadbeef", network: "Somewhere", token_symbol: "HACK" },
    });
    expect(plan.body.wallet_address).toBe(WALLET);
    expect(plan.body.network).toBe("Base Sepolia");
    expect(plan.body.token_symbol).toBe("MTK");
  });

  it("explains itself, so a log line is enough to see which branch ran", () => {
    expect(planRecordWrite({ recordId: "", context, update: {} }).reason).toMatch(/first write/i);
    expect(
      planRecordWrite({ recordId: "", context, update: { status: "success" } }).reason,
    ).toMatch(/full context/i);
  });
});

describe("shouldRecreateAsPost", () => {
  it("turns a vanished record into a create", () => {
    expect(shouldRecreateAsPost(404, "PATCH")).toBe(true);
  });

  it("leaves other outcomes alone", () => {
    expect(shouldRecreateAsPost(404, "POST")).toBe(false);
    expect(shouldRecreateAsPost(500, "PATCH")).toBe(false);
    expect(shouldRecreateAsPost(400, "PATCH")).toBe(false);
  });
});

describe("checkCreationContext", () => {
  it("accepts a complete context", () => {
    expect(checkCreationContext(context)).toEqual([]);
  });

  it("accepts decimals of 0", () => {
    expect(checkCreationContext({ ...context, decimals: 0 })).toEqual([]);
  });

  it("reports a missing wallet with an actionable message", () => {
    const problems = checkCreationContext({ ...context, walletAddress: "" });
    expect(problems.join(" ")).toMatch(/wallet address/i);
  });

  it("reports a malformed wallet", () => {
    for (const walletAddress of ["0x123", "75CBA94CDa95866a5294CDFf66C96d8a8B2663EA", "0xZZ"]) {
      expect(checkCreationContext({ ...context, walletAddress }).join(" ")).toMatch(/wallet address/i);
    }
  });

  it("rejects decimals outside 0..18 and non-integers", () => {
    for (const decimals of [-1, 19, 1.5, Number.NaN]) {
      expect(checkCreationContext({ ...context, decimals }).join(" ")).toMatch(/decimals/i);
    }
  });

  it("reports everything that is missing rather than only the first problem", () => {
    const problems = checkCreationContext({
      walletAddress: "",
      network: "",
      tokenName: "",
      tokenSymbol: "",
      totalSupply: "",
      decimals: 99,
    });
    expect(problems.length).toBeGreaterThanOrEqual(6);
  });
});

describe("contextToPayload", () => {
  it("maps the context onto the API's column names", () => {
    expect(contextToPayload(context)).toEqual({
      wallet_address: WALLET,
      network: "Base Sepolia",
      token_name: "My Token",
      token_symbol: "MTK",
      total_supply: "1000000",
      decimals: 18,
      logo_url: null,
      burnable: false,
      mintable: false,
      pausable: false,
    });
  });

  it("trims values so a stray space cannot fail validation", () => {
    const payload = contextToPayload({ ...context, walletAddress: `  ${WALLET}  ` });
    expect(payload.wallet_address).toBe(WALLET);
  });
});

describe("successWrite", () => {
  it("carries the token address and the transaction hash", () => {
    expect(successWrite({ tokenAddress: TOKEN, transactionHash: TX })).toEqual({
      status: "success",
      token_contract_address: TOKEN,
      transaction_hash: TX,
    });
  });

  it("writes nothing that would make it unverifiable", () => {
    const update = successWrite({ tokenAddress: TOKEN, transactionHash: TX });
    expect(Object.keys(update).sort()).toEqual([
      "status",
      "token_contract_address",
      "transaction_hash",
    ]);
  });
});

describe("failureWrite", () => {
  it("records the failure and its reason", () => {
    expect(failureWrite({ status: "failed", reason: "The transaction reverted." })).toEqual({
      status: "failed",
      verification_note: "The transaction reverted.",
    });
  });

  it("never invents a token address or a transaction hash", () => {
    const update = failureWrite({ status: "deployment_cancelled", reason: "wallet rejected" });
    expect(update).not.toHaveProperty("token_contract_address");
    expect(update).not.toHaveProperty("transaction_hash");
    expect(update.status).not.toBe("success");
  });
});

describe("isRecordId / isEvmAddress", () => {
  it("only accepts a real UUID", () => {
    expect(isRecordId(RECORD_ID)).toBe(true);
    expect(isRecordId("")).toBe(false);
    expect(isRecordId("abc")).toBe(false);
    expect(isRecordId(null)).toBe(false);
    expect(isRecordId(42)).toBe(false);
  });

  it("only accepts a 20-byte hex address", () => {
    expect(isEvmAddress(WALLET)).toBe(true);
    expect(isEvmAddress(`  ${WALLET}  `)).toBe(true);
    expect(isEvmAddress("0x123")).toBe(false);
    expect(isEvmAddress(undefined)).toBe(false);
  });
});
