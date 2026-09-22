import { describe, expect, it } from "vitest";
import { getAddress, isAddress } from "viem";
import {
  MIN_SERVICE_FEE_ETH,
  feeToWei,
  normalizeAddress,
  normalizeFee,
  resolveConfig,
} from "../../lib/config";

const VALID = "0x1234567890abcdef1234567890abcdef12345678";
const OTHER = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";

describe("resolveConfig", () => {
  it("defaults to Base Sepolia with an unconfigured factory and no false alarms", () => {
    const config = resolveConfig({});
    expect(config.networkKey).toBe("sepolia");
    expect(config.chainId).toBe(84532);
    expect(config.chainName).toBe("Base Sepolia");
    expect(config.explorerBase).toBe("https://sepolia.basescan.org");
    expect(config.rpcUrl).toBe("https://sepolia.base.org");
    expect(config.factoryAddress).toBe("");
    expect(config.feeEth).toBe("0");
    // A factory that has not been deployed is a state, not a misconfiguration,
    // so the config reports no issue at all for it.
    expect(config.factoryAddress).toBe("");
    expect(config.issues).toEqual([]);
  });

  it("switches to Base mainnet when asked", () => {
    const config = resolveConfig({ NEXT_PUBLIC_BASE_NETWORK: "mainnet" });
    expect(config.networkKey).toBe("mainnet");
    expect(config.chainId).toBe(8453);
    expect(config.explorerBase).toBe("https://basescan.org");
    expect(config.rpcUrl).toBe("https://mainnet.base.org");
  });

  it("still honours the legacy server-only BASE_NETWORK variable", () => {
    expect(resolveConfig({ BASE_NETWORK: "mainnet" }).networkKey).toBe("mainnet");
  });

  it("lets the NEXT_PUBLIC variable win over the legacy one", () => {
    const config = resolveConfig({
      BASE_NETWORK: "mainnet",
      NEXT_PUBLIC_BASE_NETWORK: "sepolia",
    });
    expect(config.networkKey).toBe("sepolia");
  });

  it("treats an unrecognised network as sepolia rather than guessing", () => {
    expect(resolveConfig({ NEXT_PUBLIC_BASE_NETWORK: "polygon" }).networkKey).toBe("sepolia");
  });

  describe("factory address", () => {
    it("returns the checksummed address", () => {
      const config = resolveConfig({ NEXT_PUBLIC_TOKEN_CONTRACT_FACTORY_SEPOLIA: VALID });
      expect(config.factoryAddress.toLowerCase()).toBe(VALID);
      // The stored form must survive a strict checksum check.
      expect(isAddress(config.factoryAddress)).toBe(true);
      expect(config.issues).toEqual([]);
    });

    it("accepts an address that is already checksummed", () => {
      const checksummed = getAddress(VALID);
      expect(
        resolveConfig({ NEXT_PUBLIC_TOKEN_CONTRACT_FACTORY_SEPOLIA: checksummed }).factoryAddress,
      ).toBe(checksummed);
    });

    it("ignores a malformed address and says so instead of pretending it works", () => {
      const config = resolveConfig({ NEXT_PUBLIC_TOKEN_CONTRACT_FACTORY_SEPOLIA: "0xnot-an-address" });
      expect(config.factoryAddress).toBe("");
      expect(config.issues.map(issue => issue.message).join(" ")).toMatch(/not a valid EVM address/i);
    });

    it("falls back to the unsuffixed variable", () => {
      const config = resolveConfig({ NEXT_PUBLIC_TOKEN_CONTRACT_FACTORY: VALID });
      expect(config.factoryAddress).toBeTruthy();
    });

    it("prefers the network specific variable", () => {
      const config = resolveConfig({
        NEXT_PUBLIC_TOKEN_CONTRACT_FACTORY: VALID,
        NEXT_PUBLIC_TOKEN_CONTRACT_FACTORY_SEPOLIA: OTHER,
      });
      expect(config.factoryAddress?.toLowerCase()).toBe(OTHER);
    });

    it("does not reuse the sepolia factory on mainnet", () => {
      const config = resolveConfig({
        NEXT_PUBLIC_BASE_NETWORK: "mainnet",
        NEXT_PUBLIC_TOKEN_CONTRACT_FACTORY_SEPOLIA: VALID,
      });
      expect(config.factoryAddress).toBe("");
    });
  });

  describe("service fee", () => {
    it("defaults to free mode", () => {
      const config = resolveConfig({});
      expect(config.feeEth).toBe("0");
      expect(feeToWei(config.feeEth)).toBe(0n);
    });

    it("keeps a fee at or above the minimum", () => {
      const config = resolveConfig({
        NEXT_PUBLIC_TOKEN_CREATOR_FEE_SEPOLIA: MIN_SERVICE_FEE_ETH,
        NEXT_PUBLIC_TOKEN_CREATOR_FEE_RECIPIENT_SEPOLIA: VALID,
      });
      expect(config.feeEth).toBe(MIN_SERVICE_FEE_ETH);
      expect(feeToWei(config.feeEth)).toBe(100_000_000_000_000n);
      // No fee-related complaint: the fee and its recipient are both configured.
      expect(config.issues.map(issue => issue.message).join(" ")).not.toMatch(/below the|not a valid ETH amount|fee recipient/i);
    });

    it("raises a dust fee to the minimum", () => {
      const config = resolveConfig({
        NEXT_PUBLIC_TOKEN_CREATOR_FEE_SEPOLIA: "0.0000001",
        NEXT_PUBLIC_TOKEN_CREATOR_FEE_RECIPIENT_SEPOLIA: VALID,
      });
      expect(config.feeEth).toBe(MIN_SERVICE_FEE_ETH);
      expect(config.issues.map(issue => issue.message).join(" ")).toMatch(/below the .* minimum/i);
    });

    it("does not raise an explicit zero", () => {
      const config = resolveConfig({ NEXT_PUBLIC_TOKEN_CREATOR_FEE_SEPOLIA: "0" });
      expect(config.feeEth).toBe("0");
      expect(config.issues.map(issue => issue.message).join(" ")).not.toMatch(/below the/i);
    });

    it("degrades an unparseable fee to zero", () => {
      const config = resolveConfig({ NEXT_PUBLIC_TOKEN_CREATOR_FEE_SEPOLIA: "abc" });
      expect(config.feeEth).toBe("0");
      expect(config.issues.map(issue => issue.message).join(" ")).toMatch(/not a valid ETH amount/i);
    });

    it("flags a non-zero fee that has no recipient", () => {
      const config = resolveConfig({
        NEXT_PUBLIC_TOKEN_CREATOR_FEE_SEPOLIA: MIN_SERVICE_FEE_ETH,
      });
      expect(config.issues.map(issue => issue.message).join(" ")).toMatch(/no valid fee recipient/i);
    });

    it("does not flag a missing recipient in free mode", () => {
      const config = resolveConfig({});
      expect(config.issues.map(issue => issue.message).join(" ")).not.toMatch(/fee recipient/i);
    });

    it("ignores an invalid recipient and says so", () => {
      const config = resolveConfig({
        NEXT_PUBLIC_TOKEN_CREATOR_FEE_RECIPIENT_SEPOLIA: "0x1234",
      });
      expect(config.feeRecipient).toBe("");
      expect(config.issues.map(issue => issue.message).join(" ")).toMatch(/not a valid EVM address/i);
    });
  });

  describe("rpc", () => {
    it("uses the public default when nothing is set", () => {
      expect(resolveConfig({}).rpcUrl).toBe("https://sepolia.base.org");
    });

    it("honours a custom rpc url", () => {
      expect(resolveConfig({ NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL: "https://rpc.example" }).rpcUrl).toBe(
        "https://rpc.example",
      );
    });

    it("supports the legacy unsuffixed alias", () => {
      expect(resolveConfig({ NEXT_PUBLIC_BASE_RPC_URL: "https://legacy.example" }).rpcUrl).toBe(
        "https://legacy.example",
      );
    });
  });

  it("passes the walletconnect project id through", () => {
    expect(resolveConfig({ NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID: "abc" }).walletConnectProjectId).toBe("abc");
    expect(resolveConfig({}).walletConnectProjectId).toBe("");
  });

  it("never reports a missing factory as a configuration issue", () => {
    // Guards the fix for a duplicated notice: the creator page shows its own,
    // actionable call to action for this, and a generic issue would be rendered
    // a second time — in the page AND in the serialised client payload.
    const missing = resolveConfig({});
    expect(missing.factoryAddress).toBe("");
    expect(missing.issues).toEqual([]);

    const configured = resolveConfig({ NEXT_PUBLIC_TOKEN_CONTRACT_FACTORY_SEPOLIA: VALID });
    expect(configured.factoryAddress).toBeTruthy();
    expect(configured.issues).toEqual([]);
  });

  it("still reports an address that was supplied but is malformed", () => {
    const config = resolveConfig({ NEXT_PUBLIC_TOKEN_CONTRACT_FACTORY_SEPOLIA: "0xnope" });
    expect(config.issues.map(issue => issue.code)).toEqual(["factory-address-invalid"]);
  });

  it("tags the fee issues with distinct codes", () => {
    expect(
      resolveConfig({ NEXT_PUBLIC_TOKEN_CREATOR_FEE_SEPOLIA: "abc" }).issues.map(i => i.code),
    ).toContain("fee-invalid");

    expect(
      resolveConfig({ NEXT_PUBLIC_TOKEN_CREATOR_FEE_SEPOLIA: "0.0000001" }).issues.map(i => i.code),
    ).toContain("fee-below-minimum");

    expect(
      resolveConfig({ NEXT_PUBLIC_TOKEN_CREATOR_FEE_SEPOLIA: MIN_SERVICE_FEE_ETH }).issues.map(
        i => i.code,
      ),
    ).toContain("fee-recipient-missing");

    expect(
      resolveConfig({ NEXT_PUBLIC_TOKEN_CREATOR_FEE_RECIPIENT_SEPOLIA: "0x1234" }).issues.map(
        i => i.code,
      ),
    ).toContain("fee-recipient-invalid");
  });

  it("keeps the fee recipient checksummed for display", () => {
    const config = resolveConfig({
      NEXT_PUBLIC_TOKEN_CREATOR_FEE_SEPOLIA: MIN_SERVICE_FEE_ETH,
      NEXT_PUBLIC_TOKEN_CREATOR_FEE_RECIPIENT_SEPOLIA: VALID,
    });
    expect(config.feeRecipient).toBe(getAddress(VALID));
    expect(config.issues.map(issue => issue.code)).not.toContain("fee-recipient-missing");
  });

  it("never copies unrelated environment variables into the config", () => {
    const config = resolveConfig({
      DATABASE_URL: "postgres://user:secret@host/db",
      ADMIN_SECRET: "super-secret",
      DEPLOYER_PRIVATE_KEY: "0xdeadbeef",
    });
    expect(JSON.stringify(config)).not.toContain("secret");
    expect(JSON.stringify(config)).not.toContain("deadbeef");
  });
});

