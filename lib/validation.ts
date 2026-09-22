/**
 * Token parameter validation and unit conversion.
 *
 * This module is intentionally free of React, wagmi and viem imports so it can
 * be unit tested in isolation and reused on the server (API routes) as the
 * authoritative validator. The contract enforces the same rules on-chain; the
 * checks here exist to give users a clear message *before* a wallet prompt, not
 * to replace the on-chain checks.
 */

export const MAX_NAME_LENGTH = 32;
export const MAX_SYMBOL_LENGTH = 12;
export const MAX_DECIMALS = 18;
export const MIN_DECIMALS = 0;

/** uint256 upper bound. */
export const MAX_UINT256 = 2n ** 256n - 1n;

/**
 * Sanity cap on the integer part of a human-entered supply.
 *
 * uint256 tops out at ~1.16e77, so with the maximum 18 decimals a supply
 * overflows somewhere around 60 integer digits. The cap catches obviously
 * nonsensical input with a readable message; the precise uint256 comparison
 * further down catches the actual overflow.
 */
export const MAX_SUPPLY_INTEGER_DIGITS = 60;

/** Same charset the original UI accepted. Kept deliberately narrow: the on-chain
 *  limit is 32 UTF-8 bytes, and restricting to printable ASCII makes the
 *  character count and byte count identical. */
const NAME_PATTERN = /^[a-zA-Z0-9 ._-]+$/;
const SYMBOL_PATTERN = /^[a-zA-Z0-9]+$/;
const DECIMALS_PATTERN = /^\d+$/;
const SUPPLY_PATTERN = /^\d+(\.\d+)?$/;

export type TokenFieldErrors = {
  name?: string;
  symbol?: string;
  decimals?: string;
  supply?: string;
};

export type NormalizedTokenInput = {
  name: string;
  symbol: string;
  decimals: number;
  /** Human-readable supply, separators stripped. e.g. "1,000,000" -> "1000000" */
  supply: string;
  /** Supply expressed in base units, already scaled by `decimals`. */
  rawSupply: bigint;
};

export type ValidationResult =
  | { ok: true; value: NormalizedTokenInput }
  | { ok: false; errors: TokenFieldErrors; message: string };

export type RawTokenInput = {
  name: string;
  symbol: string;
  supply: string;
  decimals: string | number;
};

/** Remove the thousands separators people naturally paste in. */
export function stripSeparators(value: string): string {
  return value.replace(/[\s,_]/g, "");
}

/**
 * Convert a validated decimal string to base units.
 *
 * Implemented by hand rather than with `parseUnits` because viem silently
 * truncates surplus decimal places, which would let `1.5` become `1` for a
 * 0-decimal token. Here the caller must have already rejected that case, and
 * this function throws rather than losing precision.
 */
export function toBaseUnits(supply: string, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new Error(`Invalid decimals: ${decimals}`);
  }
  const parts = supply.split(".");
  if (parts.length > 2) throw new Error(`Invalid supply: ${supply}`);

  const whole = parts[0] || "0";
  const fraction = parts[1] ?? "";
  if (fraction.length > decimals) {
    throw new Error(`Supply has more than ${decimals} decimal places.`);
  }

  const padded = fraction.padEnd(decimals, "0");
  const normalizedWhole = whole === "" ? "0" : whole;

  return BigInt(`${normalizedWhole}${padded}`);
}

/** Count the digits before the decimal point. */
function integerDigits(supply: string): number {
  const whole = supply.split(".")[0] ?? "";
  return whole.replace(/^0+(?=\d)/, "").length;
}

function decimalPlaces(supply: string): number {
  return supply.split(".")[1]?.length ?? 0;
}

/**
 * Validate everything the user typed, in field order, and return every problem
 * at once so the form can highlight each input.
 */
