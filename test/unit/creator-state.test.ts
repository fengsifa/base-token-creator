import { describe, expect, it } from "vitest";
import {
  creationFailureState,
  deriveCreatorState,
  explorerAddressUrl,
  explorerTxUrl,
  feeSummary,
  isTxHash,
  shortAddress,
  type CreatorStateInput,
} from "../../lib/creator-state";

const FACTORY = `0x${"1".repeat(40)}`;
const ONE_ETH = 1_000_000_000_000_000_000n;
const MIN_FEE_WEI = 100_000_000_000_000n; // 0.0001 ETH

function input(overrides: Partial<CreatorStateInput> = {}): CreatorStateInput {
  return {
    isConnected: false,
    hasConnector: true,
    connecting: false,
    switching: false,
    chainId: undefined,
    expectedChainId: 84532,
    expectedChainName: "Base Sepolia",
    feeWei: 0n,
    balanceWei: undefined,
    factoryAddress: FACTORY,
    formValid: true,
    stage: "idle",
    ...overrides,
  };
}

describe("deriveCreatorState", () => {
  describe("wallet not connected", () => {
    it("offers a connect action and does not block on form or balance", () => {
      const state = deriveCreatorState(input({ formValid: false, balanceWei: 0n }));
      expect(state.primaryActionKind).toBe("connect");
      expect(state.primaryLabel).toBe("Connect Wallet");
      expect(state.primaryDisabled).toBe(false);
      expect(state.wrongNetwork).toBe(false);
      expect(state.blockers).not.toContain("Fix the highlighted token parameters before continuing.");
    });

    it("shows a connecting label while a connection is pending", () => {
      const state = deriveCreatorState(input({ connecting: true }));
      expect(state.primaryLabel).toBe("Connecting…");
      expect(state.primaryDisabled).toBe(true);
    });

    it("is disabled and explains itself when no wallet is installed", () => {
      const state = deriveCreatorState(input({ hasConnector: false }));
      expect(state.primaryDisabled).toBe(true);
      expect(state.blockers.join(" ")).toMatch(/no browser wallet/i);
    });
  });

  describe("network", () => {
    it("does not report a wrong network before the chain id is known", () => {
      const state = deriveCreatorState(input({ isConnected: true, chainId: undefined }));
      expect(state.wrongNetwork).toBe(false);
      expect(state.primaryActionKind).toBe("deploy");
    });

    it("asks to switch when the wallet is on another chain", () => {
      const state = deriveCreatorState(input({ isConnected: true, chainId: 8453 }));
      expect(state.wrongNetwork).toBe(true);
      expect(state.primaryActionKind).toBe("switch-network");
      expect(state.primaryLabel).toBe("Switch to Base Sepolia");
    });

    it("shows a switching label while the switch is pending", () => {
      const state = deriveCreatorState(input({ isConnected: true, chainId: 8453, switching: true }));
      expect(state.primaryLabel).toBe("Switching…");
      expect(state.primaryDisabled).toBe(true);
    });

    it("is ready when connected to the expected chain", () => {
      const state = deriveCreatorState(input({ isConnected: true, chainId: 84532 }));
      expect(state.wrongNetwork).toBe(false);
      expect(state.primaryActionKind).toBe("deploy");
      expect(state.primaryLabel).toBe("Create Token");
    });

    it("returns to Create Token once the user confirms the switch", () => {
      // The wallet is still on another chain: the only action is to switch.
      const before = deriveCreatorState(input({ isConnected: true, chainId: 8453 }));
      expect(before.primaryActionKind).toBe("switch-network");

      // The user accepted in their wallet and chainId now reports 84532. Nothing
      // else changes, and the state must settle straight back onto Create Token.
      const after = deriveCreatorState(input({ isConnected: true, chainId: 84532 }));
      expect(after.primaryActionKind).toBe("deploy");
      expect(after.primaryLabel).toBe("Create Token");
      expect(after.wrongNetwork).toBe(false);
      expect(after.primaryDisabled).toBe(false);
    });

    it("keeps the switch available after a refusal instead of dead-ending", () => {
      // A rejected switch leaves the wallet on the old chain: the action must
      // still be offered so the user can try again.
      const state = deriveCreatorState(input({ isConnected: true, chainId: 8453, switching: false }));
      expect(state.primaryActionKind).toBe("switch-network");
      expect(state.primaryDisabled).toBe(false);
    });

    it("needs no manual network configuration in the free path", () => {
      // Nothing about chain ids or RPC URLs is a blocker in its own right; the
      // switch is an action, never a field the user must fill in.
      const state = deriveCreatorState(input({ isConnected: true, chainId: 84532 }));
      expect(state.blockers.join(" ")).not.toMatch(/rpc|chain id|add the network/i);
    });
  });

  describe("fee modes", () => {
    it("free mode deploys in one transaction", () => {
      const state = deriveCreatorState(input({ isConnected: true, chainId: 84532 }));
      expect(state.requiresPayment).toBe(false);
      expect(state.primaryActionKind).toBe("deploy");
      expect(state.primaryLabel).toBe("Create Token");
      expect(state.primaryDisabled).toBe(false);
    });

    it("paid mode still asks for a single transaction", () => {
      // The fee no longer has a step of its own: the factory collects it inside
      // `createToken`, so selecting features adds cost but not a signature.
      const state = deriveCreatorState(
        input({ isConnected: true, chainId: 84532, feeWei: MIN_FEE_WEI, balanceWei: ONE_ETH }),
      );
      expect(state.requiresPayment).toBe(true);
      expect(state.primaryActionKind).toBe("deploy");
      expect(state.primaryLabel).toBe("Create Token");
      expect(state.primaryDisabled).toBe(false);
    });

    it("blocks the fee payment when the balance is too low", () => {
      const state = deriveCreatorState(
        input({ isConnected: true, chainId: 84532, feeWei: MIN_FEE_WEI, balanceWei: 1n }),
      );
      expect(state.insufficientFee).toBe(true);
      expect(state.primaryDisabled).toBe(true);
      expect(state.blockers.join(" ")).toMatch(/below the service fee/i);
    });

    it("offers creation directly when features are selected, with no separate payment step", () => {
      const state = deriveCreatorState(
        input({
          isConnected: true,
          chainId: 84532,
          feeWei: MIN_FEE_WEI,
          balanceWei: ONE_ETH,
        }),
      );
      // One action covers the fee and the deployment: the factory collects the
      // fee inside `createToken`, so there is nothing to pay beforehand.
      expect(state.primaryActionKind).toBe("deploy");
      expect(state.primaryLabel).toBe("Create Token");
    });
  });

  describe("blockers", () => {
    it("blocks on an unconfigured factory even in free mode", () => {
      const state = deriveCreatorState(input({ isConnected: true, chainId: 84532, factoryAddress: "" }));
      expect(state.primaryDisabled).toBe(true);
      expect(state.blockers.join(" ")).toMatch(/factory address .* is not configured/i);
    });

    it("blocks on invalid parameters once connected", () => {
      const state = deriveCreatorState(input({ isConnected: true, chainId: 84532, formValid: false }));
      expect(state.primaryDisabled).toBe(true);
      expect(state.blockers.join(" ")).toMatch(/fix the highlighted token parameters/i);
    });

    it("blocks when the wallet has no ETH for gas", () => {
      const state = deriveCreatorState(input({ isConnected: true, chainId: 84532, balanceWei: 0n }));
      expect(state.emptyGasBalance).toBe(true);
      expect(state.blockers.join(" ")).toMatch(/cannot pay gas/i);
    });

    it("does not block in free mode when no balance data is available yet", () => {
      const state = deriveCreatorState(input({ isConnected: true, chainId: 84532, balanceWei: undefined }));
      expect(state.primaryDisabled).toBe(false);
    });

    it("reports no blockers in the happy path", () => {
      const state = deriveCreatorState(input({ isConnected: true, chainId: 84532, balanceWei: ONE_ETH }));
      expect(state.blockers).toEqual([]);
    });
  });

  describe("in-flight and finished states", () => {
    it("locks the button while the creation transaction is in flight", () => {
      const state = deriveCreatorState(
        input({ isConnected: true, chainId: 84532, feeWei: MIN_FEE_WEI, stage: "deploying" }),
      );
      expect(state.processing).toBe(true);
      expect(state.primaryActionKind).toBe("pending");
      expect(state.primaryLabel).toBe("Creating Token…");
      expect(state.primaryDisabled).toBe(true);
    });

    it("marks success as terminal", () => {
      const state = deriveCreatorState(input({ isConnected: true, chainId: 84532, stage: "success" }));
      expect(state.primaryActionKind).toBe("done");
      expect(state.primaryLabel).toBe("Token Created");
      expect(state.primaryDisabled).toBe(true);
    });
  });
});

