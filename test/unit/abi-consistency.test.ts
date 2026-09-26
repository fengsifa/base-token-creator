import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  compiledLegacyTokenFactoryAbi,
  compiledTokenFactoryAbi,
  factoryBytecode,
  legacyFactoryBytecode,
  legacyTokenFactoryAbi,
  tokenFactoryAbi,
} from "../../lib/contracts";

/**
 * Guards the hand-written ABI in lib/contracts.ts against drift from the real
 * contracts. A mismatch here is the classic cause of "the frontend calls a
 * function the contract does not have", so it fails the build loudly.
 *
 * The runtime side is checked against the committed artifacts, which are what the
 * browser actually uses. When `artifacts/` exists (i.e. after `hardhat compile`)
 * the freshly compiled ABIs are checked too, catching a stale commit.
 */
type AbiEntry = {
  type: string;
  name?: string;
  stateMutability?: string;
  inputs?: Array<{ name?: string; type: string; indexed?: boolean }>;
  outputs?: Array<{ name?: string; type: string }>;
};

function canonical(abi: readonly unknown[]): string[] {
  return (abi as AbiEntry[])
    .map(entry => {
      const inputs = (entry.inputs ?? [])
        .map(input => `${input.indexed ? "indexed " : ""}${input.type}${input.name ? ` ${input.name}` : ""}`)
        .join(",");

      if (entry.type === "function") {
        const outputs = (entry.outputs ?? [])
          .map(output => `${output.type}${output.name ? ` ${output.name}` : ""}`)
          .join(",");
        return `function ${entry.name}(${inputs})->(${outputs}) ${entry.stateMutability}`;
      }
      if (entry.type === "event") return `event ${entry.name}(${inputs})`;
      if (entry.type === "error") return `error ${entry.name}(${inputs})`;
      return `${entry.type} ${entry.name ?? ""}(${inputs})`;
    })
    .sort();
}

/**
 * Everything except the constructor.
 *
 * The two feature factories differ only in their constructor argument list — the
 * core factory takes no burn price because it cannot create a burnable token — so
 * the shared hand-written ABI describes the surface they have in common and the
 * constructor is compared per factory instead.
 */
function withoutConstructor(abi: readonly unknown[]): string[] {
  return canonical((abi as AbiEntry[]).filter(entry => entry.type !== "constructor"));
}

const v2ArtifactPath = path.join(process.cwd(), "lib", "tokenfactory-v2-artifact.json");
const legacyArtifactPath = path.join(process.cwd(), "lib", "tokenfactory-artifact.json");
const hardhatV2Path = path.join(
  process.cwd(),
  "artifacts",
  "contracts",
  "TokenFactoryV2.sol",
  "TokenFactoryCore.json",
);
const hardhatV2BurnablePath = path.join(
  process.cwd(),
  "artifacts",
  "contracts",
  "TokenFactoryV2.sol",
  "TokenFactoryBurnable.json",
);
const hardhatLegacyPath = path.join(
  process.cwd(),
  "artifacts",
  "contracts",
  "TokenFactory.sol",
  "TokenFactory.json",
);

const v2Artifact = JSON.parse(readFileSync(v2ArtifactPath, "utf8")) as {
  compiler: string;
  factories: Record<string, { abi: unknown[]; bytecode: string }>;
};
const legacyArtifact = JSON.parse(readFileSync(legacyArtifactPath, "utf8")) as {
  compiler: string;
  abi: unknown[];
  bytecode: string;
};

describe("hand-written ABI", () => {
  it("declares createToken with the three feature flags and a payable value", () => {
    const entry = canonical(tokenFactoryAbi).find(value => value.startsWith("function createToken"));
    expect(entry).toBe(
      "function createToken(string name_,string symbol_,uint8 decimals_,uint256 supply_,bool burnable_,bool mintable_,bool pausable_)->(address token) payable",
    );
  });

  it("declares feeFor, which is the price the page displays", () => {
    const entry = canonical(tokenFactoryAbi).find(value => value.startsWith("function feeFor"));
    expect(entry).toBe(
      "function feeFor(bool burnable_,bool mintable_,bool pausable_)->(uint256) view",
    );
  });

  it("exposes the individual price components", () => {
    const names = canonical(tokenFactoryAbi)
      .filter(value => value.startsWith("function "))
      .map(value => value.slice("function ".length, value.indexOf("(")));
    for (const name of ["baseFee", "burnFee", "mintFee", "pauseFee", "feeRecipient"]) {
      expect(names, `missing ${name}`).toContain(name);
    }
  });

  it("declares the TokenCreated event with the feature flags and matching indexing", () => {
    const entry = canonical(tokenFactoryAbi).find(value => value.startsWith("event TokenCreated"));
    expect(entry).toBe(
      "event TokenCreated(indexed address token,indexed address creator,string name,string symbol,bool burnable,bool mintable,bool pausable)",
    );
  });

  it("includes the custom errors so reverts can be decoded for the user", () => {
    const errors = canonical(tokenFactoryAbi).filter(value => value.startsWith("error "));
    expect(errors).toEqual(
      [
        "error DecimalsTooHigh(uint8 decimals_)",
        "error EmptyName()",
        "error EmptySymbol()",
        "error FeatureNotSupportedHere()",
        "error FeeTransferFailed()",
        "error InvalidFeeRecipient()",
        "error NameTooLong(uint256 length)",
        "error SymbolTooLong(uint256 length)",
        "error WrongFee(uint256 required,uint256 sent)",
        "error ZeroSupply()",
      ].sort(),
    );
  });

  it("carries no owner, mint, pause or upgrade surface of its own", () => {
    const names = canonical(tokenFactoryAbi)
      .filter(value => value.startsWith("function "))
      .map(value => value.slice("function ".length, value.indexOf("(")));
    for (const forbidden of ["mint", "burn", "pause", "owner", "transferOwnership", "upgradeTo", "setFee"]) {
      expect(names, `unexpected function ${forbidden}`).not.toContain(forbidden);
    }
  });
});

