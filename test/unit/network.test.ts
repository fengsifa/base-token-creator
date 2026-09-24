/**
 * Wallet network plumbing.
 *
 * These are the guarantees a first-time user depends on: the wallet is asked to
 * switch, the wallet is given everything it needs to add Base Sepolia on its own,
 * and a plain refusal is never mistaken for "the chain is missing" (which would
 * fire a second, unwanted prompt).
 */
import { describe, expect, it, vi } from "vitest";
import { resolveConfig } from "../../lib/config";
import {
  NATIVE_CURRENCY,
  addChainOverrides,
  chainAddParams,
  ensureTargetChain,
  isUnknownChainError,
  isUserRejection,
  toChainIdHex,
  wrongNetworkMessage,
} from "../../lib/network";

const SEPOLIA = {
  chainId: 84532,
  chainName: "Base Sepolia",
  rpcUrl: "https://sepolia.base.org",
  explorerBase: "https://sepolia.basescan.org",
};

/** A wallet error shaped the way MetaMask reports an unknown chain. */
function unknownChainError() {
  return Object.assign(new Error("Unrecognized chain ID"), { code: 4902 });
}

function userRejection() {
  return Object.assign(new Error("User rejected the request."), { code: 4001 });
}

describe("toChainIdHex", () => {
  it("encodes Base Sepolia and Base mainnet", () => {
    expect(toChainIdHex(84532)).toBe("0x14a34");
    expect(toChainIdHex(8453)).toBe("0x2105");
  });
});

describe("chainAddParams", () => {
  it("describes Base Sepolia exactly as the product requires", () => {
    const params = chainAddParams(SEPOLIA);
    expect(params.chainId).toBe("0x14a34");
    expect(params.chainName).toBe("Base Sepolia");
    expect(params.nativeCurrency).toEqual({ name: "Ether", symbol: "ETH", decimals: 18 });
    expect(params.rpcUrls).toEqual(["https://sepolia.base.org"]);
    expect(params.blockExplorerUrls).toEqual(["https://sepolia.basescan.org"]);
  });

  it("carries the RPC from the app config, not a hard-coded default", () => {
    const params = chainAddParams({ ...SEPOLIA, rpcUrl: "https://my-own-node.example/base" });
    expect(params.rpcUrls).toEqual(["https://my-own-node.example/base"]);
  });

  it("uses the configured explorer, so it works on mainnet too", () => {
    const params = chainAddParams({
      chainId: 8453,
      chainName: "Base",
      rpcUrl: "https://mainnet.base.org",
      explorerBase: "https://basescan.org",
    });
    expect(params.chainId).toBe("0x2105");
    expect(params.blockExplorerUrls).toEqual(["https://basescan.org"]);
  });

  it("always declares ETH as the native currency", () => {
    expect(NATIVE_CURRENCY.symbol).toBe("ETH");
    expect(NATIVE_CURRENCY.decimals).toBe(18);
    expect(chainAddParams(SEPOLIA).nativeCurrency).toEqual(NATIVE_CURRENCY);
  });

  it("matches the app's own resolved configuration", () => {
    const config = resolveConfig({});
    expect(config.chainId).toBe(84532);
    expect(config.rpcUrl).toBe("https://sepolia.base.org");
    const params = chainAddParams(config);
    expect(params.chainId).toBe(toChainIdHex(config.chainId));
    expect(params.rpcUrls).toEqual([config.rpcUrl]);
    expect(params.blockExplorerUrls).toEqual([config.explorerBase]);
  });
});

describe("addChainOverrides", () => {
  it("omits chainId because wagmi passes it separately", () => {
    const overrides = addChainOverrides(SEPOLIA);
    expect("chainId" in overrides).toBe(false);
    expect(overrides.chainName).toBe("Base Sepolia");
    expect(overrides.rpcUrls).toEqual(["https://sepolia.base.org"]);
  });
});

describe("isUnknownChainError", () => {
  it("recognises the canonical 4902 code", () => {
    expect(isUnknownChainError(unknownChainError())).toBe(true);
  });

  it("recognises a code nested under cause", () => {
    const error = Object.assign(new Error("switch failed"), {
      cause: Object.assign(new Error("Unrecognized chain ID"), { code: 4902 }),
    });
    expect(isUnknownChainError(error)).toBe(true);
  });

  it("recognises MetaMask Mobile's data.originalError.code", () => {
    const error = Object.assign(new Error("nested"), {
      data: { originalError: { code: 4902, message: "Unrecognized chain ID" } },
    });
    expect(isUnknownChainError(error)).toBe(true);
  });

  it("recognises wallets that only say it in words", () => {
    for (const message of [
      "Unrecognized chain ID. Try adding the chain using wallet_addEthereumChain first.",
      "The chain with ID 0x14a34 has not been added yet.",
      "Unknown chain",
    ]) {
      expect(isUnknownChainError(new Error(message)), message).toBe(true);
    }
  });

  it("treats a user refusal as a refusal, never as a missing chain", () => {
    expect(isUnknownChainError(userRejection())).toBe(false);
    expect(isUnknownChainError(new Error("User denied the request"))).toBe(false);
  });

  it("lets a refusal win even when the error also names a chain problem", () => {
    const error = Object.assign(new Error("Unrecognized chain ID"), {
      code: 4902,
      data: { originalError: { code: 4001, message: "User rejected the request." } },
    });
    expect(isUnknownChainError(error)).toBe(false);
  });

  it("ignores unrelated failures", () => {
    expect(isUnknownChainError(new Error("network error"))).toBe(false);
    expect(isUnknownChainError(null)).toBe(false);
    expect(isUnknownChainError(undefined)).toBe(false);
    expect(isUnknownChainError("boom")).toBe(false);
  });

  it("does not recurse forever on a self-referencing error", () => {
    const error: Record<string, unknown> = { message: "loop" };
    error.cause = error;
    expect(isUnknownChainError(error)).toBe(false);
  });
});