export function validateTokenInput(input: RawTokenInput): ValidationResult {
  const errors: TokenFieldErrors = {};

  const name = input.name.trim();
  const symbol = input.symbol.trim().toUpperCase();
  const supply = stripSeparators(String(input.supply ?? ""));
  const decimalsRaw = String(input.decimals ?? "").trim();

  // ---- name -----------------------------------------------------------------
  if (!name) {
    errors.name = "Token name is required.";
  } else if (name.length > MAX_NAME_LENGTH) {
    errors.name = `Name must be ${MAX_NAME_LENGTH} characters or fewer.`;
  } else if (!NAME_PATTERN.test(name)) {
    errors.name = "Name may only contain letters, numbers, spaces or . _ -";
  }

  // ---- symbol ---------------------------------------------------------------
  if (!symbol) {
    errors.symbol = "Token symbol is required.";
  } else if (symbol.length > MAX_SYMBOL_LENGTH) {
    errors.symbol = `Symbol must be ${MAX_SYMBOL_LENGTH} characters or fewer.`;
  } else if (!SYMBOL_PATTERN.test(symbol)) {
    errors.symbol = "Symbol may only contain letters and numbers.";
  }

  // ---- decimals -------------------------------------------------------------
  // Note: "0" is a perfectly valid value and must not be treated as missing.
  let decimals = Number.NaN;
  if (!decimalsRaw) {
    errors.decimals = "Decimals is required. Use 0 for whole-number tokens.";
  } else if (!DECIMALS_PATTERN.test(decimalsRaw)) {
    errors.decimals = "Decimals must be a whole number between 0 and 18.";
  } else {
    decimals = Number(decimalsRaw);
    if (decimals < MIN_DECIMALS || decimals > MAX_DECIMALS) {
      errors.decimals = `Decimals must be between ${MIN_DECIMALS} and ${MAX_DECIMALS}.`;
    }
  }

  // ---- supply ---------------------------------------------------------------
  let rawSupply: bigint | undefined;
  if (!supply) {
    errors.supply = "Supply is required.";
  } else if (!SUPPLY_PATTERN.test(supply)) {
    errors.supply = "Supply must be a positive number, digits only (no letters or symbols).";
  } else if (integerDigits(supply) > MAX_SUPPLY_INTEGER_DIGITS) {
    errors.supply = `Supply is too large. Keep the integer part under ${MAX_SUPPLY_INTEGER_DIGITS} digits.`;
  } else if (Number.isFinite(decimals) && decimalPlaces(supply) > decimals) {
    errors.supply =
      decimals === 0
        ? "This token has 0 decimals, so the supply must be a whole number."
        : `This token has ${decimals} decimals, so the supply cannot have more than ${decimals} decimal places.`;
  } else {
    try {
      rawSupply = toBaseUnits(supply, Number.isFinite(decimals) ? decimals : MIN_DECIMALS);
    } catch {
      errors.supply = "Supply could not be converted. Check the value and decimals.";
    }
  }

  if (rawSupply !== undefined) {
    if (rawSupply === 0n) {
      errors.supply = "Supply must be greater than zero.";
      rawSupply = undefined;
    } else if (rawSupply > MAX_UINT256) {
      errors.supply = "Supply exceeds the maximum value a uint256 can hold.";
      rawSupply = undefined;
    }
  }

  const message = firstError(errors);
  if (message || rawSupply === undefined || !Number.isFinite(decimals)) {
    return { ok: false, errors, message: message || "Check the token parameters and try again." };
  }

  return {
    ok: true,
    value: { name, symbol, decimals, supply, rawSupply },
  };
}

/** First error in form order — the one worth showing next to the submit button. */
export function firstError(errors: TokenFieldErrors): string {
  return errors.name ?? errors.symbol ?? errors.decimals ?? errors.supply ?? "";
}

/** True when every field is individually valid. */
export function isValid(errors: TokenFieldErrors): boolean {
  return !errors.name && !errors.symbol && !errors.supply && !errors.decimals;
}
