"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Address } from "viem";
import { decodeEventLog, formatEther, isAddress } from "viem";
import {
  useAccount,
  useBalance,
  useChainId,
  useConnect,
  useDisconnect,
  usePublicClient,
  useReadContract,
  useReadContracts,
  useSwitchChain,
  useWaitForTransactionReceipt,
  useWriteContract,
} from "wagmi";
import { LogoUpload } from "./logo-upload";
import { useAppConfig } from "../lib/app-config-context";
import { feeToWei } from "../lib/config";
import {
  TOKEN_FEATURES,
  describeError,
  erc20ReadAbi,
  factoryEventAbis,
  factoryKindFor,
  tokenFactoryAbi,
  type TokenFeatureKey,
} from "../lib/contracts";
import { ensureTargetChain, wrongNetworkMessage } from "../lib/network";
import {
  creationFailureState,
  deriveCreatorState,
  explorerAddressUrl,
  explorerTxUrl,
  feeSummary,
  isTxHash,
  shortAddress,
  type Stage,
} from "../lib/creator-state";
import { validateTokenInput } from "../lib/validation";
import {
  checkCreationContext,
  failureWrite,
  isRecordId,
  planRecordWrite,
  shouldRecreateAsPost,
  successWrite,
  type CreationContext,
  type RecordUpdate,
} from "../lib/record-write";
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
 * One transaction: the factory is `payable` and takes the service fee inside
 * `createToken`, forwarding it to the fee recipient in the same call. There is no
 * separate payment step, so a failure cannot leave a fee paid with no token.
 *
 * The token address is taken exclusively from the `TokenCreated` event in the
 * mined receipt, then re-read from the chain. The UI never invents an address, a
 * hash, or a success state.
 */
