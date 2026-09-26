import { describe, expect, it } from "vitest";
import { getAddress, isAddress } from "viem";
import { feeToWei, normalizeAddress, normalizeFee, resolveConfig } from "../../lib/config";

const VALID = "0x1234567890abcdef1234567890abcdef12345678";
const OTHER = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";

describe("resolveConfig", () => {
  it("defaults to Base Sepolia with unconfigured factories and no false alarms", () => {
    const config = resolveConfig({});
    expect(config.networkKey).toBe("sepolia");
    expect(config.chainId).toBe(84532);
    expect(config.chainName).toBe("Base Sepolia");
    expect(config.explorerBase).toBe("https://sepolia.basescan.org");
    expect(config.rpcUrl).toBe("https://sepolia.base.org");
    expect(config.factoryCoreAddress).toBe("");
    expect(config.factoryBurnableAddress).toBe("");
    expect(config.featureFees).toEqual({ base: "0", burnable: "0", mintable: "0", pausable: "0" });
    // An undeployed factory is a state, not a misconfiguration, so nothing is
    // reported for it. The page owns that call to action.
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

  // ---------------------------------------------------------------------------
  // Two factories, because one contract cannot hold all eight feature sets.
  // ---------------------------------------------------------------------------

  describe("factory addresses", () => {
    it("resolves each factory independently and checksums both", () => {
      const config = resolveConfig({
        NEXT_PUBLIC_TOKEN_CONTRACT_FACTORY_CORE_SEPOLIA: VALID,
        NEXT_PUBLIC_TOKEN_CONTRACT_FACTORY_BURNABLE_SEPOLIA: OTHER,
      });
      expect(config.factoryCoreAddress.toLowerCase()).toBe(VALID);
      expect(config.factoryBurnableAddress.toLowerCase()).toBe(OTHER);
      expect(isAddress(config.factoryCoreAddress)).toBe(true);
      expect(isAddress(config.factoryBurnableAddress)).toBe(true);
      expect(config.issues).toEqual([]);
    });

    it("accepts an already-checksummed address", () => {
      const checksummed = getAddress(VALID);
      expect(
        resolveConfig({ NEXT_PUBLIC_TOKEN_CONTRACT_FACTORY_CORE_SEPOLIA: checksummed })
          .factoryCoreAddress,
      ).toBe(checksummed);
    });

    it("keeps the two factories apart", () => {
      // The burnable one is not a fallback for the core one: they deploy
      // different contracts, and silently substituting one for the other would
      // send a creation to a factory that must reject it with
      // FeatureNotSupportedHere.
      const onlyBurnable = resolveConfig({
        NEXT_PUBLIC_TOKEN_CONTRACT_FACTORY_BURNABLE_SEPOLIA: OTHER,
      });
      expect(onlyBurnable.factoryCoreAddress).toBe("");
      expect(onlyBurnable.factoryBurnableAddress.toLowerCase()).toBe(OTHER);

      const onlyCore = resolveConfig({
        NEXT_PUBLIC_TOKEN_CONTRACT_FACTORY_CORE_SEPOLIA: VALID,
      });
      expect(onlyCore.factoryBurnableAddress).toBe("");
    });

    it("ignores a malformed address and says which one it was", () => {
      const config = resolveConfig({
        NEXT_PUBLIC_TOKEN_CONTRACT_FACTORY_CORE_SEPOLIA: "0xnot-an-address",
      });
      expect(config.factoryCoreAddress).toBe("");
      expect(config.issues.map(issue => issue.code)).toEqual(["factory-core-address-invalid"]);
      expect(config.issues.map(issue => issue.message).join(" ")).toMatch(/CORE_SEPOLIA/);
    });

    it("falls back to the unsuffixed variable for each factory", () => {
      const config = resolveConfig({
        NEXT_PUBLIC_TOKEN_CONTRACT_FACTORY_CORE: VALID,
        NEXT_PUBLIC_TOKEN_CONTRACT_FACTORY_BURNABLE: OTHER,
      });
      expect(config.factoryCoreAddress.toLowerCase()).toBe(VALID);
      expect(config.factoryBurnableAddress.toLowerCase()).toBe(OTHER);
    });

    it("prefers the network specific variable", () => {
      const config = resolveConfig({
        NEXT_PUBLIC_TOKEN_CONTRACT_FACTORY_CORE: VALID,
        NEXT_PUBLIC_TOKEN_CONTRACT_FACTORY_CORE_SEPOLIA: OTHER,
      });
      expect(config.factoryCoreAddress?.toLowerCase()).toBe(OTHER);
    });

    it("does not reuse a sepolia factory on mainnet", () => {
      const config = resolveConfig({
        NEXT_PUBLIC_BASE_NETWORK: "mainnet",
        NEXT_PUBLIC_TOKEN_CONTRACT_FACTORY_CORE_SEPOLIA: VALID,
        NEXT_PUBLIC_TOKEN_CONTRACT_FACTORY_BURNABLE_SEPOLIA: OTHER,
      });
      expect(config.factoryCoreAddress).toBe("");
      expect(config.factoryBurnableAddress).toBe("");
    });
  });

  // ---------------------------------------------------------------------------
  // The price table
  // ---------------------------------------------------------------------------

  describe("feature fees", () => {
    it("defaults every component to zero", () => {
      const config = resolveConfig({});
      expect(config.featureFees.base).toBe("0");
      expect(config.featureFees.burnable).toBe("0");
      expect(config.featureFees.mintable).toBe("0");
      expect(config.featureFees.pausable).toBe("0");
    });

    it("keeps the 0.000001 ETH test price exactly — there is no minimum floor", () => {
      // An earlier revision raised any non-zero fee below 0.0001 ETH up to that
      // value, on the grounds that dust is economically pointless. The product
      // now prices features at 0.000001 during its test phase, and a floor would
      // silently rewrite the operator's own price table, leaving the page showing
      // one number while the factory demanded another. This test exists so that
      // behaviour cannot come back unnoticed.
      const config = resolveConfig({
        NEXT_PUBLIC_TOKEN_CREATOR_FEE_SEPOLIA: "0.000001",
        NEXT_PUBLIC_BURNABLE_FEE_SEPOLIA: "0.000001",
        NEXT_PUBLIC_MINTABLE_FEE_SEPOLIA: "0.000001",
        NEXT_PUBLIC_PAUSABLE_FEE_SEPOLIA: "0.000001",
        NEXT_PUBLIC_TOKEN_CREATOR_FEE_RECIPIENT_SEPOLIA: VALID,
      });

      expect(config.featureFees).toEqual({
        base: "0.000001",
        burnable: "0.000001",
        mintable: "0.000001",
        pausable: "0.000001",
      });
      expect(feeToWei(config.featureFees.base)).toBe(1_000_000_000_000n);
      // No complaint of any kind: the prices are valid and the recipient is set.
      expect(config.issues).toEqual([]);
    });

    it("reads each feature price from its own variable", () => {
      const config = resolveConfig({
        NEXT_PUBLIC_TOKEN_CREATOR_FEE_SEPOLIA: "0.000001",
        NEXT_PUBLIC_BURNABLE_FEE_SEPOLIA: "0.002",
        NEXT_PUBLIC_MINTABLE_FEE_SEPOLIA: "0.003",
        NEXT_PUBLIC_PAUSABLE_FEE_SEPOLIA: "0.004",
      });
      expect(config.featureFees.burnable).toBe("0.002");
      expect(config.featureFees.mintable).toBe("0.003");
      expect(config.featureFees.pausable).toBe("0.004");
    });

    it("degrades an unparseable price to zero and tags the issue", () => {
      const config = resolveConfig({ NEXT_PUBLIC_BURNABLE_FEE_SEPOLIA: "abc" });
      expect(config.featureFees.burnable).toBe("0");
      expect(config.issues.map(issue => issue.code)).toContain("fee-invalid");
      expect(config.issues.map(issue => issue.message).join(" ")).toMatch(/BURNABLE_FEE_SEPOLIA/);
    });

    it("does not raise an explicit zero", () => {
      const config = resolveConfig({ NEXT_PUBLIC_TOKEN_CREATOR_FEE_SEPOLIA: "0" });
      expect(config.featureFees.base).toBe("0");
      expect(config.issues).toEqual([]);
    });

    it("flags any non-zero price that has no recipient", () => {
      const config = resolveConfig({ NEXT_PUBLIC_PAUSABLE_FEE_SEPOLIA: "0.000001" });
      expect(config.issues.map(issue => issue.code)).toContain("fee-recipient-missing");
    });

    it("does not flag a missing recipient when everything is free", () => {
      expect(resolveConfig({}).issues).toEqual([]);
    });

    it("ignores an invalid recipient and says so", () => {
      const config = resolveConfig({
        NEXT_PUBLIC_TOKEN_CREATOR_FEE_RECIPIENT_SEPOLIA: "0x1234",
      });
      expect(config.feeRecipient).toBe("");
      expect(config.issues.map(issue => issue.code)).toContain("fee-recipient-invalid");
    });

    it("keeps the fee recipient checksummed for display", () => {
      const config = resolveConfig({
        NEXT_PUBLIC_TOKEN_CREATOR_FEE_SEPOLIA: "0.000001",
        NEXT_PUBLIC_TOKEN_CREATOR_FEE_RECIPIENT_SEPOLIA: VALID,
      });
      expect(config.feeRecipient).toBe(getAddress(VALID));
      expect(config.issues.map(issue => issue.code)).not.toContain("fee-recipient-missing");
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
    // actionable call to action for this, and a generic issue would be rendered a
    // second time — in the page AND in the serialised client payload.
    const missing = resolveConfig({});
    expect(missing.factoryCoreAddress).toBe("");
    expect(missing.factoryBurnableAddress).toBe("");
    expect(missing.issues).toEqual([]);

    const configured = resolveConfig({
      NEXT_PUBLIC_TOKEN_CONTRACT_FACTORY_CORE_SEPOLIA: VALID,
      NEXT_PUBLIC_TOKEN_CONTRACT_FACTORY_BURNABLE_SEPOLIA: OTHER,
    });
    expect(configured.factoryCoreAddress).toBeTruthy();
    expect(configured.factoryBurnableAddress).toBeTruthy();
    expect(configured.issues).toEqual([]);
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

  it("accepts plain and fractional amounts, including the test price", () => {
    expect(normalizeFee("0")).toEqual({ feeEth: "0", valid: true });
    expect(normalizeFee("0.001")).toEqual({ feeEth: "0.001", valid: true });
    expect(normalizeFee("0.000001")).toEqual({ feeEth: "0.000001", valid: true });
  });

  it("rejects anything else", () => {
    for (const value of ["-1", "1e3", "0.1.2", "abc", "0x1"]) {
      expect(normalizeFee(value).valid, value).toBe(false);
      expect(normalizeFee(value).feeEth).toBe("0");
    }
  });
});
