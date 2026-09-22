/**
 * Injected-wallet detection and the messages we show when there is none.
 *
 * Why this exists: wagmi's injected connector throws `ProviderNotFoundError`
 * ("Provider not found.") when `window.ethereum` is undefined. That raw library
 * string is useless to a user and easy to mistake for a bug in the app, so the
 * two genuinely different situations are named explicitly here:
 *
 *   1. there is no injected wallet at all — most often an embedded preview
 *      panel, a mobile in-app browser, or a desktop browser without MetaMask;
 *   2. `window.ethereum` exists but no provider could be resolved from it,
 *      which means the extension is locked, still starting up, or conflicting
 *      with another wallet extension.
 *
 * Nothing here fakes a connection: these are only used to explain a real failure.
 */

export type InjectedWalletState = "unknown" | "present" | "absent";

/** SSR-safe. Returns false on the server, which is never "absent" — see the state type. */
export function hasInjectedWallet(): boolean {
  if (typeof window === "undefined") return false;
  const candidate = (window as unknown as { ethereum?: unknown }).ethereum;
  return Boolean(candidate);
}

/** The browser cannot connect because it has no wallet extension at all. */
export const NO_WALLET_MESSAGE =
  "No browser wallet was found on this page (window.ethereum is undefined), so there is nothing to connect to. " +
  "Install MetaMask (or another EIP-1193 wallet) and reload. " +
  "Note: embedded preview panels and mobile in-app browsers do not load wallet extensions — open this page in a normal desktop browser tab.";

/** A wallet is present but its provider could not be resolved. */
export const PROVIDER_UNRESOLVED_MESSAGE =
  "This browser exposes window.ethereum, but no provider could be resolved from it. " +
  "Unlock the wallet extension, dismiss any other wallet extension that may be conflicting, then reload the page and try again.";

/**
 * Structural check so this works regardless of whether the error arrives as a
 * wagmi, viem or plain Error instance. `ProviderNotFoundError` is the name wagmi
 * uses; the message test covers wrapped/re-thrown copies.
 */
export function isProviderNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const name = (error as { name?: unknown }).name;
  if (typeof name === "string" && name === "ProviderNotFoundError") return true;
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" && /provider not found/i.test(message);
}

/** Pick the message that matches reality, rather than assuming what went wrong. */
export function providerNotFoundMessage(): string {
  return hasInjectedWallet() ? PROVIDER_UNRESOLVED_MESSAGE : NO_WALLET_MESSAGE;
}

/** Small, always-visible hint so the requirement is clear before clicking. */
export const WALLET_REQUIREMENT_HINT =
  "Requires a browser wallet extension such as MetaMask. Embedded preview panels and in-app browsers cannot connect.";

/**
 * Subscribe to the injected provider appearing. Some wallets inject
 * `window.ethereum` after the page has loaded, and EIP-6963 wallets announce
 * themselves with `eip6963:announceProvider`.
 *
 * Returns an unsubscribe function (a no-op on the server).
 */
export function onInjectedWalletAvailable(callback: () => void): () => void {
  if (typeof window === "undefined") return () => {};

  const listener = () => callback();
  window.addEventListener("ethereum#initialized", listener, { once: true });
  window.addEventListener("eip6963:announceProvider", listener);

  return () => {
    window.removeEventListener("ethereum#initialized", listener);
    window.removeEventListener("eip6963:announceProvider", listener);
  };
}