export function CreatorForm() {
  const config = useAppConfig();

  const [name, setName] = useState("My Token");
  const [symbol, setSymbol] = useState("MTK");
  const [supply, setSupply] = useState("1000000");
  const [decimals, setDecimals] = useState("18");
  const [logo, setLogo] = useState<string>();
  const [stage, setStage] = useState<Stage>("idle");
  const [error, setError] = useState("");
  const [dbWarning, setDbWarning] = useState("");
  const [darkMode, setDarkMode] = useState(false);
  const [deploymentHash, setDeploymentHash] = useState<`0x${string}`>();
  const [tokenAddress, setTokenAddress] = useState("");
  const [onChain, setOnChain] = useState<OnChainToken | null>(null);
  /**
   * The record id is held in a ref, not state.
   *
   * It is read seconds later — from an effect that fires when a transaction
   * mines — and it decides POST versus PATCH. As state it was captured by
   * whichever render created the callback, so a write could run against a stale
   * "no id yet" and take the create path with a partial payload. A ref is always
   * current.
   */
  const recordIdRef = useRef("");
  const [injectedAvailable, setInjectedAvailable] = useState(false);
  const [factoryCodeOk, setFactoryCodeOk] = useState<boolean | null>(null);
  const [copied, setCopied] = useState("");
  /** Which optional features the user has chosen to pay for. */
  const [features, setFeatures] = useState<Record<TokenFeatureKey, boolean>>({
    burnable: false,
    mintable: false,
    pausable: false,
  });

  const { address, isConnected, connector } = useAccount();
  const chainId = useChainId();
  const { connect, connectors, isPending: connecting } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChainAsync, isPending: switching } = useSwitchChain();
  // Balance is read on the *target* chain so "you have 0 ETH on Base Sepolia"
  // is accurate even while the wallet is still pointed at another network.
  const { data: balance } = useBalance({ address, chainId: config.chainId });
  const publicClient = usePublicClient({ chainId: config.chainId });
  const { writeContractAsync } = useWriteContract();
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

  /**
   * Which factory will receive the call.
   *
   * Burnable is the split point: it is the only feature that needs no creator
   * power, so the two factories divide exactly on it (see
   * contracts/TokenFactoryV2.sol). The user never picks a factory — the feature
   * selection decides it.
   */
  const factoryKind = factoryKindFor(features);
  const activeFactoryAddress =
    factoryKind === "burnable" ? config.factoryBurnableAddress : config.factoryCoreAddress;

  /**
   * The price, read from the very contract that will charge it.
   *
   * Deliberately the chain's number rather than a locally recomputed one: the
   * figure on screen and the amount the transaction must send have to agree
   * exactly, and displaying what the chain reports is the only way to guarantee
   * that. The environment values are the fallback for when no factory is
   * configured yet — a state in which nothing can be created anyway.
   */
  const { data: onChainFee } = useReadContract({
    address: (activeFactoryAddress || undefined) as Address | undefined,
    abi: tokenFactoryAbi,
    functionName: "feeFor",
    args: [features.burnable, features.mintable, features.pausable],
    chainId: config.chainId,
    query: { enabled: Boolean(activeFactoryAddress) },
  });

  /**
   * The per-feature prices, for the "+0.000001 ETH" label beside each checkbox.
   *
   * Read from the same contract that will charge them, so that label is the
   * contract's own number rather than a copy of an environment value that may
   * have drifted from what was actually deployed.
   */
  const { data: feeParts } = useReadContracts({
    contracts: [
      { address: activeFactoryAddress as Address, abi: tokenFactoryAbi, functionName: "baseFee" },
      { address: activeFactoryAddress as Address, abi: tokenFactoryAbi, functionName: "burnFee" },
      { address: activeFactoryAddress as Address, abi: tokenFactoryAbi, functionName: "mintFee" },
      { address: activeFactoryAddress as Address, abi: tokenFactoryAbi, functionName: "pauseFee" },
    ],
    query: { enabled: Boolean(activeFactoryAddress) },
  });

  /**
   * Position of each feature's price in the batch above. `baseFee` sits at 0 and
   * is not tied to a checkbox, hence the offset.
   */
  const featureFeeEth = (key: TokenFeatureKey): string => {
    const index = key === "burnable" ? 1 : key === "mintable" ? 2 : 3;
    const fromChain = feeParts?.[index]?.result;
    if (typeof fromChain === "bigint") return formatEther(fromChain);
    return config.featureFees[key];
  };

  const feeWei = useMemo(() => {
    if (typeof onChainFee === "bigint") return onChainFee;
    return (
      feeToWei(config.featureFees.base) +
      (features.burnable ? feeToWei(config.featureFees.burnable) : 0n) +
      (features.mintable ? feeToWei(config.featureFees.mintable) : 0n) +
      (features.pausable ? feeToWei(config.featureFees.pausable) : 0n)
    );
  }, [onChainFee, config.featureFees, features]);

  /** The figure shown to the user. Network gas is never folded into it. */
  const feeEth = useMemo(() => formatEther(feeWei), [feeWei]);
  const priceFromChain = typeof onChainFee === "bigint";
  const requiresPayment = feeWei > 0n;

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
        factoryAddress: activeFactoryAddress,
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
      activeFactoryAddress,
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

  /** The selected factory's address is configured but has no bytecode on this chain. */
  const factoryCodeMissing = Boolean(activeFactoryAddress) && factoryCodeOk === false;

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
    const storedDeployment = localStorage.getItem("tokenbase.deploymentHash");
    const storedRecord = localStorage.getItem("tokenbase.recordId");

    if (isTxHash(storedDeployment)) {
      setDeploymentHash(storedDeployment);
      setStage("deploying");
    }
    if (isRecordId(storedRecord)) recordIdRef.current = storedRecord;
    // The previous two-transaction flow stored a payment hash here. It no longer
    // describes anything — the fee travels with the creation now — so it is
    // removed rather than left behind as a key nothing reads.
    localStorage.removeItem("tokenbase.paymentHash");
  }, []);

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

    if (!publicClient || !activeFactoryAddress) return;

    publicClient
      .getBytecode({ address: activeFactoryAddress })
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
  }, [publicClient, activeFactoryAddress]);

  // ---------------------------------------------------------------------------
  // Database mirror (never authoritative — the chain is)
  // ---------------------------------------------------------------------------

  /**
   * The full creation context for the attempt in progress.
   *
   * Status updates happen seconds after the parameters were typed, and by then
   * the record may still not exist — the very first write can have failed while
   * the chain went on to succeed. Holding the context here means such a write can
   * still send a complete payload instead of a partial insert. See
   * lib/record-write.ts for the failure this prevents.
   */
  const creationContext = useRef<CreationContext | null>(null);

  const writer = useCallback(
    async (update: RecordUpdate, options: { createIfMissing?: boolean } = {}) => {
      const { createIfMissing = true } = options;
      const context = creationContext.current;

      if (!context) return;
      if (!createIfMissing && !isRecordId(recordIdRef.current)) {
        // A failure with nothing recorded yet would mean inventing a record for
        // an attempt that never reached the chain. There is nothing to annotate.
        return;
      }

      // A POST must never be attempted with an incomplete context: that is
      // exactly what produced "wallet_address must be a valid EVM address".
      const problems = checkCreationContext(context);
      if (problems.length) {
        setDbWarning(
          `On-chain result stands, but the history record was not saved: ${problems.join(" ")}`,
        );
        return;
      }

      const send = async (method: "POST" | "PATCH", url: string, payload: Record<string, unknown>) => {
        const response = await fetch(url, {
          method,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const body = (await response.json().catch(() => ({}))) as {
          error?: string;
          record?: { id?: string };
        };
        return { response, body };
      };

      try {
        let plan = planRecordWrite({ recordId: recordIdRef.current, context, update });
        let result = await send(plan.method, plan.url, plan.body);

        // The record can be gone while the attempt is in flight: cleared data, a
        // different browser, an expired id. Retrying as a complete create beats
        // patching something that is not there.
        if (!result.response.ok && shouldRecreateAsPost(result.response.status, plan.method)) {
          recordIdRef.current = "";
          plan = planRecordWrite({ recordId: "", context, update });
          result = await send(plan.method, plan.url, plan.body);
        }

        if (!result.response.ok) throw new Error(result.body.error || "Database error");

        const id = result.body.record?.id;
        if (isRecordId(id) && recordIdRef.current !== id) {
          recordIdRef.current = id;
          localStorage.setItem("tokenbase.recordId", id);
        }
        setDbWarning("");
      } catch (cause) {
        // The chain result remains authoritative; only the mirror failed.
        setDbWarning(
          cause instanceof Error
            ? `On-chain result stands, but the history record was not saved: ${cause.message}`
            : "The history record could not be saved. The on-chain result is unaffected.",
        );
      }
    },
    [],
  );

  // ---------------------------------------------------------------------------
  // Transaction lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Token address, read from the factory event in the mined receipt.
   *
   * Both factory addresses are accepted, because the creation may have been
   * routed to either one, and both event shapes are tried: the current factory's
   * TokenCreated carries the three feature flags while the original one does not.
   * Their signatures differ, so at most one ABI decodes any given log.
   */
  const createdTokenAddress = useMemo(() => {
    const logs = deployment.data?.logs;
    if (!logs) return undefined;

    const factories = [config.factoryCoreAddress, config.factoryBurnableAddress]
      .filter(Boolean)
      .map(value => value.toLowerCase());

    for (const log of logs) {
      if (!factories.includes(log.address.toLowerCase())) continue;
      for (const abi of factoryEventAbis) {
        try {
          const decoded = decodeEventLog({
            abi,
            eventName: "TokenCreated",
            data: log.data,
            topics: log.topics,
          });
          const token = (decoded.args as { token?: unknown }).token;
          if (typeof token === "string" && isAddress(token)) return token;
        } catch {
          // Not this shape — try the next one, then the next log.
        }
      }
    }
    return undefined;
  }, [deployment.data, config.factoryCoreAddress, config.factoryBurnableAddress]);

  useEffect(() => {
    if (!deployment.isSuccess || stage !== "deploying") return;

    if (createdTokenAddress) {
      setTokenAddress(createdTokenAddress);
      setStage("success");

      if (isTxHash(deploymentHash)) {
        // The token address came from the TokenCreated event in the mined
        // receipt. The server re-checks both the receipt and the address against
        // the chain before it will store this as a successful record.
        void writer(
          successWrite({ tokenAddress: createdTokenAddress, transactionHash: deploymentHash }),
        );
        localStorage.removeItem("tokenbase.deploymentHash");
        localStorage.removeItem("tokenbase.paymentHash");
      } else {
        setDbWarning(
          "The token exists on chain, but this browser no longer holds the deployment transaction hash, so the history record cannot name it. The token itself is unaffected.",
        );
      }
      return;
    }

    // Mined, but no TokenCreated event. Never claim success.
    const failure = creationFailureState();
    setStage(failure.stage);
    const reason =
      "The transaction was mined, but its receipt contains no TokenCreated event, so no token address can be confirmed. Open it on BaseScan and inspect the logs before retrying.";
    setError(reason);
    void writer(failureWrite({ status: "failed", reason }), { createIfMissing: false });
  }, [
    deployment.isSuccess,
    createdTokenAddress,
    deploymentHash,
    writer,
    stage,
  ]);

  useEffect(() => {
    if (!deployment.isError || stage !== "deploying") return;
    const failure = creationFailureState();
    setStage(failure.stage);
    setError(failure.message);
    // The fee and the token are produced by the same transaction, so a failure
    // here means neither happened — `deployment_cancelled` says exactly that,
    // unlike the old flow where a spent fee made it a `failed`.
    void writer(
      failureWrite({
        status: "deployment_cancelled",
        reason: failure.message,
      }),
      { createIfMissing: false },
    );
  }, [deployment.isError, stage, writer]);

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

  const deploy = async () => {
    setError("");
    if (!address || !activeFactoryAddress || !validation.ok) return;

    const { name: tokenName, symbol: tokenSymbol, decimals: tokenDecimals, supply: tokenSupply, rawSupply } =
      validation.value;

    try {
      setStage("deploying");

      /**
       * Hold the full creation context. A later write — including one that has to
       * create the record for the first time, because this one failed — can then
       * send a complete payload rather than a partial insert.
       */
      creationContext.current = {
        walletAddress: address,
        network: config.chainName,
        tokenName,
        tokenSymbol,
        totalSupply: tokenSupply,
        decimals: tokenDecimals,
        logoUrl: logo || null,
        burnable: features.burnable,
        mintable: features.mintable,
        pausable: features.pausable,
      };

      // Mirror the attempt into PostgreSQL. A failure here is a warning only.
      // There is no separate payment transaction any more, so no payment hash.
      await writer({ status: "deploying", payment_tx_hash: null });

      /**
       * One transaction: the service fee rides along as `msg.value` and the
       * factory forwards it to the fee recipient inside the same call. The amount
       * is the figure already on screen, read from `feeFor()` on this very
       * contract, so the two cannot disagree without reverting with `WrongFee`.
       */
      const hash = await writeContractAsync({
        address: activeFactoryAddress,
        abi: tokenFactoryAbi,
        functionName: "createToken",
        args: [
          tokenName,
          tokenSymbol,
          tokenDecimals,
          rawSupply,
          features.burnable,
          features.mintable,
          features.pausable,
        ],
        value: feeWei,
        chainId: config.chainId,
      });

      setDeploymentHash(hash);
      localStorage.setItem("tokenbase.deploymentHash", hash);
    } catch (cause) {
      const failure = creationFailureState();
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
        {!activeFactoryAddress && (
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
                  ? "Your selected features are charged as the service fee, sent together with the deployment in a single wallet transaction."
                  : "No optional features are selected and the base price is zero, so there is no service fee — you pay network gas only."}
              </p>
            </div>
          </div>
          <div className="mini-row">
            <span className="muted">Service Fee</span>
            <strong>{feeSummary(feeEth)}</strong>
          </div>
          <div className="mini-row">
            <span className="muted">Network Gas</span>
            <strong>+ Gas</strong>
          </div>
          <div className="mini-row">
            <span className="muted">Total</span>
            <strong>{feeSummary(feeEth)} + Gas</strong>
          </div>
          <div className="mini-row">
            <span className="muted">Transactions you will sign</span>
            <strong>1 (creation and fee together)</strong>
          </div>
          <div className="mini-row">
            <span className="muted">Where this price comes from</span>
            <span className="mono">
              {priceFromChain ? "the factory contract (feeFor)" : "environment configuration"}
            </span>
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
              <p>
                Optional. Each feature is deployed as its own contract, so anything you leave
                unselected genuinely does not exist in your token — anyone can confirm that on
                BaseScan. The base token is fixed supply with no owner and no backdoor.
              </p>
            </div>
          </div>
          <div className="property-grid">
            {TOKEN_FEATURES.map(feature => {
              const isSelected = features[feature.key];
              return (
                <label
                  className={`property-card${isSelected ? " is-selected" : ""}`}
                  key={feature.key}
                  style={{ cursor: "pointer" }}
                >
                  <div className="property-top">
                    <span className="property-name">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={event =>
                          setFeatures(previous => ({
                            ...previous,
                            [feature.key]: event.target.checked,
                          }))
                        }
                      />{" "}
                      {feature.label}
                    </span>
                    <span className="property-price">+{featureFeeEth(feature.key)} ETH</span>
                  </div>
                  <p>{feature.blurb}</p>
                </label>
              );
            })}
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
                Connect your wallet and create your token in one signed transaction. The service fee
                for the features you selected is included in it.
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
              <span className="mono">{activeFactoryAddress}</span> on {config.chainName}. Check the
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
                Service Fee: <strong>{feeSummary(feeEth)}</strong> · Network Gas:{" "}
                <strong>+ Gas</strong>
              </div>
            </>
          )}
        </div>
      </section>

      <div className="footer-note">
        Your wallet signs every transaction. No private keys and no seed phrases are ever requested by
        this app. The service fee for the features you select is charged inside the same transaction
        that creates the token, and network gas is always separate from it.
      </div>
    </main>
  );
}