describe("isUserRejection", () => {
  it("recognises the 4001 code and the viem error name", () => {
    expect(isUserRejection(userRejection())).toBe(true);
    expect(isUserRejection(Object.assign(new Error("x"), { name: "UserRejectedRequestError" }))).toBe(
      true,
    );
  });

  it("is false for an unknown-chain error", () => {
    expect(isUserRejection(unknownChainError())).toBe(false);
  });
});

describe("ensureTargetChain", () => {
  it("switches and hands the wallet our own network details", async () => {
    const switchChainAsync = vi.fn().mockResolvedValue(undefined);
    const request = vi.fn();

    await ensureTargetChain({
      config: SEPOLIA,
      switchChainAsync,
      getProvider: () => ({ request }),
    });

    expect(switchChainAsync).toHaveBeenCalledTimes(1);
    const args = switchChainAsync.mock.calls[0][0];
    expect(args.chainId).toBe(84532);
    expect(args.addEthereumChainParameter.rpcUrls).toEqual(["https://sepolia.base.org"]);
    expect(args.addEthereumChainParameter.nativeCurrency.symbol).toBe("ETH");
    expect(args.addEthereumChainParameter.blockExplorerUrls).toEqual([
      "https://sepolia.basescan.org",
    ]);
    // The connector handled it, so we must not prompt a second time.
    expect(request).not.toHaveBeenCalled();
  });

  it("adds the chain itself when the wallet does not know it", async () => {
    const switchChainAsync = vi.fn().mockRejectedValue(unknownChainError());
    const request = vi.fn().mockResolvedValue(undefined);

    await ensureTargetChain({
      config: SEPOLIA,
      switchChainAsync,
      getProvider: () => ({ request }),
    });

    expect(request).toHaveBeenCalledTimes(2);

    const [addCall, switchCall] = request.mock.calls;
    expect(addCall[0].method).toBe("wallet_addEthereumChain");
    const addParams = addCall[0].params[0];
    expect(addParams.chainId).toBe("0x14a34");
    expect(addParams.chainName).toBe("Base Sepolia");
    expect(addParams.nativeCurrency.symbol).toBe("ETH");
    expect(addParams.rpcUrls).toEqual(["https://sepolia.base.org"]);
    expect(addParams.blockExplorerUrls).toEqual(["https://sepolia.basescan.org"]);

    expect(switchCall[0].method).toBe("wallet_switchEthereumChain");
    expect(switchCall[0].params[0].chainId).toBe("0x14a34");
  });

  it("propagates a refusal without prompting again", async () => {
    const switchChainAsync = vi.fn().mockRejectedValue(userRejection());
    const request = vi.fn();

    await expect(
      ensureTargetChain({ config: SEPOLIA, switchChainAsync, getProvider: () => ({ request }) }),
    ).rejects.toThrow(/rejected/i);

    expect(request).not.toHaveBeenCalled();
  });

  it("propagates an unrelated error untouched", async () => {
    const failure = new Error("rpc unavailable");
    const switchChainAsync = vi.fn().mockRejectedValue(failure);
    const request = vi.fn();

    await expect(
      ensureTargetChain({ config: SEPOLIA, switchChainAsync, getProvider: () => ({ request }) }),
    ).rejects.toBe(failure);

    expect(request).not.toHaveBeenCalled();
  });

  it("rethrows the original error when there is no provider to fall back on", async () => {
    const failure = unknownChainError();
    const switchChainAsync = vi.fn().mockRejectedValue(failure);

    await expect(ensureTargetChain({ config: SEPOLIA, switchChainAsync })).rejects.toBe(failure);
  });

  it("ignores a provider that cannot make requests at all", async () => {
    // wagmi types getProvider() as unknown; a connector may hand back something
    // without `request`. That must be treated as "no fallback", not crash.
    const failure = unknownChainError();
    const switchChainAsync = vi.fn().mockRejectedValue(failure);

    await expect(
      ensureTargetChain({ config: SEPOLIA, switchChainAsync, getProvider: () => ({}) }),
    ).rejects.toBe(failure);

    await expect(
      ensureTargetChain({ config: SEPOLIA, switchChainAsync, getProvider: () => null }),
    ).rejects.toBe(failure);

    await expect(
      ensureTargetChain({ config: SEPOLIA, switchChainAsync, getProvider: () => "nope" }),
    ).rejects.toBe(failure);
  });

  it("accepts a provider returned asynchronously", async () => {
    const switchChainAsync = vi.fn().mockRejectedValue(unknownChainError());
    const request = vi.fn().mockResolvedValue(undefined);

    await ensureTargetChain({
      config: SEPOLIA,
      switchChainAsync,
      getProvider: async () => ({ request }),
    });

    expect(request).toHaveBeenCalledTimes(2);
  });
});

describe("wrongNetworkMessage", () => {
  it("names the network the wallet is actually on", () => {
    expect(wrongNetworkMessage(1, "Base Sepolia")).toContain("chain 1");
    expect(wrongNetworkMessage(1, "Base Sepolia")).toContain("Base Sepolia");
  });

  it("says so plainly when the wallet has not reported a chain yet", () => {
    const message = wrongNetworkMessage(undefined, "Base Sepolia");
    expect(message).toMatch(/has not reported its network yet/i);
  });

  it("tells the user there is nothing to configure by hand", () => {
    expect(wrongNetworkMessage(1, "Base Sepolia")).toMatch(/nothing to configure by hand/i);
  });
});
