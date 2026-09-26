"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { parseEther, type Hex } from "viem";
import { useAccount, useChainId, useConnect, useDeployContract, usePublicClient, useSwitchChain } from "wagmi";
import { useAppConfig } from "../lib/app-config-context";
import {
  describeError,
  factoryArtifactsReady,
  factoryBytecode,
  factoryDeployAbi,
} from "../lib/contracts";
import { explorerAddressUrl, explorerTxUrl, shortAddress } from "../lib/creator-state";
import { ensureTargetChain, wrongNetworkMessage } from "../lib/network";
import {
  NO_WALLET_MESSAGE,
  WALLET_REQUIREMENT_HINT,
  hasInjectedWallet,
  onInjectedWalletAvailable,
  type InjectedWalletState,
} from "../lib/wallet";

/**
 * One-click deployment of both token factories.
 *
 * The factories are stateless public contracts with no owner, so deploying them
 * is a permissionless operation anybody can perform from their own wallet. Doing
 * it here means the operator never has to share a private key or run a CLI.
 *
 * There are two of them, and they must both exist: a single factory cannot hold
 * all eight Burnable/Mintable/Pausable combinations inside the EIP-170 contract
 * size limit (see contracts/TokenFactoryV2.sol). The page deploys them in
 * sequence — core first, then burnable — waiting for each receipt so the second
 * transaction cannot be mined out of order.
 *
 * The addresses shown afterwards come from the mined receipts
 * (`contractAddress`), never from a locally predicted value.
 */
type FactoryKind = "core" | "burnable";

const FACTORY_LABELS: Record<FactoryKind, string> = {
  core: "TokenFactoryCore",
  burnable: "TokenFactoryBurnable",
};

