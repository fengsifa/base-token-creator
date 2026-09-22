/**
 * Pure derivation of the creator form's UI state.
 *
 * Every "should the button be enabled / what should it say / why is it blocked"
 * decision lives here so it can be unit tested without a browser or a wallet.
 * The React component only renders what these functions return.
 *
 * MVP note: the platform service fee is 0 ETH. When the configured fee is zero
 * the payment leg is skipped entirely and the token is created in a single
 * user-signed transaction. The two-step paid flow still works when a non-zero
 * fee is configured, so no existing deployment behaviour is removed.
 */
import { NO_WALLET_MESSAGE } from "./wallet";

export type Stage = "idle" | "paying" | "payment_confirmed" | "deploying" | "success";
export type PrimaryActionKind =
  | "connect"
  | "switch-network"
  | "pay"
  | "deploy"
  | "pending"
  | "done";

export type CreatorStateInput = {
  isConnected: boolean;
  /** Whether at least one wallet connector was actually injected. */
  hasConnector: boolean;
  connecting: boolean;
  switching: boolean;
  chainId: number | undefined;
  expectedChainId: number;
  expectedChainName: string;
  /** Service fee in wei. 0 (or a malformed config) disables the payment leg. */
  feeWei: bigint;
  balanceWei: bigint | undefined;
  /** Non-empty only when a syntactically valid factory address is configured. */
  factoryAddress: string;
  /** Result of validateTokenInput().ok */
  formValid: boolean;
  stage: Stage;
};

export type CreatorState = {
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

  const insufficientFee =
    requiresPayment &&
    onRightChain &&
    input.balanceWei !== undefined &&
    input.balanceWei < input.feeWei;

  const emptyGasBalance = onRightChain && input.balanceWei === 0n;

  const processing = input.stage === "paying" || input.stage === "deploying";

  let primaryActionKind: PrimaryActionKind;
  if (input.stage === "success") {
    primaryActionKind = "done";
  } else if (processing) {
    primaryActionKind = "pending";
  } else if (!input.isConnected) {
    primaryActionKind = "connect";
  } else if (wrongNetwork) {
    primaryActionKind = "switch-network";
  } else if (input.stage === "payment_confirmed") {
    primaryActionKind = "deploy";
  } else {
    // stage === "idle": either pay first (fee configured) or deploy directly.
    primaryActionKind = requiresPayment ? "pay" : "deploy";
  }

  let primaryLabel: string;
  switch (primaryActionKind) {
    case "done":
      primaryLabel = "Token Created";
      break;
    case "pending":
      primaryLabel = input.stage === "paying" ? "Payment Pending…" : "Deployment Pending…";
      break;
    case "connect":
      primaryLabel = input.connecting ? "Connecting…" : "Connect Wallet";
      break;
    case "switch-network":
      primaryLabel = input.switching ? "Switching…" : `Switch to ${input.expectedChainName}`;
      break;
    case "pay":
      primaryLabel = "Pay & Continue";
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
    case "pay":
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
      "The Token Factory address is not configured on this deployment. A configured factory is required before any token can be created.",
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

export type TxKind = "payment" | "deployment";

export type TxFailure = { stage: Stage; message: string };

/**
 * Where the flow returns to after a transaction fails, and what to tell the user.
 *
 * The two cases are genuinely different and used to be conflated:
 *  - a failed *deployment* after a paid fee cannot silently go back to "idle",
 *    because the fee is already spent on-chain;
 *  - a failed *deployment* with no fee is fully retryable from "idle".
 */
export function txFailureState(kind: TxKind, requiresPayment: boolean): TxFailure {
  if (kind === "payment") {
    return {
      stage: "idle",
      message:
        "The payment transaction failed or was rejected on-chain. No token was created and no deployment was started.",
    };
  }
  if (requiresPayment) {
    return {
      stage: "payment_confirmed",
      message:
        "The deployment transaction failed on-chain. The confirmed service fee was not reversed. You can retry the deployment without paying again.",
    };
  }
  return {
    stage: "idle",
    message:
      "The token deployment transaction failed or was rejected on-chain. Nothing was created. You can fix the parameters and try again.",
  };
}

/** Human summary of what the user is about to pay. */
export function feeSummary(feeEth: string, requiresPayment: boolean): string {
  if (!requiresPayment) return "0 ETH (no service fee) + Gas";
  return `${feeEth} ETH + Gas`;
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