describe("creationFailureState", () => {
  it("returns to the start, because the fee and the token share one transaction", () => {
    // There is deliberately no state where the fee is paid and no token exists:
    // the factory takes the fee inside `createToken`, so a failure means neither
    // happened and the whole thing is safely retryable.
    const failure = creationFailureState();
    expect(failure.stage).toBe("idle");
    expect(failure.message).toMatch(/no token was created/i);
    expect(failure.message).toMatch(/no service fee was charged/i);
  });
});

describe("helpers", () => {
  it("builds explorer urls without duplicating slashes", () => {
    expect(explorerTxUrl("https://sepolia.basescan.org/", "0xabc")).toBe(
      "https://sepolia.basescan.org/tx/0xabc",
    );
    expect(explorerAddressUrl("https://sepolia.basescan.org", "0xabc")).toBe(
      "https://sepolia.basescan.org/address/0xabc",
    );
  });

  it("states the service fee as a figure that never includes gas", () => {
    // Gas is paid to the network, not the platform, and its amount is unknown
    // until the wallet estimates it — folding it in would present a guess as a
    // price. The page shows it on its own line.
    expect(feeSummary("0")).toBe("0 ETH");
    expect(feeSummary("0.000004")).toBe("0.000004 ETH");
    expect(feeSummary("0.000001")).not.toMatch(/gas/i);
  });

  it("only accepts real-looking transaction hashes", () => {
    expect(isTxHash(`0x${"a".repeat(64)}`)).toBe(true);
    expect(isTxHash("0x123")).toBe(false);
    expect(isTxHash("hello")).toBe(false);
    expect(isTxHash(null)).toBe(false);
    expect(isTxHash(undefined)).toBe(false);
    expect(isTxHash(`0x${"g".repeat(64)}`)).toBe(false);
  });

  it("shortens addresses for display", () => {
    expect(shortAddress("0x1234567890abcdef1234567890abcdef12345678")).toBe("0x1234…5678");
    expect(shortAddress("0x1234")).toBe("0x1234");
  });
});
