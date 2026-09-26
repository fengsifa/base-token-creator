"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

type CreationRecord = {
  id: string;
  wallet_address: string;
  network: string;
  token_name: string;
  token_symbol: string;
  total_supply: string;
  decimals: number;
  token_contract_address: string | null;
  transaction_hash: string | null;
  payment_tx_hash: string | null;
  status: string;
  /**
   * The optional features the token was deployed with.
   *
   * Shown, never used: this dashboard cannot mint, burn, pause or unpause
   * anything, and these flags are not what grants or withholds those powers. The
   * deployed contract's `creator` is the only address that holds them.
   */
  burnable: boolean;
  mintable: boolean;
  pausable: boolean;
  chain_verified: boolean;
  verified_at: string | null;
  verification_note: string | null;
  created_at: string;
};

/** A feature flag as the tick or cross an operator scans for. */
function featureMark(on: boolean): string {
  return on ? "✓" : "✗";
}

type WalletRow = {
  wallet_address: string;
  token_count: number;
  last_created_at: string;
};

const STATUSES = [
  "success",
  "deploying",
  "payment_confirmed",
  "pending_payment",
  "failed",
  "payment_cancelled",
  "deployment_cancelled",
];

/** BaseScan for the network the record names, so a link is right by construction. */
function explorerFor(network: string): string {
  return /sepolia/i.test(network) ? "https://sepolia.basescan.org" : "https://basescan.org";
}

function short(value: string | null | undefined, lead = 10, tail = 8): string {
  if (!value) return "—";
  if (value.length <= lead + tail + 1) return value;
  return `${value.slice(0, lead)}…${value.slice(-tail)}`;
}

function fmtDate(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}

