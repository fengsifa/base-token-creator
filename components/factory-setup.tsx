"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAccount, useChainId, useConnect, useDeployContract, usePublicClient, useSwitchChain, useWaitForTransactionReceipt } from "wagmi";
import { useAppConfig } from "../lib/app-config-context";
import {
  describeError,
  factoryArtifactReady,
  tokenFactoryAbi,
  tokenFactoryBytecode,
} from "../lib/contracts";
import { explorerAddressUrl, explorerTxUrl, shortAddress } from "../lib/creator-state";
import { MIN_SERVICE_FEE_ETH } from "../lib/config";
import { ensureTargetChain, wrongNetworkMessage } from "../lib/network";
import {
  NO_WALLET_MESSAGE,
  WALLET_REQUIREMENT_HINT,
  hasInjectedWallet,
  onInjectedWalletAvailable,
  type InjectedWalletState,
} from "../lib/wallet";

/**
 * One-click Factory deployment.
 *
 * The Factory is a stateless public contract with no owner, so deploying it is a
 * permissionless operation that anybody can perform from their own wallet. Doing
 * it here means the operator never has to share a private key or run a CLI.
 *
 * The address shown afterwards comes from the mined receipt (`contractAddress`),
 * not from a locally predicted value.
 */
export function FactorySetup() {
  const config = useAppConfig();
  const { address, isConnected, connector } = useAccount();
  const chainId = useChainId();
  const { connect, connectors, isPending: connecting } = useConnect();
  const { switchChainAsync, isPending: switching } = useSwitchChain();
  const publicClient = usePublicClient({ chainId: config.chainId });
  const { deployContractAsync, isPending: deploying } = useDeployContract();
  const [hash, setHash] = useState<`0x${string}`>();
  const [error, setError] = useState("");
  const [copied, setCopied] = useState("");
  const [configuredCodeOk, setConfiguredCodeOk] = useState<boolean | null>(null);
  /**
   * Starts as "unknown" rather than "absent": on the server there is no window,
   * and assuming "absent" would flash a false warning on every load.
   */
  const [walletState, setWalletState] = useState<InjectedWalletState>("unknown");

  useEffect(() => {
    if (hasInjectedWallet()) {
      setWalletState("present");
      return;
    }
    setWalletState("absent");
    // Wallets can inject after load, so keep listening before giving up.
    return onInjectedWalletAvailable(() => setWalletState("present"));
  }, []);

  const receipt = useWaitForTransactionReceipt({ hash, chainId: config.chainId });
  const deployedAddress = receipt.data?.contractAddress;
  const wrongNetwork = isConnected && chainId !== undefined && chainId !== config.chainId;

  const networkConfig = useMemo(
    () => ({
      chainId: config.chainId,
      chainName: config.chainName,
      rpcUrl: config.rpcUrl,
      explorerBase: config.explorerBase,
    }),
    [config.chainId, config.chainName, config.rpcUrl, config.explorerBase],
  );

  /**
   * Move the wallet to the configured network without ever asking the user for
   * an RPC URL, a chain id or an explorer: the wallet is handed ours and adds the
   * network itself when it does not have it.
   */
  const switchToTargetChain = useCallback(async () => {
    setError("");
    try {
      await ensureTargetChain({
        config: networkConfig,
        switchChainAsync,
        getProvider: connector ? () => connector.getProvider() : undefined,
      });
    } catch (cause) {
      setError(describeError(cause));
    }
  }, [networkConfig, connector, switchChainAsync]);

  /** Prompt once per connection rather than making the user find a button. */
  const autoSwitchFor = useRef<string | null>(null);
  useEffect(() => {
    if (!isConnected) {
      autoSwitchFor.current = null;
      return;
    }
    if (!address || !wrongNetwork) return;
    if (autoSwitchFor.current === address) return;
    autoSwitchFor.current = address;
    void switchToTargetChain();
  }, [isConnected, address, wrongNetwork, switchToTargetChain]);

  useEffect(() => {
    let cancelled = false;
    setConfiguredCodeOk(null);
    if (!publicClient || !config.factoryAddress) return;

    publicClient
      .getBytecode({ address: config.factoryAddress })
      .then(code => {
        if (!cancelled) setConfiguredCodeOk(Boolean(code && code !== "0x"));
      })
      .catch(() => {
        if (!cancelled) setConfiguredCodeOk(null);
      });

    return () => {
      cancelled = true;
    };
  }, [publicClient, config.factoryAddress]);

  const envSnippet = useMemo(() => {
    const networkSuffix = config.networkKey === "mainnet" ? "MAINNET" : "SEPOLIA";
    const lines = [
      `NEXT_PUBLIC_TOKEN_CONTRACT_FACTORY_${networkSuffix}=${deployedAddress ?? "<factory address>"}`,
      "",
      "# Free mode (default): no service fee, one transaction.",
      `NEXT_PUBLIC_TOKEN_CREATOR_FEE_${networkSuffix}=0`,
      "",
      "# Lowest-fee mode: uncomment both lines and paste YOUR wallet address.",
      `# NEXT_PUBLIC_TOKEN_CREATOR_FEE_${networkSuffix}=${MIN_SERVICE_FEE_ETH}`,
      `# NEXT_PUBLIC_TOKEN_CREATOR_FEE_RECIPIENT_${networkSuffix}=${address ?? "<your wallet address>"}`,
    ];
    return lines.join("\n");
  }, [config.networkKey, deployedAddress, address]);

  const connectWallet = () => {
    // Re-check at click time: state may be stale if the wallet was installed or
    // unlocked after this page rendered.
    if (!hasInjectedWallet()) {
      setWalletState("absent");
      setError(NO_WALLET_MESSAGE);
      return;
    }
    setWalletState("present");
    setError("");

    const preferred = connectors.find(connector => connector.type === "injected") ?? connectors[0];
    if (!preferred) {
      setError(NO_WALLET_MESSAGE);
      return;
    }
    connect({ connector: preferred }, { onError: cause => setError(describeError(cause)) });
  };

  const deploy = async () => {
    setError("");
    if (!factoryArtifactReady) {
      setError("The compiled factory bytecode is missing. Run `npm run contracts:build` first.");
      return;
    }
    try {
      const txHash = await deployContractAsync({
        abi: tokenFactoryAbi,
        bytecode: tokenFactoryBytecode,
        chainId: config.chainId,
      });
      setHash(txHash);
    } catch (cause) {
      setError(describeError(cause));
    }
  };

  const copy = async (value: string, key: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(key);
      window.setTimeout(() => setCopied(""), 2000);
    } catch {
      setError("Clipboard access was blocked by the browser. Select and copy the value manually.");
    }
  };

  return (
    <main className="shell">
      <nav className="nav">
        <Link href="/" className="brand">
          <span className="mark">T</span> Tokenbase
        </Link>
        <span className="eyebrow">Operator setup</span>
      </nav>

      <section className="panel" style={{ maxWidth: 860, margin: "0 auto", padding: 32 }}>
        <div className="eyebrow">One-time step</div>
        <h2>Deploy the Token Factory</h2>
        <p>
          The factory is the contract that creates your tokens. It is stateless and ownerless: it
          holds no funds, has no admin functions and cannot be upgraded, so deploying it grants you
          no special powers afterwards. Anyone can deploy it; you just pay the one-off gas.
        </p>
        <p className="muted">
          Network: <strong>{config.chainName}</strong> (chain id {config.chainId}) · Contract:{" "}
          <span className="mono">contracts/TokenFactory.sol</span>
        </p>

        <div className="mini-row">
          <span className="muted">Currently configured factory</span>
          <span className="mono">{config.factoryAddress || "— not configured —"}</span>
        </div>
        {config.factoryAddress && (
          <div className="mini-row">
            <span className="muted">Code found at that address</span>
            <strong>
              {configuredCodeOk === null ? "checking…" : configuredCodeOk ? "yes" : "NO — address looks wrong"}
            </strong>
          </div>
        )}

        {!factoryArtifactReady && (
          <div className="error" style={{ marginTop: 14 }}>
            Compiled factory bytecode is missing from this build, so the factory cannot be deployed
            from the browser. Run <span className="mono">npm run contracts:build</span> and redeploy.
          </div>
        )}

        {wrongNetwork && (
          <div className="notice warning">
            {wrongNetworkMessage(chainId, config.chainName)}{" "}
            <button className="button" disabled={switching} onClick={() => void switchToTargetChain()}>
              {switching ? "Switching…" : `Switch to ${config.chainName}`}
            </button>
            <div className="helper" style={{ paddingLeft: 0, marginTop: 8 }}>
              If your wallet does not have {config.chainName} yet, it will offer to add it — the
              RPC, chain id and explorer are supplied for you, so there is nothing to type in.
            </div>
          </div>
        )}

        {error && (
          <div className="error" style={{ marginTop: 14 }}>
            {error}
          </div>
        )}

        {walletState === "absent" && !isConnected && (
          <div className="notice warning">
            <strong>No browser wallet detected.</strong> {NO_WALLET_MESSAGE}{" "}
            <a href="https://metamask.io/download/" target="_blank" rel="noreferrer">
              <u>Get MetaMask →</u>
            </a>
          </div>
        )}

        <div className="actions">
          {!isConnected ? (
            <button className="button" disabled={connecting} onClick={connectWallet}>
              {connecting ? "Connecting…" : "Connect Wallet"}
            </button>
          ) : (
            <button
              className="button"
              disabled={deploying || receipt.isLoading || wrongNetwork || !factoryArtifactReady}
              onClick={() => void deploy()}
            >
              {deploying
                ? "Confirm in your wallet…"
                : receipt.isLoading
                  ? "Waiting for confirmation…"
                  : "Deploy TokenFactory"}
            </button>
          )}
          <Link href="/creator" className="button secondary">
            Back to token creator
          </Link>
        </div>

        {!isConnected && (
          <div className="helper" style={{ paddingLeft: 0 }}>
            {WALLET_REQUIREMENT_HINT}
          </div>
        )}

        {isConnected && (
          <div className="helper" style={{ paddingLeft: 0 }}>
            Connected as <span className="mono">{shortAddress(address ?? "")}</span>
          </div>
        )}

        {hash && (
          <div className="status">
            <strong>Deployment transaction</strong>
            <div className="mono">
              <a href={explorerTxUrl(config.explorerBase, hash)} target="_blank" rel="noreferrer">
                {hash}
              </a>
            </div>
            <span className="muted">
              {receipt.isLoading
                ? "Waiting to be mined…"
                : receipt.isSuccess
                  ? "Mined."
                  : receipt.isError
                    ? "The transaction failed on-chain."
                    : "Submitted."}
            </span>
          </div>
        )}

        {deployedAddress && (
          <div className="status">
            <strong style={{ color: "var(--success)" }}>Factory deployed</strong>
            <div className="mono" style={{ marginTop: 8, wordBreak: "break-all" }}>
              {deployedAddress}
            </div>
            <div className="actions">
              <button className="button secondary" onClick={() => void copy(deployedAddress, "factory")}>
                {copied === "factory" ? "Copied" : "Copy address"}
              </button>
              <a
                className="button secondary"
                href={explorerAddressUrl(config.explorerBase, deployedAddress)}
                target="_blank"
                rel="noreferrer"
              >
                View on BaseScan
              </a>
            </div>

            <p style={{ marginTop: 18 }}>
              Add this to the server environment file, then restart the app container:
            </p>
            <pre
              className="mono"
              style={{
                background: "var(--soft-blue)",
                padding: 14,
                borderRadius: 12,
                overflowX: "auto",
                whiteSpace: "pre-wrap",
              }}
            >
              {envSnippet}
            </pre>
            <div className="actions">
              <button className="button secondary" onClick={() => void copy(envSnippet, "env")}>
                {copied === "env" ? "Copied" : "Copy env block"}
              </button>
            </div>
            <p className="muted">
              If you enable the fee, the recipient should normally be your own wallet — which is{" "}
              <span className="mono">{address ?? "connected wallet"}</span>. Nothing is charged until
              you set a fee.
            </p>
          </div>
        )}
      </section>
    </main>
  );
}
