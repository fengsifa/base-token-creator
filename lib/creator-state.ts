/**
 * Pure derivation of the creator form's UI state.
 *
 * Every "should the button be enabled / what should it say / why is it blocked"
 * decision lives here so it can be unit tested without a browser or a wallet.
 * The React component only renders what these functions return.
 *
 * One transaction, not two: the factory is `payable` and collects the service fee
 * inside `createToken`, forwarding it to the fee recipient in the same call. An
 * earlier revision paid the fee in a separate transfer before deploying, which
 * left the user with a spent fee if the second transaction failed. The fee now
 * either happens with the token or not at all.
 *
 * The service fee and the network gas are always reported separately. Gas is paid
 * to the network, never to the platform, and is never part of the quoted price.
 */
import { NO_WALLET_MESSAGE } from "./wallet";

export type Stage = "idle" | "deploying" | "success";
export type PrimaryActionKind = "connect" | "switch-network" | "deploy" | "pending" | "done";

export type CreatorStateInput = {
  isConnected: boolean;
  /** Whether at least one wallet connector was actually injected. */
  hasConnector: boolean;
  connecting: boolean;
  switching: boolean;
  chainId: number | undefined;
  expectedChainId: number;
  expectedChainName: string;
  /**
   * The service fee for the currently selected features, in wei — base price plus
   * one charge per selected feature. 0 means creation is free apart from gas.
   */
  feeWei: bigint;
  balanceWei: bigint | undefined;
  /**
   * Non-empty only when the factory that will actually receive the call has a
   * syntactically valid address configured.
   */
  factoryAddress: string;
  /** Result of validateTokenInput().ok */
  formValid: boolean;
  stage: Stage;
};

export type CreatorState = {
  /** True when the selected features cost anything at all. */
  requiresPayment: boolean;
  wrongNetwork: boolean;
  insufficientFee: boolean;
  emptyGasBalance: boolean;
  processing: boolean;
  primaryActionKind: PrimaryActionKind;
  primaryLabel: string;
  primaryDisabled: boolean;
  /** Ordered, user-facing reasons the primary action cannot proceed yet. */
  blockers: string[];
};

export const TX_HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;

/** localStorage can contain anything; only accept a real-looking tx hash. */
export function isTxHash(value: unknown): value is `0x${string}` {
  return typeof value === "string" && TX_HASH_PATTERN.test(value);
}

export function deriveCreatorState(input: CreatorStateInput): CreatorState {
  const requiresPayment = input.feeWei > 0n;

  // chainId is undefined before wagmi hydrates; treating that as "wrong network"
  // would show a spurious banner on first paint.
  const wrongNetwork =
    input.isConnected && input.chainId !== undefined && input.chainId !== input.expectedChainId;

  const onRightChain = input.isConnected && !wrongNetwork;

  // The wallet must be able to cover the service fee and still have something for
  // gas; the second condition is reported separately because the remedies differ.
  const insufficientFee =
    requiresPayment &&
    onRightChain &&
    input.balanceWei !== undefined &&
    input.balanceWei < input.feeWei;

  const emptyGasBalance = onRightChain && input.balanceWei === 0n;

  const processing = input.stage === "deploying";

  let primaryActionKind: PrimaryActionKind;
  if (input.stage === "success") {
    primaryActionKind = "done";
  } else if (processing) {
    primaryActionKind = "pending";
  } else if (!input.isConnected) {
    primaryActionKind = "connect";
  } else if (wrongNetwork) {
    primaryActionKind = "switch-network";
  } else {
    // One action covers both the fee and the deployment, so there is no separate
    // "pay" step to route to.
    primaryActionKind = "deploy";
  }

  let primaryLabel: string;
  switch (primaryActionKind) {
    case "done":
      primaryLabel = "Token Created";
      break;
    case "pending":
      primaryLabel = "Creating Token…";
      break;
    case "connect":
      primaryLabel = input.connecting ? "Connecting…" : "Connect Wallet";
      break;
    case "switch-network":
      primaryLabel = input.switching ? "Switching…" : `Switch to ${input.expectedChainName}`;
      break;
    case "deploy":
      primaryLabel = input.stage === "idle" ? "Create Token" : "Deploy Token";
      break;
  }

  let primaryDisabled: boolean;
  switch (primaryActionKind) {
    case "done":
    case "pending":
      primaryDisabled = true;
      break;
    case "connect":
      primaryDisabled = input.connecting || !input.hasConnector;
      break;
    case "switch-network":
      primaryDisabled = input.switching;
      break;
    case "deploy":
      primaryDisabled =
        !input.formValid || !input.factoryAddress || insufficientFee || !input.hasConnector;
      break;
  }

  const blockers: string[] = [];
  if (!input.hasConnector) {
    blockers.push(NO_WALLET_MESSAGE);
  }
  if (!input.factoryAddress) {
    blockers.push(
      "The Token Factory address for the selected features is not configured on this deployment. A configured factory is required before any token can be created.",
    );
  }
  if (input.isConnected) {
    if (!input.formValid) blockers.push("Fix the highlighted token parameters before continuing.");
    if (insufficientFee) blockers.push("Your wallet balance is below the service fee.");
    if (emptyGasBalance) {
      blockers.push("Your wallet has no ETH on this network, so it cannot pay gas.");
    }
  }

  return {
    requiresPayment,
    wrongNetwork,
    insufficientFee,
    emptyGasBalance,
    processing,
    primaryActionKind,
    primaryLabel,
    primaryDisabled,
    blockers,
  };
}

export type TxFailure = { stage: Stage; message: string };

/**
 * Where the flow returns to after the creation transaction fails.
 *
 * Always "idle": the fee and the token are created by the same transaction, so a
 * failure means neither happened and the whole thing is safely retryable. There
 * is no state where money has moved but no token exists, which is exactly why the
 * two-transaction design was dropped.
 */
export function creationFailureState(): TxFailure {
  return {
    stage: "idle",
    message:
      "The transaction failed or was rejected on-chain, so no token was created and no service fee was charged. Nothing is left half-done — adjust the parameters and try again.",
  };
}

/**
 * The service fee, stated as a figure that never includes gas.
 *
 * Gas is not a fee the platform receives and it is not known until the wallet
 * estimates it, so folding it into this number would be a guess presented as a
 * price. The page shows it on its own line instead.
 */
export function feeSummary(feeEth: string): string {
  return `${feeEth} ETH`;
}

export function explorerTxUrl(explorerBase: string, hash: string): string {
  return `${explorerBase.replace(/\/+$/, "")}/tx/${hash}`;
}

export function explorerAddressUrl(explorerBase: string, address: string): string {
  return `${explorerBase.replace(/\/+$/, "")}/address/${address}`;
}

export function shortAddress(address: string, lead = 6, tail = 4): string {
  if (address.length <= lead + tail + 1) return address;
  return `${address.slice(0, lead)}…${address.slice(-tail)}`;
}
