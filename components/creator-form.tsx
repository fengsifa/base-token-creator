"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Address } from "viem";
import { decodeEventLog, isAddress } from "viem";
import {
  useAccount,
  useBalance,
  useChainId,
  useConnect,
  useDisconnect,
  usePublicClient,
  useSendTransaction,
  useSwitchChain,
  useWaitForTransactionReceipt,
  useWriteContract,
} from "wagmi";
import { LogoUpload } from "./logo-upload";
import { useAppConfig } from "../lib/app-config-context";
import { feeToWei } from "../lib/config";
import { describeError, erc20ReadAbi, tokenFactoryAbi } from "../lib/contracts";
import { ensureTargetChain, wrongNetworkMessage } from "../lib/network";
import {
  deriveCreatorState,
  explorerAddressUrl,
  explorerTxUrl,
  feeSummary,
  isTxHash,
  shortAddress,
  txFailureState,
  type Stage,
} from "../lib/creator-state";
import { validateTokenInput } from "../lib/validation";
import {
  NO_WALLET_MESSAGE,
  hasInjectedWallet,
  onInjectedWalletAvailable,
} from "../lib/wallet";

type OnChainToken = {
  name: string;
  symbol: string;
  decimals: number;
  totalSupply: bigint;
  balanceOf: bigint;
};

/**
 * The token creation flow.
 *
 * Two shapes, chosen by configuration:
 *  - fee = 0 (default): one user-signed transaction calls the factory directly.
 *  - fee > 0: pay the service fee, then deploy — two user-signed transactions.
 *
 * Either way the token address is taken exclusively from the `TokenCreated`
 * event in the mined receipt, and then re-read from the chain. The UI never
 * invents an address, a hash, or a success state.
 */