describe("normalizeAddress", () => {
  it("checksums valid addresses", () => {
    expect(normalizeAddress(VALID)).toBe(getAddress(VALID));
    expect(isAddress(normalizeAddress(VALID))).toBe(true);
  });

  it("returns empty for junk", () => {
    expect(normalizeAddress("")).toBe("");
    expect(normalizeAddress("0x123")).toBe("");
    expect(normalizeAddress("hello")).toBe("");
    expect(normalizeAddress(`0x${"z".repeat(40)}`)).toBe("");
  });
});

describe("normalizeFee", () => {
  it("maps empty to zero", () => {
    expect(normalizeFee("")).toEqual({ feeEth: "0", valid: true });
    expect(normalizeFee("   ")).toEqual({ feeEth: "0", valid: true });
  });

  it("accepts plain and fractional amounts", () => {
    expect(normalizeFee("0")).toEqual({ feeEth: "0", valid: true });
    expect(normalizeFee("0.001")).toEqual({ feeEth: "0.001", valid: true });
  });

  it("rejects anything else", () => {
    for (const value of ["-1", "1e3", "0.1.2", "abc", "0x1"]) {
      expect(normalizeFee(value).valid, value).toBe(false);
      expect(normalizeFee(value).feeEth).toBe("0");
    }
  });
});