describe("committed factory artifacts", () => {
  it("are real builds, not placeholders", () => {
    expect(factoryBytecode.core).not.toBe("0x");
    expect(factoryBytecode.burnable).not.toBe("0x");
    expect(legacyFactoryBytecode).not.toBe("0x");
    expect(v2Artifact.compiler).not.toBe("uncompiled");
  });

  it("fit inside the EIP-170 contract size limit", () => {
    // This is the constraint that forced two factories: eight variants need
    // 30664 bytes of creation code and one contract may only hold 24576.
    for (const [kind, bytecode] of Object.entries(factoryBytecode)) {
      expect((bytecode.length - 2) / 2, `${kind} creation code`).toBeLessThanOrEqual(24_576);
    }
  });

  it("has no authority over tokens beyond creating them", () => {
    // A factory that could mint into, burn from or pause an existing token would
    // be exactly the hidden backdoor this product promises not to have.
    const names = canonical(compiledTokenFactoryAbi)
      .filter(value => value.startsWith("function "))
      .map(value => value.slice("function ".length, value.indexOf("(")));
    expect(names.sort()).toEqual(
      [
        "MAX_DECIMALS",
        "MAX_NAME_BYTES",
        "MAX_SYMBOL_BYTES",
        "baseFee",
        "burnFee",
        "createToken",
        "feeFor",
        "feeRecipient",
        "mintFee",
        "pauseFee",
      ].sort(),
    );
  });
});

describe("the shared ABI matches the compiled core factory", () => {
  it("is identical once the constructor is set aside", () => {
    expect(withoutConstructor(compiledTokenFactoryAbi)).toEqual(canonical(tokenFactoryAbi));
  });
});

describe("the legacy ABI still matches the deployed original factory", () => {
  it("is unchanged, so verify-live-factory keeps working", () => {
    expect(canonical(compiledLegacyTokenFactoryAbi)).toEqual(canonical(legacyTokenFactoryAbi));
    expect(legacyArtifact.abi.length).toBeGreaterThan(0);
    expect(legacyArtifact.bytecode).toBe(legacyFactoryBytecode);
  });
});

describe.skipIf(!existsSync(hardhatV2Path))("freshly compiled artifacts", () => {
  it("match the committed ones, so the commit is not stale", () => {
    const fresh = JSON.parse(readFileSync(hardhatV2Path, "utf8")) as { abi: unknown[] };
    expect(withoutConstructor(fresh.abi)).toEqual(withoutConstructor(compiledTokenFactoryAbi));
    expect(withoutConstructor(fresh.abi)).toEqual(canonical(tokenFactoryAbi));

    const freshLegacy = JSON.parse(readFileSync(hardhatLegacyPath, "utf8")) as { abi: unknown[] };
    expect(canonical(freshLegacy.abi)).toEqual(canonical(compiledLegacyTokenFactoryAbi));
  });

  it("agree with the burnable factory on everything but the constructor", () => {
    const freshBurnable = JSON.parse(readFileSync(hardhatV2BurnablePath, "utf8")) as { abi: unknown[] };
    expect(withoutConstructor(freshBurnable.abi)).toEqual(canonical(tokenFactoryAbi));

    const constructors = (abi: readonly unknown[]) =>
      (abi as AbiEntry[])
        .filter(entry => entry.type === "constructor")
        .map(entry => (entry.inputs ?? []).map(input => input.type).join(","));

    expect(constructors(freshBurnable.abi)).toEqual(["uint256,uint256,uint256,uint256,address"]);
    expect(constructors(compiledTokenFactoryAbi)).toEqual(["uint256,uint256,uint256,address"]);
  });
});