export function CreatorForm() {
  const config = useAppConfig();
  const feeWei = useMemo(() => feeToWei(config.feeEth), [config.feeEth]);
  const requiresPayment = feeWei > 0n;

  const [name, setName] = useState("My Token");
  const [symbol, setSymbol] = useState("MTK");
  const [supply, setSupply] = useState("1000000");
  const [decimals, setDecimals] = useState("18");
  const [logo, setLogo] = useState<string>();
  const [stage, setStage] = useState<Stage>("idle");
  const [error, setError] = useState("");
  const [dbWarning, setDbWarning] = useState("");
  const [darkMode, setDarkMode] = useState(false);
  const [paymentHash, setPaymentHash] = useState<`0x${string}`>();
  const [deploymentHash, setDeploymentHash] = useState<`0x${string}`>();
  const [tokenAddress, setTokenAddress] = useState("");
  const [onChain, setOnChain] = useState<OnChainToken | null>(null);
  const [recordId, setRecordId] = useState("");
  const [injectedAvailable, setInjectedAvailable] = useState(false);
  const [factoryCodeOk, setFactoryCodeOk] = useState<boolean | null>(null);
  const [copied, setCopied] = useState("");

  const { address, isConnected, connector } = useAccount();
  const chainId = useChainId();
  const { connect, connectors, isPending: connecting } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChainAsync, isPending: switching } = useSwitchChain();
  // Balance is read on the *target* chain so "you have 0 ETH on Base Sepolia"
  // is accurate even while the wallet is still pointed at another network.
  const { data: balance } = useBalance({ address, chainId: config.chainId });
  const publicClient = usePublicClient({ chainId: config.chainId });
  const { sendTransactionAsync } = useSendTransaction();
  const { writeContractAsync } = useWriteContract();
  const payment = useWaitForTransactionReceipt({ hash: paymentHash, chainId: config.chainId });
  const deployment = useWaitForTransactionReceipt({ hash: deploymentHash, chainId: config.chainId });

  const validation = useMemo(
    () => validateTokenInput({ name, symbol, supply, decimals }),
    [name, symbol, supply, decimals],
  );
  const fieldErrors = validation.ok ? {} : validation.errors;

  const hasConnector = useMemo(
    () => connectors.some(connector => connector.type !== "injected") || injectedAvailable,
    [connectors, injectedAvailable],
  );

  const state = useMemo(
    () =>
      deriveCreatorState({
        isConnected,
        hasConnector,
        connecting,
        switching,
        chainId,
        expectedChainId: config.chainId,
        expectedChainName: config.chainName,
        feeWei,
        balanceWei: balance?.value,
        factoryAddress: config.factoryAddress,
        formValid: validation.ok,
        stage,
      }),
    [
      isConnected,
      hasConnector,
      connecting,
      switching,
      chainId,
      config.chainId,
      config.chainName,
      config.factoryAddress,
      feeWei,
      balance?.value,
      validation.ok,
      stage,
    ],
  );

  // ---------------------------------------------------------------------------
  // Network
  // ---------------------------------------------------------------------------

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
   * Ask the wallet to move to the configured network.
   *
   * The wallet is handed our own RPC URL, chain name, native currency and
   * explorer, and it adds the network itself when it does not know it yet. The
   * user never sees a form asking for any of that.
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

  /**
   * Prompt the switch once as soon as the wallet is connected on the wrong
   * network, instead of making the user hunt for a button. Guarded per account so
   * it fires once, and cleared on disconnect so a reconnect can prompt again. A
   * refusal is respected: the notice and its button stay available.
   */
  const autoSwitchFor = useRef<string | null>(null);
  useEffect(() => {
    if (!isConnected) {
      autoSwitchFor.current = null;
      return;
    }
    if (!address || !state.wrongNetwork) return;
    if (autoSwitchFor.current === address) return;
    autoSwitchFor.current = address;
    void switchToTargetChain();
  }, [isConnected, address, state.wrongNetwork, switchToTargetChain]);

  /** The address is configured but has no bytecode on this chain. */
  const factoryCodeMissing = Boolean(config.factoryAddress) && factoryCodeOk === false;

  // ---------------------------------------------------------------------------
  // Environment detection
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (hasInjectedWallet()) {
      setInjectedAvailable(true);
      return;
    }
    setInjectedAvailable(false);
    // Wallets can inject after load, so keep listening before giving up.
    return onInjectedWalletAvailable(() => setInjectedAvailable(true));
  }, []);

  // ---------------------------------------------------------------------------
  // Recovery of an in-flight transaction after a page refresh
  // ---------------------------------------------------------------------------

  useEffect(() => {
    const storedPayment = localStorage.getItem("tokenbase.paymentHash");
    const storedDeployment = localStorage.getItem("tokenbase.deploymentHash");
    const storedRecord = localStorage.getItem("tokenbase.recordId");

    if (isTxHash(storedPayment)) setPaymentHash(storedPayment);
    if (isTxHash(storedDeployment)) {
      setDeploymentHash(storedDeployment);
      setStage("deploying");
    }
    if (storedRecord) setRecordId(storedRecord);
  }, []);

  useEffect(() => {
    if (paymentHash) localStorage.setItem("tokenbase.paymentHash", paymentHash);
  }, [paymentHash]);

  useEffect(() => {
    if (deploymentHash) localStorage.setItem("tokenbase.deploymentHash", deploymentHash);
  }, [deploymentHash]);

  useEffect(() => {
    document.documentElement.dataset.theme = darkMode ? "dark" : "";
  }, [darkMode]);

  // ---------------------------------------------------------------------------
  // Verify the configured factory really exists on-chain before spending gas
  // ---------------------------------------------------------------------------

  useEffect(() => {
    let cancelled = false;
    setFactoryCodeOk(null);

    if (!publicClient || !config.factoryAddress) return;

    publicClient
      .getBytecode({ address: config.factoryAddress })
      .then(code => {
        if (!cancelled) setFactoryCodeOk(Boolean(code && code !== "0x"));
      })
      .catch(() => {
        // RPC unavailable: do not block the user on an unknown.
        if (!cancelled) setFactoryCodeOk(null);
      });

    return () => {
      cancelled = true;
    };
  }, [publicClient, config.factoryAddress]);

  // ---------------------------------------------------------------------------
  // Database mirror (never authoritative — the chain is)
  // ---------------------------------------------------------------------------

  const save = useCallback(
    async (payload: Record<string, unknown>) => {
      try {
        const response = await fetch(recordId ? `/api/creations/${recordId}` : "/api/creations", {
          method: recordId ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const body = (await response.json().catch(() => ({}))) as {
          error?: string;
          record?: { id?: string };
        };
        if (!response.ok) throw new Error(body.error || "Database error");
        const id = body.record?.id;
        if (!recordId && typeof id === "string") {
          setRecordId(id);
          localStorage.setItem("tokenbase.recordId", id);
        }
        setDbWarning("");
      } catch (cause) {
        setDbWarning(
          cause instanceof Error
            ? cause.message
            : "Database unavailable. The on-chain state remains authoritative.",
        );
      }
    },
    [recordId],
  );

  // ---------------------------------------------------------------------------
  // Transaction lifecycle
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (!payment.isSuccess || stage !== "paying") return;
    setStage("payment_confirmed");
    void save({ status: "payment_confirmed", payment_tx_hash: paymentHash });
  }, [payment.isSuccess, paymentHash, save, stage]);

  useEffect(() => {
    if (!payment.isError || stage !== "paying") return;
    const failure = txFailureState("payment", requiresPayment);
    setStage(failure.stage);
    setError(failure.message);
  }, [payment.isError, stage, requiresPayment]);

  /** Token address, read from the factory event in the mined receipt. */
  const createdTokenAddress = useMemo(() => {
    const logs = deployment.data?.logs;
    if (!logs || !config.factoryAddress) return undefined;

    for (const log of logs) {
      if (log.address.toLowerCase() !== config.factoryAddress.toLowerCase()) continue;
      try {
        const decoded = decodeEventLog({
          abi: tokenFactoryAbi,
          eventName: "TokenCreated",
          data: log.data,
          topics: log.topics,
        });
        const token = decoded.args.token;
        if (typeof token === "string" && isAddress(token)) return token;
      } catch {
        // Not a TokenCreated log — keep looking.
      }
    }
    return undefined;
  }, [deployment.data, config.factoryAddress]);

  useEffect(() => {
    if (!deployment.isSuccess || stage !== "deploying") return;

    if (createdTokenAddress) {
      setTokenAddress(createdTokenAddress);
      setStage("success");
      void save({
        status: "success",
        contract_address: createdTokenAddress,
        deployment_tx_hash: deploymentHash,
      });
      localStorage.removeItem("tokenbase.deploymentHash");
      localStorage.removeItem("tokenbase.paymentHash");
      return;
    }

    // Mined, but no TokenCreated event. Never claim success.
    const failure = txFailureState("deployment", requiresPayment);
    setStage(failure.stage);
    setError(
      "The transaction was mined, but its receipt contains no TokenCreated event, so no token address can be confirmed. Open it on BaseScan and inspect the logs before retrying.",
    );
  }, [
    deployment.isSuccess,
    createdTokenAddress,
    deploymentHash,
    save,
    stage,
    requiresPayment,
  ]);

  useEffect(() => {
    if (!deployment.isError || stage !== "deploying") return;
    const failure = txFailureState("deployment", requiresPayment);
    setStage(failure.stage);
    setError(failure.message);
  }, [deployment.isError, stage, requiresPayment]);

  // ---------------------------------------------------------------------------
  // Read the created token back from the chain so the user sees verified values
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (!tokenAddress || !publicClient || !address) return;

    let cancelled = false;
    const token = tokenAddress as Address;

    Promise.all([
      publicClient.readContract({ address: token, abi: erc20ReadAbi, functionName: "name" }),
      publicClient.readContract({ address: token, abi: erc20ReadAbi, functionName: "symbol" }),
      publicClient.readContract({ address: token, abi: erc20ReadAbi, functionName: "decimals" }),
      publicClient.readContract({ address: token, abi: erc20ReadAbi, functionName: "totalSupply" }),
      publicClient.readContract({
        address: token,
        abi: erc20ReadAbi,
        functionName: "balanceOf",
        args: [address],
      }),
    ])
      .then(([tokenName, tokenSymbol, tokenDecimals, totalSupply, balanceOf]) => {
        if (cancelled) return;
        setOnChain({
          name: tokenName as string,
          symbol: tokenSymbol as string,
          decimals: Number(tokenDecimals),
          totalSupply: totalSupply as bigint,
          balanceOf: balanceOf as bigint,
        });
      })
      .catch(() => {
        if (!cancelled) setOnChain(null);
      });

    return () => {
      cancelled = true;
    };
  }, [tokenAddress, publicClient, address, deployment.isSuccess]);

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  const connectWallet = () => {
    // Re-check at click time: the wallet may have been installed or unlocked
    // after this page rendered, and the state above would be stale.
    if (!hasInjectedWallet()) {
      setInjectedAvailable(false);
      setError(NO_WALLET_MESSAGE);
      return;
    }
    setInjectedAvailable(true);

    const preferred = connectors.find(connector => connector.type === "injected") ?? connectors[0];
    if (!preferred) {
      setError(NO_WALLET_MESSAGE);
      return;
    }
    connect(
      { connector: preferred },
      {
        onError: cause => setError(describeError(cause)),
      },
    );
  };

  const pay = async () => {
    setError("");
    if (!address) return;

    const recipient = config.feeRecipient;
    if (!recipient || feeWei <= 0n) {
      setError(
        "The service fee is not usable: a positive fee needs a valid fee recipient address. Use the free mode (fee 0) or fix the configuration.",
      );
      return;
    }

    try {
      setStage("paying");
      const hash = await sendTransactionAsync({
        to: recipient,
        value: feeWei,
        chainId: config.chainId,
      });
      setPaymentHash(hash);
      await save({
        wallet_address: address,
        network: config.chainName,
        token_name: validation.ok ? validation.value.name : name.trim(),
        token_symbol: validation.ok ? validation.value.symbol : symbol.trim().toUpperCase(),
        total_supply: validation.ok ? validation.value.supply : supply,
        decimals: validation.ok ? validation.value.decimals : Number(decimals),
        logo_url: logo || null,
        payment_tx_hash: hash,
        status: "pending_payment",
      });
    } catch (cause) {
      const failure = txFailureState("payment", true);
      setStage(failure.stage);
      setError(describeError(cause));
    }
  };

  const deploy = async () => {
    setError("");
    if (!address || !config.factoryAddress || !validation.ok) return;

    const { name: tokenName, symbol: tokenSymbol, decimals: tokenDecimals, supply: tokenSupply, rawSupply } =
      validation.value;

    try {
      setStage("deploying");

      // Mirror the attempt into PostgreSQL. A failure here is a warning only.
      await save({
        wallet_address: address,
        network: config.chainName,
        token_name: tokenName,
        token_symbol: tokenSymbol,
        total_supply: tokenSupply,
        decimals: tokenDecimals,
        logo_url: logo || null,
        payment_tx_hash: paymentHash ?? null,
        status: "deploying",
      });

      const hash = await writeContractAsync({
        address: config.factoryAddress,
        abi: tokenFactoryAbi,
        functionName: "createToken",
        args: [tokenName, tokenSymbol, tokenDecimals, rawSupply],
        chainId: config.chainId,
      });

      setDeploymentHash(hash);
      localStorage.setItem("tokenbase.deploymentHash", hash);
    } catch (cause) {
      const failure = txFailureState("deployment", requiresPayment);
      setStage(failure.stage);
      setError(describeError(cause));
    }
  };

  const handlePrimaryAction = () => {
    switch (state.primaryActionKind) {
      case "connect":
        connectWallet();
        return;
      case "switch-network":
        void switchToTargetChain();
        return;
      case "pay":
        void pay();
        return;
      case "deploy":
        void deploy();
        return;
      default:
        return;
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

  const retryableDeployment = !requiresPayment || stage === "payment_confirmed";

  return (
    <main>
      <header className="site-header">
        <Link href="/" className="brand">
          <span className="mark">T</span> Tokenbase
        </Link>
        <div className="header-actions">
          <button
            className="icon-button"
            aria-label="Toggle theme"
            onClick={() => setDarkMode(value => !value)}
          >
            {darkMode ? "☀" : "◐"}
          </button>
          {isConnected ? (
            <button className="button header-connect" onClick={() => disconnect()}>
              {shortAddress(address ?? "")}
            </button>
          ) : (
            <button
              className="button header-connect"
              disabled={connecting || !hasConnector}
              onClick={connectWallet}
            >
              {connecting ? "Connecting…" : "Connect Wallet"}
            </button>
          )}
        </div>
      </header>

      <section className="hero">
        <div className="hero-badge">▣&nbsp; ERC-20 on {config.chainName}</div>
        <h1>Base Token Creator</h1>
        <p>
          Launch a standard ERC-20 on {config.chainName}. Your wallet signs the transaction, the
          supply is minted to you, and the contract has no owner and no backdoor.
        </p>
      </section>

      <section className="creator-card">
        {/* ------------------------------------------------------------------ */}
        {/* Deployment configuration problems, stated plainly                   */}
        {/* ------------------------------------------------------------------ */}
        {!config.factoryAddress && (
          <div className="form-section">
            <div className="notice warning">
              <strong>Token Factory is not configured yet.</strong> No token can be created until a
              factory address is set.{" "}
              <Link href="/setup">
                <u>Deploy the factory from your wallet →</u>
              </Link>
            </div>
          </div>
        )}

        {config.issues.length > 0 && (
          <div className="form-section">
            {config.issues.map(issue => (
              <div className="notice warning" key={issue.code}>
                {issue.message}
              </div>
            ))}
          </div>
        )}

        {/* ------------------------------------------------------------------ */}
        {/* Token parameters                                                    */}
        {/* ------------------------------------------------------------------ */}
        <div className="form-section">
          <div className="form-grid">
            <div className="field">
              <label>Name</label>
              <input
                placeholder="Ex: Base"
                value={name}
                maxLength={32}
                onChange={event => setName(event.target.value)}
              />
              {fieldErrors.name && <span className="error">{fieldErrors.name}</span>}
            </div>

            <div className="field">
              <label>
                Symbol <span className="muted">{symbol.length}/12</span>
              </label>
              <input
                placeholder="Ex: ETH"
                value={symbol}
                maxLength={12}
                onChange={event => setSymbol(event.target.value.toUpperCase())}
              />
              {fieldErrors.symbol && <span className="error">{fieldErrors.symbol}</span>}
            </div>

            <div className="field">
              <label>Decimals</label>
              <input
                placeholder="Most tokens use 18 decimals"
                value={decimals}
                inputMode="numeric"
                onChange={event => setDecimals(event.target.value)}
              />
              <span className="helper">
                0–18 · use 0 for whole-number tokens · recommended: 18
              </span>
              {fieldErrors.decimals && <span className="error">{fieldErrors.decimals}</span>}
            </div>

            <div className="field">
              <label>Supply</label>
              <input
                placeholder="Most tokens use 1,000,000,000"
                value={supply}
                inputMode="decimal"
                onChange={event => setSupply(event.target.value)}
              />
              <span className="helper">Total tokens minted to your wallet at creation</span>
              {fieldErrors.supply && <span className="error">{fieldErrors.supply}</span>}
            </div>

            <div className="field full">
              <label>
                Logo <span className="optional muted">(optional)</span>
              </label>
              <LogoUpload onUploaded={setLogo} onError={setError} />
              <span className="helper">
                Optional server-side logo storage. The token itself stays a standard ERC-20.
              </span>
            </div>
          </div>

          {validation.ok && (
            <div className="notice" style={{ marginTop: 16 }}>
              <span className="mono">
                {validation.value.supply} {validation.value.symbol} · {validation.value.decimals}{" "}
                decimals · {validation.value.rawSupply.toString()} base units
              </span>
            </div>
          )}
          {!validation.ok && validation.message && (
            <div className="error" style={{ marginTop: 15 }}>
              {validation.message}
            </div>
          )}
        </div>

        {/* ------------------------------------------------------------------ */}
        {/* Fee                                                                 */}
        {/* ------------------------------------------------------------------ */}
        <div className="form-section">
          <div className="section-heading">
            <div>
              <h2>Service fee</h2>
              <p>
                {requiresPayment
                  ? "A non-zero service fee is configured, so creation is two wallet transactions: the fee, then the deployment."
                  : "Free mode: there is no service fee. Creating a token is a single wallet transaction and you only pay network gas."}
              </p>
            </div>
          </div>
          <div className="mini-row">
            <span className="muted">Total fees</span>
            <strong>{feeSummary(config.feeEth, requiresPayment)}</strong>
          </div>
          <div className="mini-row">
            <span className="muted">Transactions you will sign</span>
            <strong>{requiresPayment ? "2 (fee, then deploy)" : "1 (deploy only)"}</strong>
          </div>
          {requiresPayment && (
            <div className="mini-row">
              <span className="muted">Fee recipient</span>
              <span className="mono">{config.feeRecipient || "— not configured —"}</span>
            </div>
          )}
        </div>

        {/* ------------------------------------------------------------------ */}
        {/* Features this factory genuinely does not implement                  */}
        {/* ------------------------------------------------------------------ */}
        <div className="form-section">
          <div className="section-heading">
            <div>
              <h2>Token Properties</h2>
              <p>Not implemented by TokenFactory. Shown so nobody expects them.</p>
            </div>
          </div>
          <div className="property-grid">
            {[
              ["◒", "Burnable", "Enable the ability to permanently remove tokens from circulation by burning"],
              ["▤", "Mintable", "Enable minting for your token, only the owner can mint."],
              ["Ⅱ", "Pausable", "Allows pausing all token transfers and trading activity temporarily"],
            ].map(([icon, title, description]) => (
              <div className="property-card is-disabled" key={title}>
                <div className="property-top">
                  <span className="property-name">
                    {icon}&nbsp; {title}
                  </span>
                  <span className="property-price">Unavailable</span>
                </div>
                <p>{description}</p>
              </div>
            ))}
          </div>
        </div>

        <div className="form-section">
          <div className="section-heading">
            <div>
              <h2>Trading Limits</h2>
              <p>Protection features are not implemented in the current factory contract.</p>
            </div>
          </div>
          <div className="property-grid">
            {[
              ["◈", "Anti whale", "Set trading limits to your token to avoid whales"],
              ["♙", "Anti Bot", "Prevent bots from trading your token by limiting to one trade per block"],
              ["⊘", "Blacklist", "Add addresses to a blacklist that prevents them from trading the token"],
            ].map(([icon, title, description]) => (
              <div className="property-card is-disabled" key={title}>
                <div className="property-top">
                  <span className="property-name">
                    {icon}&nbsp; {title}
                  </span>
                  <span className="property-price">Unavailable</span>
                </div>
                <p>{description}</p>
              </div>
            ))}
          </div>
        </div>

        {/* ------------------------------------------------------------------ */}
        {/* Wallet and deployment                                               */}
        {/* ------------------------------------------------------------------ */}
        <div className="form-section">
          <div className="section-heading">
            <div>
              <h2>Wallet and deployment</h2>
              <p>
                {requiresPayment
                  ? "Connect your wallet to pay the service fee and deploy your token."
                  : "Connect your wallet and deploy your token in one signed transaction."}
              </p>
            </div>
          </div>

          {state.wrongNetwork && (
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

          {isConnected && balance && (
            <div className="helper">
              Wallet balance on {config.chainName}: {balance.formatted} {balance.symbol}
              {state.insufficientFee ? " · below the service fee" : ""}
              {state.emptyGasBalance ? " · no ETH available for gas" : ""}
            </div>
          )}

          {factoryCodeMissing && (
            <div className="error" style={{ marginTop: 10 }}>
              No contract code was found at the configured factory address{" "}
              <span className="mono">{config.factoryAddress}</span> on {config.chainName}. Check the
              address, or deploy the factory first.
            </div>
          )}

          {error && (
            <div className="error" style={{ marginTop: 10 }}>
              {error}
            </div>
          )}

          {dbWarning && (
            <div className="notice warning">
              Database record warning: {dbWarning} The on-chain result is unaffected.
            </div>
          )}

          {state.blockers.length > 0 && (
            <div className="notice warning">
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {state.blockers.map(blocker => (
                  <li key={blocker}>{blocker}</li>
                ))}
              </ul>
            </div>
          )}

          {stage === "paying" && (
            <div className="status">
              <strong>Payment pending</strong>
              <span className="muted">
                Confirm the transaction in your wallet, then wait for the receipt.
              </span>
              {paymentHash && (
                <div className="mono">
                  <a href={explorerTxUrl(config.explorerBase, paymentHash)} target="_blank" rel="noreferrer">
                    View payment transaction ↗
                  </a>
                </div>
              )}
            </div>
          )}

          {stage === "payment_confirmed" && (
            <div className="status">
              <strong>Payment confirmed on-chain</strong>
              <span className="muted">Your token is ready for deployment.</span>
              {paymentHash && (
                <div className="mono">
                  <a href={explorerTxUrl(config.explorerBase, paymentHash)} target="_blank" rel="noreferrer">
                    View payment transaction ↗
                  </a>
                </div>
              )}
            </div>
          )}

          {stage === "deploying" && (
            <div className="status">
              <strong>Deployment pending</strong>
              <span className="muted">
                Waiting for the transaction to be mined and the TokenCreated event to appear.
              </span>
              {deploymentHash && (
                <div className="mono">
                  <a
                    href={explorerTxUrl(config.explorerBase, deploymentHash)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    View deployment transaction ↗
                  </a>
                </div>
              )}
            </div>
          )}

          {stage === "success" && tokenAddress && (
            <div className="status">
              <strong style={{ color: "var(--success)" }}>Token created successfully</strong>
              <span className="muted">
                Address taken from the TokenCreated event of the mined transaction.
              </span>
              <div className="mono" style={{ marginTop: 10, wordBreak: "break-all" }}>
                {tokenAddress}
              </div>

              <div className="mini-row">
                <span className="muted">Read back from the chain</span>
                <strong>{onChain ? `${onChain.name} (${onChain.symbol})` : "reading…"}</strong>
              </div>
              {onChain && (
                <>
                  <div className="mini-row">
                    <span className="muted">Total supply</span>
                    <span className="mono">
                      {onChain.totalSupply.toString()} base units · {onChain.decimals} decimals
                    </span>
                  </div>
                  <div className="mini-row">
                    <span className="muted">Your balance</span>
                    <span className="mono">{onChain.balanceOf.toString()} base units</span>
                  </div>
                </>
              )}

              <div className="actions">
                <button className="button secondary" onClick={() => void copy(tokenAddress, "token")}>
                  {copied === "token" ? "Copied" : "Copy contract"}
                </button>
                <a
                  className="button"
                  href={explorerAddressUrl(config.explorerBase, tokenAddress)}
                  target="_blank"
                  rel="noreferrer"
                >
                  View on BaseScan
                </a>
                {deploymentHash && (
                  <a
                    className="button secondary"
                    href={explorerTxUrl(config.explorerBase, deploymentHash)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    View transaction
                  </a>
                )}
              </div>
            </div>
          )}

          {stage !== "success" && (
            <>
              <div className="actions">
                <button
                  className="button primary-action"
                  disabled={state.primaryDisabled || factoryCodeMissing}
                  onClick={handlePrimaryAction}
                >
                  {state.primaryLabel}
                </button>
              </div>
              <div className="total-fees">
                Total Fees: <strong>{feeSummary(config.feeEth, requiresPayment)}</strong>
              </div>
            </>
          )}

          {requiresPayment && retryableDeployment && stage === "payment_confirmed" && (
            <div className="helper" style={{ paddingLeft: 0 }}>
              The service fee is already paid. Retrying only sends the deployment transaction.
            </div>
          )}
        </div>
      </section>

      <div className="footer-note">
        Your wallet signs every transaction. No private keys and no seed phrases are ever requested by
        this app. Payments ({config.feeEth} ETH configured) and deployments are separate user-signed
        transactions when a fee is set.
      </div>
    </main>
  );
}