export function FactorySetup() {
  const config = useAppConfig();
  const { address, isConnected, connector } = useAccount();
  const chainId = useChainId();
  const { connect, connectors, isPending: connecting } = useConnect();
  const { switchChainAsync, isPending: switching } = useSwitchChain();
  const publicClient = usePublicClient({ chainId: config.chainId });
  const { deployContractAsync, isPending: deploying } = useDeployContract();
  const [deployed, setDeployed] = useState<Partial<Record<FactoryKind, string>>>({});
  const [hashes, setHashes] = useState<Partial<Record<FactoryKind, Hex>>>({});
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState("");
  const [configuredCodeOk, setConfiguredCodeOk] = useState<boolean | null>(null);
  /**
   * Starts as "unknown" rather than "absent": on the server there is no window,
   * and assuming "absent" would fake a warning on every load.
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
    const existing = config.factoryCoreAddress;
    if (!publicClient || !existing) return;

    publicClient
      .getBytecode({ address: existing })
      .then(code => {
        if (!cancelled) setConfiguredCodeOk(Boolean(code && code !== "0x"));
      })
      .catch(() => {
        if (!cancelled) setConfiguredCodeOk(null);
      });

    return () => {
      cancelled = true;
    };
  }, [publicClient, config.factoryCoreAddress]);

  /**
   * The prices written into the contracts at deployment.
   *
   * Read from the environment so a network's pricing stays configuration rather
   * than code, and baked in per deployment: changing the environment later does
   * not change a factory that is already live. Those values become the on-chain
   * truth the page then displays.
   */
  const feeArgs = useMemo(() => {
    const { base, burnable, mintable, pausable } = config.featureFees;
    const recipient = config.feeRecipient || address;
    if (!recipient) return null;
    try {
      return {
        base: parseEther(base as `${number}`),
        burnable: parseEther(burnable as `${number}`),
        mintable: parseEther(mintable as `${number}`),
        pausable: parseEther(pausable as `${number}`),
        recipient,
      };
    } catch {
      return null;
    }
  }, [config.featureFees, config.feeRecipient, address]);

  const envSnippet = useMemo(() => {
    const suffix = config.networkKey === "mainnet" ? "MAINNET" : "SEPOLIA";
    const { base, burnable, mintable, pausable } = config.featureFees;
    return [
      `NEXT_PUBLIC_TOKEN_CONTRACT_FACTORY_CORE_${suffix}=${deployed.core ?? "<core factory address>"}`,
      `NEXT_PUBLIC_TOKEN_CONTRACT_FACTORY_BURNABLE_${suffix}=${deployed.burnable ?? "<burnable factory address>"}`,
      "",
      "# Service fee per feature, in ETH. These are the prices the factories were",
      "# deployed with; the page displays what the contracts actually report.",
      `NEXT_PUBLIC_TOKEN_CREATOR_FEE_${suffix}=${base}`,
      `NEXT_PUBLIC_BURNABLE_FEE_${suffix}=${burnable}`,
      `NEXT_PUBLIC_MINTABLE_FEE_${suffix}=${mintable}`,
      `NEXT_PUBLIC_PAUSABLE_FEE_${suffix}=${pausable}`,
      `NEXT_PUBLIC_TOKEN_CREATOR_FEE_RECIPIENT_${suffix}=${address ?? "<fee recipient address>"}`,
    ].join("\n");
  }, [config.networkKey, config.featureFees, deployed, address]);

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
    setDeployed({});
    setHashes({});

    if (!factoryArtifactsReady) {
      setError("The compiled factory bytecode is missing. Run `npm run contracts:build` first.");
      return;
    }
    if (!feeArgs) {
      setError(
        "The feature fees could not be read, or no fee recipient is available. Set the NEXT_PUBLIC_*_FEE_* values and connect a wallet.",
      );
      return;
    }
    if (!publicClient) {
      setError("No RPC client is available for this network.");
      return;
    }

    try {
      // Core first: it covers the combinations without Burnable. Both are needed
      // for the creator page to offer all eight, so neither is optional.
      setProgress("Deploying TokenFactoryCore — confirm in your wallet…");
      const coreHash = await deployContractAsync({
        abi: factoryDeployAbi.core,
        bytecode: factoryBytecode.core,
        args: [feeArgs.base, feeArgs.mintable, feeArgs.pausable, feeArgs.recipient],
        chainId: config.chainId,
      });
      setHashes(previous => ({ ...previous, core: coreHash }));
      setProgress("Waiting for TokenFactoryCore to be mined…");
      const coreReceipt = await publicClient.waitForTransactionReceipt({ hash: coreHash });
      const coreAddress = coreReceipt.contractAddress;
      if (coreReceipt.status !== "success" || !coreAddress) {
        setError("TokenFactoryCore did not deploy successfully. Nothing else was sent.");
        setProgress("");
        return;
      }
      setDeployed(previous => ({ ...previous, core: coreAddress }));

      setProgress("Deploying TokenFactoryBurnable — confirm in your wallet…");
      const burnableHash = await deployContractAsync({
        abi: factoryDeployAbi.burnable,
        bytecode: factoryBytecode.burnable,
        args: [feeArgs.base, feeArgs.burnable, feeArgs.mintable, feeArgs.pausable, feeArgs.recipient],
        chainId: config.chainId,
      });
      setHashes(previous => ({ ...previous, burnable: burnableHash }));
      setProgress("Waiting for TokenFactoryBurnable to be mined…");
      const burnableReceipt = await publicClient.waitForTransactionReceipt({ hash: burnableHash });
      const burnableAddress = burnableReceipt.contractAddress;
      if (burnableReceipt.status !== "success" || !burnableAddress) {
        setError(
          `TokenFactoryBurnable did not deploy successfully. TokenFactoryCore at ${coreAddress} is live.`,
        );
        setProgress("");
        return;
      }
      setDeployed(previous => ({ ...previous, burnable: burnableAddress }));
      setProgress("");
    } catch (cause) {
      setProgress("");
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

  const bothDeployed = Boolean(deployed.core && deployed.burnable);

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
        <h2>Deploy the Token Factories</h2>
        <p>
          Two contracts create your tokens. They are stateless and ownerless: they hold no funds
          beyond the fee they forward immediately, have no admin functions and cannot be upgraded,
          so deploying them grants you no powers afterwards. Anyone can deploy them; you just pay
          the one-off gas for each.
        </p>
        <p className="muted">
          Network: <strong>{config.chainName}</strong> (chain id {config.chainId}) · Contract:{" "}
          <span className="mono">contracts/TokenFactoryV2.sol</span>
        </p>
        <p className="muted">
          Two contracts rather than one because the contract size limit (EIP-170, 24576 bytes)
          cannot hold all eight feature combinations: the eight token variants need 30664 bytes. So
          one factory hosts the combinations without Burnable and the other hosts those with it.
        </p>

        <div className="mini-row">
          <span className="muted">Currently configured core factory</span>
          <span className="mono">{config.factoryCoreAddress || "— not configured —"}</span>
        </div>
        <div className="mini-row">
          <span className="muted">Currently configured burnable factory</span>
          <span className="mono">{config.factoryBurnableAddress || "— not configured —"}</span>
        </div>
        {config.factoryCoreAddress && (
          <div className="mini-row">
            <span className="muted">Code found at the core address</span>
            <strong>
              {configuredCodeOk === null
                ? "checking…"
                : configuredCodeOk
                  ? "yes"
                  : "NO — address looks wrong"}
            </strong>
          </div>
        )}

        <div className="mini-row">
          <span className="muted">Prices to be written into the contracts</span>
          <span className="mono">
            base {config.featureFees.base} · burnable {config.featureFees.burnable} · mintable{" "}
            {config.featureFees.mintable} · pausable {config.featureFees.pausable} ETH
          </span>
        </div>
        <div className="mini-row">
          <span className="muted">Fee recipient</span>
          <span className="mono">{config.feeRecipient || address || "— connect a wallet —"}</span>
        </div>

        {!factoryArtifactsReady && (
          <div className="error" style={{ marginTop: 14 }}>
            Compiled factory bytecode is missing from this build, so the factories cannot be
            deployed from the browser. Run <span className="mono">npm run contracts:build</span> and
            redeploy.
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
              disabled={deploying || Boolean(progress) || wrongNetwork || !factoryArtifactsReady}
              onClick={() => void deploy()}
            >
              {deploying
                ? "Confirm in your wallet…"
                : bothDeployed
                  ? "Deploy again"
                  : "Deploy both factories"}
            </button>
          )}
          <Link href="/creator" className="button secondary">
            Back to token creator
          </Link>
        </div>

        {progress && (
          <div className="helper" style={{ paddingLeft: 0 }}>
            {progress}
          </div>
        )}

        {!isConnected && (
          <div className="helper" style={{ paddingLeft: 0 }}>
            {WALLET_REQUIREMENT_HINT}
          </div>
        )}

        {isConnected && (
          <div className="helper" style={{ paddingLeft: 0 }}>
            Connected as <span className="mono">{shortAddress(address ?? "")}</span>. Two
            transactions will be requested, one per factory.
          </div>
        )}

        {(hashes.core || hashes.burnable) && (
          <div className="status">
            <strong>Deployment transactions</strong>
            {(["core", "burnable"] as FactoryKind[]).map(kind =>
              hashes[kind] ? (
                <div key={kind} style={{ marginTop: 8 }}>
                  <span className="muted">{FACTORY_LABELS[kind]}</span>
                  <div className="mono">
                    <a
                      href={explorerTxUrl(config.explorerBase, hashes[kind]!)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {hashes[kind]}
                    </a>
                  </div>
                </div>
              ) : null,
            )}
          </div>
        )}

        {(deployed.core || deployed.burnable) && (
          <div className="status">
            <strong style={{ color: bothDeployed ? "var(--success)" : undefined }}>
              {bothDeployed ? "Both factories deployed" : "Partially deployed"}
            </strong>
            {(["core", "burnable"] as FactoryKind[]).map(kind =>
              deployed[kind] ? (
                <div key={kind} style={{ marginTop: 12 }}>
                  <span className="muted">{FACTORY_LABELS[kind]}</span>
                  <div className="mono" style={{ wordBreak: "break-all" }}>
                    {deployed[kind]}
                  </div>
                  <div className="actions">
                    <button className="button secondary" onClick={() => void copy(deployed[kind]!, kind)}>
                      {copied === kind ? "Copied" : "Copy address"}
                    </button>
                    <a
                      className="button secondary"
                      href={explorerAddressUrl(config.explorerBase, deployed[kind]!)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      View on BaseScan
                    </a>
                  </div>
                </div>
              ) : null,
            )}

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
              The fee recipient is <span className="mono">{address ?? "the connected wallet"}</span>.
              Each creation forwards its service fee to that address in the same transaction, and the
              factories keep nothing.
            </p>
          </div>
        )}
      </section>
    </main>
  );
}
