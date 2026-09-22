import { describe, expect, it } from "vitest";
import { parseUnits } from "viem";
import {
  MAX_UINT256,
  firstError,
  isValid,
  stripSeparators,
  toBaseUnits,
  validateTokenInput,
} from "../../lib/validation";

const good = { name: "My Token", symbol: "MTK", supply: "1000000", decimals: "18" };

describe("validateTokenInput", () => {
  it("accepts a normal 18 decimal token", () => {
    const result = validateTokenInput(good);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.name).toBe("My Token");
    expect(result.value.symbol).toBe("MTK");
    expect(result.value.decimals).toBe(18);
    expect(result.value.rawSupply).toBe(parseUnits("1000000", 18));
  });

  it("upper-cases the symbol", () => {
    const result = validateTokenInput({ ...good, symbol: "mtk" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.symbol).toBe("MTK");
  });

  it("trims surrounding whitespace", () => {
    const result = validateTokenInput({ ...good, name: "  Padded  " });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.name).toBe("Padded");
  });

  describe("names", () => {
    it("rejects an empty name", () => {
      const result = validateTokenInput({ ...good, name: "" });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.errors.name).toMatch(/required/i);
    });

    it("rejects a whitespace-only name", () => {
      const result = validateTokenInput({ ...good, name: "    " });
      expect(result.ok).toBe(false);
    });

    it("accepts exactly 32 characters", () => {
      const result = validateTokenInput({ ...good, name: "n".repeat(32) });
      expect(result.ok).toBe(true);
    });

    it("rejects 33 characters", () => {
      const result = validateTokenInput({ ...good, name: "n".repeat(33) });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.errors.name).toMatch(/32/);
    });

    it("rejects characters the contract could not hold safely", () => {
      const result = validateTokenInput({ ...good, name: "Bad/Name" });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.errors.name).toBeTruthy();
    });

    it("allows the documented punctuation", () => {
      const result = validateTokenInput({ ...good, name: "Base ._- 2" });
      expect(result.ok).toBe(true);
    });
  });

  describe("symbols", () => {
    it("rejects an empty symbol", () => {
      const result = validateTokenInput({ ...good, symbol: "" });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.errors.symbol).toMatch(/required/i);
    });

    it("accepts exactly 12 characters", () => {
      expect(validateTokenInput({ ...good, symbol: "S".repeat(12) }).ok).toBe(true);
    });

    it("rejects 13 characters", () => {
      const result = validateTokenInput({ ...good, symbol: "S".repeat(13) });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.errors.symbol).toMatch(/12/);
    });

    it("rejects non-alphanumeric symbols", () => {
      expect(validateTokenInput({ ...good, symbol: "MT-K" }).ok).toBe(false);
      expect(validateTokenInput({ ...good, symbol: "MT K" }).ok).toBe(false);
    });
  });

  describe("decimals", () => {
    it("accepts 0 — the value that used to be treated as missing", () => {
      const result = validateTokenInput({ ...good, decimals: "0", supply: "1000" });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.decimals).toBe(0);
      expect(result.value.rawSupply).toBe(1000n);
    });

    it("accepts 0 passed as a number", () => {
      const result = validateTokenInput({ ...good, decimals: 0, supply: "1000" });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.decimals).toBe(0);
    });

    it("accepts 18", () => {
      expect(validateTokenInput({ ...good, decimals: "18" }).ok).toBe(true);
    });

    it("rejects an empty value with an explicit hint", () => {
      const result = validateTokenInput({ ...good, decimals: "" });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.errors.decimals).toMatch(/0/);
    });

    it("rejects 19", () => {
      const result = validateTokenInput({ ...good, decimals: "19" });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.errors.decimals).toMatch(/18/);
    });

    it("rejects negatives, fractions and exponents", () => {
      for (const decimals of ["-1", "1.5", "1e2", "0x12"]) {
        expect(validateTokenInput({ ...good, decimals }).ok, decimals).toBe(false);
      }
    });
  });

  describe("supply", () => {
    it("rejects an empty supply", () => {
      const result = validateTokenInput({ ...good, supply: "" });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.errors.supply).toMatch(/required/i);
    });

    it("rejects zero", () => {
      const result = validateTokenInput({ ...good, supply: "0" });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.errors.supply).toMatch(/greater than zero/i);
    });

    it("rejects zero written with decimals", () => {
      expect(validateTokenInput({ ...good, supply: "0.0" }).ok).toBe(false);
    });

    it("rejects negatives and text", () => {
      for (const supply of ["-100", "abc", "1e6", "0x10"]) {
        expect(validateTokenInput({ ...good, supply }).ok, supply).toBe(false);
      }
    });

    it("accepts thousands separators and normalises them away", () => {
      const result = validateTokenInput({ ...good, supply: "1,000,000" });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.supply).toBe("1000000");
      expect(result.value.rawSupply).toBe(parseUnits("1000000", 18));

      expect(validateTokenInput({ ...good, supply: "1 000 000" }).ok).toBe(true);
      expect(validateTokenInput({ ...good, supply: "1_000_000" }).ok).toBe(true);
    });

    it("rejects a fractional supply when decimals is 0", () => {
      const result = validateTokenInput({ ...good, decimals: "0", supply: "1.5" });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.errors.supply).toMatch(/whole number/i);
    });

    it("rejects more decimal places than the token supports", () => {
      const result = validateTokenInput({ ...good, decimals: "2", supply: "1.234" });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.errors.supply).toMatch(/2 decimals/i);
    });

    it("accepts exactly as many decimal places as the token supports", () => {
      const result = validateTokenInput({ ...good, decimals: "2", supply: "1.23" });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.rawSupply).toBe(123n);
    });

    it("rejects an integer part beyond the sanity cap", () => {
      const result = validateTokenInput({ ...good, supply: "9".repeat(61) });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.errors.supply).toMatch(/too large/i);
    });

    it("accepts the largest 18-decimal supply that still fits in uint256", () => {
      const result = validateTokenInput({ ...good, supply: "9".repeat(59) });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.rawSupply).toBeLessThanOrEqual(MAX_UINT256);
    });

    it("rejects a supply that overflows uint256 once scaled by 18 decimals", () => {
      const result = validateTokenInput({ ...good, supply: "9".repeat(60) });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.errors.supply).toMatch(/uint256/i);
    });
  });

  it("reports every invalid field at once", () => {
    const result = validateTokenInput({ name: "", symbol: "", supply: "0", decimals: "99" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.name).toBeTruthy();
    expect(result.errors.symbol).toBeTruthy();
    expect(result.errors.supply).toBeTruthy();
    expect(result.errors.decimals).toBeTruthy();
  });

  it("returns the first error in form order", () => {
    expect(firstError({ symbol: "s", supply: "p", decimals: "d" })).toBe("s");
    expect(firstError({ decimals: "d", supply: "p" })).toBe("d");
    expect(firstError({ supply: "p" })).toBe("p");
    expect(firstError({})).toBe("");
    expect(isValid({})).toBe(true);
    expect(isValid({ name: "x" })).toBe(false);
  });
});

