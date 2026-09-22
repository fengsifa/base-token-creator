import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { compiledTokenFactoryAbi, tokenFactoryAbi, tokenFactoryBytecode } from "../../lib/contracts";

/**
 * Guards the hand-written ABI in lib/contracts.ts against drift from the real
 * contract. A mismatch here is the classic cause of "the frontend calls a
 * function the contract does not have", so it fails the build loudly.
 *
 * The runtime side is checked against the committed artifact, which is what the
 * browser actually uses. When `artifacts/` exists (i.e. after `hardhat compile`)
 * the freshly compiled ABI is checked too, catching a stale commit.
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

const committedArtifactPath = path.join(process.cwd(), "lib", "tokenfactory-artifact.json");
const hardhatArtifactPath = path.join(
  process.cwd(),
  "artifacts",
  "contracts",
  "TokenFactory.sol",
  "TokenFactory.json",
);

const hardhatArtifactExists = existsSync(hardhatArtifactPath);

describe("hand-written ABI", () => {
  it("declares createToken with the exact argument list the contract uses", () => {
    const entry = canonical(tokenFactoryAbi).find(value => value.startsWith("function createToken"));
    expect(entry).toBe("function createToken(string name_,string symbol_,uint8 decimals_,uint256 supply_)->(address token) nonpayable");
  });

  it("declares the TokenCreated event with matching indexing", () => {
    const entry = canonical(tokenFactoryAbi).find(value => value.startsWith("event TokenCreated"));
    expect(entry).toBe(
      "event TokenCreated(indexed address token,indexed address creator,string name,string symbol)",
    );
  });

  it("includes the custom errors so reverts can be decoded for the user", () => {
    const errors = canonical(tokenFactoryAbi).filter(value => value.startsWith("error "));
    expect(errors).toEqual(
      [
        "error DecimalsTooHigh(uint8 decimals_)",
        "error EmptyName()",
        "error EmptySymbol()",
        "error NameTooLong(uint256 length)",
        "error SymbolTooLong(uint256 length)",
        "error ZeroSupply()",
      ].sort(),
    );
  });
});

describe("committed factory artifact", () => {
  const artifact = JSON.parse(readFileSync(committedArtifactPath, "utf8")) as {
    abi: unknown[];
    bytecode: string;
    compiler: string;
  };

  it("is a real build, not the placeholder", () => {
    expect(tokenFactoryBytecode).not.toBe("0x");
    expect(artifact.abi.length).toBeGreaterThan(0);
    expect(artifact.compiler).not.toBe("uncompiled");
  });

  it("bytecode fits inside the EIP-170 contract size limit", () => {
    expect((tokenFactoryBytecode.length - 2) / 2).toBeLessThanOrEqual(24_576);
  });

  it("ABI matches the hand-written one exactly", () => {
    expect(canonical(compiledTokenFactoryAbi)).toEqual(canonical(tokenFactoryAbi));
  });
});

describe.skipIf(!hardhatArtifactExists)("freshly compiled artifact", () => {
  const artifact = JSON.parse(readFileSync(hardhatArtifactPath, "utf8")) as { abi: unknown[] };

  it("matches both the committed artifact and the hand-written ABI", () => {
    const fresh = canonical(artifact.abi);
    expect(fresh).toEqual(canonical(compiledTokenFactoryAbi));
    expect(fresh).toEqual(canonical(tokenFactoryAbi));
  });
});
