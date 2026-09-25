/**
 * Admin record query parsing.
 *
 * The regression these guard: a missing `?limit=` was being turned into 1
 * (`Number(null) === 0`, then clamped up to the minimum), so every search
 * returned a single row while reporting the correct total. A default must be the
 * default, not the minimum.
 */
import { describe, expect, it } from "vitest";
import {
  RECORD_LIMIT_DEFAULT,
  RECORD_LIMIT_MAX,
  clampInt,
  parseRecordQuery,
} from "../../lib/record-query";

const WALLET = "0x75CBA94CDa95866a5294CDFf66C96d8a8B2663EA";
const CONTRACT = "0x1111111111111111111111111111111111111111";

describe("clampInt", () => {
  it("uses the default when the value is absent, not the minimum", () => {
    expect(clampInt(null, RECORD_LIMIT_DEFAULT, 1, RECORD_LIMIT_MAX)).toBe(RECORD_LIMIT_DEFAULT);
    expect(clampInt(undefined, 100, 1, 500)).toBe(100);
    expect(clampInt("", 100, 1, 500)).toBe(100);
    expect(clampInt("   ", 100, 1, 500)).toBe(100);
  });

  it("clamps a present value to the bounds", () => {
    expect(clampInt("0", 100, 1, 500)).toBe(1);
    expect(clampInt("-5", 100, 1, 500)).toBe(1);
    expect(clampInt("250", 100, 1, 500)).toBe(250);
    expect(clampInt("9999", 100, 1, 500)).toBe(500);
  });

  it("falls back on an unusable value rather than failing the request", () => {
    expect(clampInt("abc", 100, 1, 500)).toBe(100);
    expect(clampInt("NaN", 100, 1, 500)).toBe(100);
    expect(clampInt("1.7", 100, 1, 500)).toBe(1);
  });

  it("keeps offset 0 as a real value, not as absence", () => {
    expect(clampInt("0", 0, 0, 1000)).toBe(0);
  });
});

describe("parseRecordQuery", () => {
  const parse = (search: string) => parseRecordQuery(new URLSearchParams(search));

  it("defaults to a full page of records", () => {
    const result = parse("");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.filters.limit).toBe(RECORD_LIMIT_DEFAULT);
    expect(result.filters.offset).toBe(0);
    expect(result.filters.wallet).toBe("");
    expect(result.filters.contract).toBe("");
    expect(result.filters.query).toBe("");
    expect(result.filters.status).toBe("");
    expect(result.filters.includeWallets).toBe(false);
  });

  it("accepts a wallet and a contract address", () => {
    const result = parse(`wallet=${WALLET}&contract=${CONTRACT}`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.filters.wallet).toBe(WALLET);
    expect(result.filters.contract).toBe(CONTRACT);
  });

  it("explains which filter is malformed, rather than returning no rows", () => {
    const badWallet = parse("wallet=0x123");
    expect(badWallet.ok).toBe(false);
    if (badWallet.ok) return;
    expect(badWallet.error).toMatch(/wallet/);

    const badContract = parse("contract=nope");
    expect(badContract.ok).toBe(false);
    if (badContract.ok) return;
    expect(badContract.error).toMatch(/contract/);
  });

  it("treats an empty filter as no filter", () => {
    const result = parse("wallet=&contract=&q=&status=");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.filters.wallet).toBe("");
    expect(result.filters.contract).toBe("");
  });

  it("trims what it accepts", () => {
    const result = parse(`wallet=%20${WALLET}%20&q=%20mtk%20`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.filters.wallet).toBe(WALLET);
    expect(result.filters.query).toBe("mtk");
  });

  it("keeps a full page when limit is present but empty", () => {
    const result = parse("limit=");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.filters.limit).toBe(RECORD_LIMIT_DEFAULT);
  });

  it("only asks for the wallet list when explicitly requested", () => {
    const withWallets = parse("wallets=1");
    expect(withWallets.ok).toBe(true);
    if (!withWallets.ok) return;
    expect(withWallets.filters.includeWallets).toBe(true);

    const without = parse("wallets=0");
    expect(without.ok).toBe(true);
    if (!without.ok) return;
    expect(without.filters.includeWallets).toBe(false);
  });
});