describe("toBaseUnits", () => {
  it("scales by the given decimals", () => {
    expect(toBaseUnits("1000000", 18)).toBe(parseUnits("1000000", 18));
    expect(toBaseUnits("1", 0)).toBe(1n);
    expect(toBaseUnits("1", 6)).toBe(parseUnits("1", 6));
    expect(toBaseUnits("1", 2)).toBe(100n);
  });

  it("pads a short fraction instead of misreading it", () => {
    expect(toBaseUnits("1.5", 18)).toBe(parseUnits("1.5", 18));
    expect(toBaseUnits("0.05", 2)).toBe(5n);
  });

  it("agrees with viem's parseUnits for every valid combination", () => {
    const supplies = ["1", "10", "1000", "0.1", "0.5", "1.25", "999999999", "1000000000000"];
    for (const decimals of [0, 1, 2, 6, 8, 12, 18]) {
      for (const supply of supplies) {
        if (supply.includes(".") && supply.split(".")[1].length > decimals) continue;
        expect(toBaseUnits(supply, decimals), `${supply} @ ${decimals}`).toBe(
          parseUnits(supply as `${number}`, decimals),
        );
      }
    }
  });

  it("throws rather than silently truncating an over-precise value", () => {
    // viem's parseUnits would silently drop the trailing digit here.
    expect(() => toBaseUnits("1.234", 2)).toThrow();
  });

  it("throws when decimals is not a non-negative integer", () => {
    expect(() => toBaseUnits("1", -1)).toThrow();
    expect(() => toBaseUnits("1", 1.5)).toThrow();
  });
});

describe("helpers", () => {
  it("strips separators", () => {
    expect(stripSeparators("1,000 000_000")).toBe("1000000000");
    expect(stripSeparators("1,000,000")).toBe("1000000");
    expect(stripSeparators("1000000")).toBe("1000000");
  });

  it("exposes the uint256 bound", () => {
    expect(MAX_UINT256).toBe(2n ** 256n - 1n);
  });
});
