import { afterEach, describe, expect, it, vi } from "vitest";
import { describeError } from "../../lib/contracts";
import {
  NO_WALLET_MESSAGE,
  PROVIDER_UNRESOLVED_MESSAGE,
  WALLET_REQUIREMENT_HINT,
  hasInjectedWallet,
  isProviderNotFoundError,
  onInjectedWalletAvailable,
  providerNotFoundMessage,
} from "../../lib/wallet";

/**
 * The two situations behind wagmi's "Provider not found." error are genuinely
 * different and must not be conflated, and neither may be papered over.
 */
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("hasInjectedWallet", () => {
  it("is false when there is no window (server render)", () => {
    expect(hasInjectedWallet()).toBe(false);
  });

  it("is false when window exists but no provider was injected", () => {
    vi.stubGlobal("window", {});
    expect(hasInjectedWallet()).toBe(false);
  });

  it("is false when ethereum is present but nullish", () => {
    vi.stubGlobal("window", { ethereum: null });
    expect(hasInjectedWallet()).toBe(false);
  });

  it("is true once a provider is injected", () => {
    vi.stubGlobal("window", { ethereum: { request: () => {} } });
    expect(hasInjectedWallet()).toBe(true);
  });
});

describe("isProviderNotFoundError", () => {
  it("recognises the wagmi error by name", () => {
    const error = new Error("Provider not found.");
    error.name = "ProviderNotFoundError";
    expect(isProviderNotFoundError(error)).toBe(true);
  });

  it("recognises it by message when the class identity is lost", () => {
    // This is how it arrives after being wrapped by a connector.
    expect(
      isProviderNotFoundError(
        new Error("Provider not found.\n\nVersion: @wagmi/core@2.22.1"),
      ),
    ).toBe(true);
    expect(isProviderNotFoundError({ message: "provider not found" })).toBe(true);
  });

  it("does not match unrelated errors", () => {
    expect(isProviderNotFoundError(new Error("User rejected the request."))).toBe(false);
    expect(isProviderNotFoundError(new Error("insufficient funds"))).toBe(false);
    expect(isProviderNotFoundError(null)).toBe(false);
    expect(isProviderNotFoundError(undefined)).toBe(false);
    expect(isProviderNotFoundError("Provider not found.")).toBe(false);
  });
});

describe("providerNotFoundMessage", () => {
  it("blames the missing wallet when there is no provider at all", () => {
    vi.stubGlobal("window", {});
    expect(providerNotFoundMessage()).toBe(NO_WALLET_MESSAGE);
  });

  it("blames the unresolved provider when window.ethereum does exist", () => {
    vi.stubGlobal("window", { ethereum: {} });
    expect(providerNotFoundMessage()).toBe(PROVIDER_UNRESOLVED_MESSAGE);
  });
});

describe("messages are actionable", () => {
  it("tells the user what to install and warns about preview panels", () => {
    expect(NO_WALLET_MESSAGE).toMatch(/metamask/i);
    expect(NO_WALLET_MESSAGE).toMatch(/reload/i);
    expect(NO_WALLET_MESSAGE).toMatch(/preview panels/i);
    expect(NO_WALLET_MESSAGE).not.toMatch(/^provider not found/i);
  });

  it("tells the user what to do when a wallet is present but unresolved", () => {
    expect(PROVIDER_UNRESOLVED_MESSAGE).toMatch(/unlock/i);
    expect(PROVIDER_UNRESOLVED_MESSAGE).toMatch(/reload/i);
  });

  it("states the requirement up front", () => {
    expect(WALLET_REQUIREMENT_HINT).toMatch(/metamask/i);
  });
});

describe("describeError integration", () => {
  it("never shows the raw library text to the user", () => {
    vi.stubGlobal("window", {});
    const raw = new Error("Provider not found.\n\nVersion: @wagmi/core@2.22.1");
    raw.name = "ProviderNotFoundError";

    const described = describeError(raw);
    expect(described).toBe(NO_WALLET_MESSAGE);
    expect(described).not.toContain("@wagmi/core");
  });

  it("picks the unresolved-provider wording when a wallet is present", () => {
    vi.stubGlobal("window", { ethereum: {} });
    const raw = new Error("Provider not found.");
    raw.name = "ProviderNotFoundError";
    expect(describeError(raw)).toBe(PROVIDER_UNRESOLVED_MESSAGE);
  });

  it("still reports ordinary errors unchanged", () => {
    expect(describeError(new Error("boom"))).toBe("boom");
    expect(describeError(undefined)).toBe("Unknown error.");
  });
});

describe("onInjectedWalletAvailable", () => {
  it("returns a no-op unsubscribe on the server", () => {
    const unsubscribe = onInjectedWalletAvailable(() => {
      throw new Error("must not be called on the server");
    });
    expect(typeof unsubscribe).toBe("function");
    expect(() => unsubscribe()).not.toThrow();
  });

  it("subscribes and unsubscribes without throwing in a browser", () => {
    const listeners = new Map<string, () => void>();
    vi.stubGlobal("window", {
      addEventListener: (type: string, handler: () => void) => listeners.set(type, handler),
      removeEventListener: (type: string) => listeners.delete(type),
    });

    const callback = vi.fn();
    const unsubscribe = onInjectedWalletAvailable(callback);
    expect(listeners.has("eip6963:announceProvider")).toBe(true);

    listeners.get("eip6963:announceProvider")?.();
    expect(callback).toHaveBeenCalledTimes(1);

    unsubscribe();
    expect(listeners.size).toBe(0);
  });
});