export default function AdminRecordsPage() {
  const [secret, setSecret] = useState("");
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  // Filters. Kept separate from the applied query so typing does not fire a
  // request per keystroke.
  const [walletInput, setWalletInput] = useState("");
  const [contractInput, setContractInput] = useState("");
  const [textInput, setTextInput] = useState("");
  const [statusInput, setStatusInput] = useState("");

  const [records, setRecords] = useState<CreationRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [wallets, setWallets] = useState<WalletRow[]>([]);
  const [groupWallet, setGroupWallet] = useState("");
  const [selected, setSelected] = useState<CreationRecord | null>(null);
  const [copied, setCopied] = useState("");

  useEffect(() => {
    let cancelled = false;
    fetch("/api/admin/session")
      .then(response => response.json())
      .then((body: { authenticated?: boolean }) => {
        if (!cancelled) setAuthenticated(Boolean(body.authenticated));
      })
      .catch(() => {
        if (!cancelled) setAuthenticated(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const load = useCallback(
    async (filters: { wallet?: string; contract?: string; q?: string; status?: string }) => {
      setBusy(true);
      try {
        const params = new URLSearchParams();
        if (filters.wallet) params.set("wallet", filters.wallet);
        if (filters.contract) params.set("contract", filters.contract);
        if (filters.q) params.set("q", filters.q);
        if (filters.status) params.set("status", filters.status);
        params.set("wallets", "1");

        const response = await fetch(`/api/admin/records?${params.toString()}`);
        const body = (await response.json().catch(() => ({}))) as {
          error?: string;
          records?: CreationRecord[];
          total?: number;
          wallets?: WalletRow[];
        };
        if (!response.ok) throw new Error(body.error || "Unable to load records.");
        setRecords(body.records ?? []);
        setTotal(body.total ?? 0);
        setWallets(body.wallets ?? []);
        setMessage("");
      } catch (cause) {
        setMessage(cause instanceof Error ? cause.message : "Unable to load records.");
        setRecords([]);
        setTotal(0);
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const signIn = async () => {
    setBusy(true);
    try {
      const login = await fetch("/api/admin/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ secret }),
      });
      if (!login.ok) {
        setMessage("Invalid admin credentials.");
        return;
      }
      setAuthenticated(true);
      setSecret("");
      await load({});
    } finally {
      setBusy(false);
    }
  };

  const signOut = async () => {
    await fetch("/api/admin/session", { method: "DELETE" });
    setAuthenticated(false);
    setRecords([]);
    setWallets([]);
    setSelected(null);
    setMessage("You are signed out.");
  };

  const search = () => {
    setGroupWallet("");
    setSelected(null);
    void load({
      wallet: walletInput.trim(),
      contract: contractInput.trim(),
      q: textInput.trim(),
      status: statusInput,
    });
  };

  const clear = () => {
    setWalletInput("");
    setContractInput("");
    setTextInput("");
    setStatusInput("");
    setGroupWallet("");
    setSelected(null);
    void load({});
  };

  const groupByWallet = (wallet: string) => {
    setWalletInput(wallet);
    setGroupWallet(wallet);
    setSelected(null);
    void load({ wallet });
  };

  const copy = async (value: string, key: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(key);
      window.setTimeout(() => setCopied(""), 1600);
    } catch {
      setMessage("Clipboard access was blocked. Select the value and copy it manually.");
    }
  };

  /** The wallet → tokens tree for one wallet. */
  const grouped = useMemo(() => {
    if (!groupWallet) return null;
    const forWallet = records.filter(
      row => row.wallet_address.toLowerCase() === groupWallet.toLowerCase(),
    );
    return { wallet: groupWallet, rows: forWallet };
  }, [groupWallet, records]);

  if (authenticated === null) {
    return (
      <main className="shell">
        <nav className="nav">
          <Link href="/" className="brand">
            <span className="mark">T</span> Tokenbase
          </Link>
          <span className="eyebrow">Admin only</span>
        </nav>
        <section className="panel" style={{ maxWidth: 520, margin: "0 auto" }}>
          <div className="eyebrow">Private area</div>
          <h2>Token records</h2>
          <p className="muted">Checking your session…</p>
        </section>
      </main>
    );
  }

  if (!authenticated) {
    return (
      <main className="shell">
        <nav className="nav">
          <Link href="/" className="brand">
            <span className="mark">T</span> Tokenbase
          </Link>
          <span className="eyebrow">Admin only</span>
        </nav>
        <section className="panel" style={{ maxWidth: 520, margin: "0 auto" }}>
          <div className="eyebrow">Private area</div>
          <h2>Admin sign-in</h2>
          <p>
            Token creation records name the wallets of the people who created them, so this page is
            for the administrator only. Creator users never need an account.
          </p>
          <form
            className="actions"
            autoComplete="off"
            onSubmit={event => {
              event.preventDefault();
              void signIn();
            }}
          >
            <input
              type="text"
              placeholder="ADMIN_SECRET"
              value={secret}
              onChange={event => setSecret(event.target.value)}
              autoComplete="off"
              name="admin-secret"
              spellCheck={false}
              style={{ WebkitTextSecurity: "disc" }}
            />
            <button className="button" disabled={busy}>
              {busy ? "Signing in…" : "Sign in"}
            </button>
          </form>
          {message && <div className="notice warning">{message}</div>}
          <p className="helper" style={{ paddingLeft: 0 }}>
            The same session is used by the rest of <span className="mono">/admin</span>.
          </p>
        </section>
      </main>
    );
  }

  return (
    <main className="shell">
      <nav className="nav">
        <Link href="/" className="brand">
          <span className="mark">T</span> Tokenbase
        </Link>
        <span className="eyebrow">Admin only</span>
      </nav>

      <section className="panel">
        <div className="actions" style={{ justifyContent: "space-between", marginTop: 0 }}>
          <div>
            <div className="eyebrow">Creation history</div>
            <h2>Token Records</h2>
          </div>
          <div className="actions" style={{ margin: 0 }}>
            <Link href="/admin" className="button secondary">
              Dashboard
            </Link>
            <button className="button secondary" onClick={() => void signOut()}>
              Sign out
            </button>
          </div>
        </div>
        <p className="muted">
          Every row is a token creation attempt. The chain is the source of truth; this table is the
          mirror. <span className="mono">Chain verified</span> means the server confirmed over RPC
          that the transaction succeeded and created that exact token address.
        </p>
      </section>

      <section className="panel">
        <div className="eyebrow">Search</div>
        <div className="form-grid">
          <div className="field">
            <label className="field-label" htmlFor="wallet">
              Wallet address
            </label>
            <input
              id="wallet"
              value={walletInput}
              placeholder="0x… (exact match)"
              onChange={event => setWalletInput(event.target.value)}
              onKeyDown={event => {
                if (event.key === "Enter") search();
              }}
              spellCheck={false}
            />
          </div>
          <div className="field">
            <label className="field-label" htmlFor="contract">
              Token contract address
            </label>
            <input
              id="contract"
              value={contractInput}
              placeholder="0x… (exact match)"
              onChange={event => setContractInput(event.target.value)}
              onKeyDown={event => {
                if (event.key === "Enter") search();
              }}
              spellCheck={false}
            />
          </div>
          <div className="field">
            <label className="field-label" htmlFor="q">
              Token name or symbol
            </label>
            <input
              id="q"
              value={textInput}
              placeholder="MTK, My Token…"
              onChange={event => setTextInput(event.target.value)}
              onKeyDown={event => {
                if (event.key === "Enter") search();
              }}
            />
          </div>
          <div className="field">
            <label className="field-label" htmlFor="status">
              Status
            </label>
            <select
              id="status"
              value={statusInput}
              onChange={event => setStatusInput(event.target.value)}
            >
              <option value="">All statuses</option>
              {STATUSES.map(status => (
                <option key={status} value={status}>
                  {status}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="actions">
          <button className="button" disabled={busy} onClick={search}>
            {busy ? "Searching…" : "Search"}
          </button>
          <button className="button secondary" disabled={busy} onClick={clear}>
            Clear
          </button>
        </div>
        {message && <div className="notice warning">{message}</div>}
      </section>

      {grouped && (
        <section className="panel">
          <div className="eyebrow">One wallet, many tokens</div>
          <div className="mini-row">
            <span className="muted">Wallet</span>
            <span className="mono">
              {grouped.wallet}{" "}
              <button className="button secondary" onClick={() => void copy(grouped.wallet, "group")}>
                {copied === "group" ? "Copied" : "Copy"}
              </button>
            </span>
          </div>
          <div className="mini-row">
            <span className="muted">Tokens created</span>
            <strong>{grouped.rows.length}</strong>
          </div>
          <pre
            className="mono"
            style={{
              background: "var(--soft-blue)",
              padding: 16,
              borderRadius: 12,
              overflowX: "auto",
              whiteSpace: "pre-wrap",
              fontSize: 12,
            }}
          >
            {grouped.rows.length
              ? grouped.rows
                  .map((row, index) => {
                    const branch = index === grouped.rows.length - 1 ? "└──" : "├──";
                    return `${branch} ${row.token_symbol}  →  ${row.token_contract_address ?? "no token address"}`;
                  })
                  .join("\n")
              : "No tokens recorded for this wallet."}
          </pre>
        </section>
      )}

      {wallets.length > 0 && !walletInput && (
        <section className="panel">
          <div className="eyebrow">Wallets with records</div>
          <p className="muted">
            Click a wallet to see every token it created.
          </p>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Wallet</th>
                  <th>Tokens created</th>
                  <th>Last created</th>
                </tr>
              </thead>
              <tbody>
                {wallets.map(row => (
                  <tr key={row.wallet_address}>
                    <td className="mono">
                      <button
                        className="button secondary"
                        onClick={() => groupByWallet(row.wallet_address)}
                        title="Show every token this wallet created"
                      >
                        {short(row.wallet_address, 12, 10)}
                      </button>
                    </td>
                    <td>{row.token_count}</td>
                    <td>{fmtDate(row.last_created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="panel">
        <div className="actions" style={{ justifyContent: "space-between" }}>
          <div className="eyebrow">
            {total} record{total === 1 ? "" : "s"}
          </div>
        </div>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Wallet address</th>
                <th>Token name</th>
                <th>Symbol</th>
                <th>Token contract address</th>
                <th>Network</th>
                <th>Total supply</th>
                <th title="Burnable · Mintable · Pausable">Features</th>
                <th>Transaction hash</th>
                <th>Created at</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {records.map(row => (
                <tr key={row.id}>
                  <td className="mono">
                    <span title={row.wallet_address}>{short(row.wallet_address)}</span>{" "}
                    <button
                      className="icon-button"
                      title="Copy wallet address"
                      onClick={() => void copy(row.wallet_address, `w-${row.id}`)}
                    >
                      {copied === `w-${row.id}` ? "✓" : "⧉"}
                    </button>
                  </td>
                  <td>
                    <button
                      className="button secondary"
                      onClick={() => setSelected(row)}
                      title="Show the full record"
                    >
                      {row.token_name}
                    </button>
                  </td>
                  <td>{row.token_symbol}</td>
                  <td className="mono">
                    {row.token_contract_address ? (
                      <>
                        <span title={row.token_contract_address}>
                          {short(row.token_contract_address)}
                        </span>{" "}
                        <button
                          className="icon-button"
                          title="Copy token contract address"
                          onClick={() =>
                            void copy(row.token_contract_address as string, `c-${row.id}`)
                          }
                        >
                          {copied === `c-${row.id}` ? "✓" : "⧉"}
                        </button>
                      </>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td>{row.network}</td>
                  <td>
                    {row.total_supply}
                    <span className="muted"> · {row.decimals} dp</span>
                  </td>
                  <td className="mono" title="Burnable · Mintable · Pausable">
                    {featureMark(row.burnable)} {featureMark(row.mintable)}{" "}
                    {featureMark(row.pausable)}
                  </td>
                  <td className="mono">
                    {row.transaction_hash ? (
                      <a
                        href={`${explorerFor(row.network)}/tx/${row.transaction_hash}`}
                        target="_blank"
                        rel="noreferrer"
                        title={row.transaction_hash}
                      >
                        {short(row.transaction_hash)}
                      </a>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td>{fmtDate(row.created_at)}</td>
                  <td>
                    {row.status}
                    {row.status === "success" && (
                      <span className="muted"> · {row.chain_verified ? "verified" : "unverified"}</span>
                    )}
                  </td>
                </tr>
              ))}
              {records.length === 0 && (
                <tr>
                  <td colSpan={10} className="muted">
                    No records match this search.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {selected && (
        <section className="panel">
          <div className="actions" style={{ justifyContent: "space-between" }}>
            <div>
              <div className="eyebrow">Full record</div>
              <h2>
                {selected.token_name} ({selected.token_symbol})
              </h2>
            </div>
            <button className="button secondary" onClick={() => setSelected(null)}>
              Close
            </button>
          </div>

          <div className="mini-row">
            <span className="muted">Record id</span>
            <span className="mono">{selected.id}</span>
          </div>
          <div className="mini-row">
            <span className="muted">Creator wallet</span>
            <span className="mono">
              {selected.wallet_address}{" "}
              <button
                className="button secondary"
                onClick={() => void copy(selected.wallet_address, "d-w")}
              >
                {copied === "d-w" ? "Copied" : "Copy"}
              </button>
            </span>
          </div>
          <div className="mini-row">
            <span className="muted">Token contract</span>
            <span className="mono">
              {selected.token_contract_address ?? "—"}{" "}
              {selected.token_contract_address && (
                <button
                  className="button secondary"
                  onClick={() =>
                    void copy(selected.token_contract_address as string, "d-c")
                  }
                >
                  {copied === "d-c" ? "Copied" : "Copy"}
                </button>
              )}
            </span>
          </div>
          <div className="mini-row">
            <span className="muted">Transaction hash</span>
            <span className="mono">
              {selected.transaction_hash ? (
                <a
                  href={`${explorerFor(selected.network)}/tx/${selected.transaction_hash}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {selected.transaction_hash}
                </a>
              ) : (
                "—"
              )}
            </span>
          </div>
          <div className="mini-row">
            <span className="muted">Network</span>
            <strong>{selected.network}</strong>
          </div>
          <div className="mini-row">
            <span className="muted">Total supply / decimals</span>
            <strong>
              {selected.total_supply} · {selected.decimals}
            </strong>
          </div>
          <div className="mini-row">
            <span className="muted">Burnable</span>
            <strong>{featureMark(selected.burnable)}</strong>
          </div>
          <div className="mini-row">
            <span className="muted">Mintable</span>
            <strong>{featureMark(selected.mintable)}</strong>
          </div>
          <div className="mini-row">
            <span className="muted">Pausable</span>
            <strong>{featureMark(selected.pausable)}</strong>
          </div>
          <div className="mini-row">
            <span className="muted">Status</span>
            <strong>{selected.status}</strong>
          </div>
          <div className="mini-row">
            <span className="muted">Chain verified</span>
            <strong>
              {selected.chain_verified ? `yes · ${fmtDate(selected.verified_at)}` : "no"}
            </strong>
          </div>
          {selected.verification_note && (
            <div className="helper" style={{ paddingLeft: 0 }}>
              {selected.verification_note}
            </div>
          )}
          <div className="mini-row">
            <span className="muted">Created at</span>
            <strong>{fmtDate(selected.created_at)}</strong>
          </div>

          <div className="actions">
            {selected.wallet_address && (
              <button
                className="button"
                onClick={() => groupByWallet(selected.wallet_address)}
              >
                All tokens from this wallet
              </button>
            )}
            {selected.transaction_hash && (
              <a
                className="button secondary"
                href={`${explorerFor(selected.network)}/tx/${selected.transaction_hash}`}
                target="_blank"
                rel="noreferrer"
              >
                View transaction on BaseScan
              </a>
            )}
            {selected.token_contract_address && (
              <a
                className="button secondary"
                href={`${explorerFor(selected.network)}/address/${selected.token_contract_address}`}
                target="_blank"
                rel="noreferrer"
              >
                View token contract
              </a>
            )}
          </div>
        </section>
      )}

      <div className="footer-note">
        Records are a mirror of on-chain activity. When the two disagree, the chain wins — open the
        transaction and check.
      </div>
    </main>
  );
}
