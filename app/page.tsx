import Link from "next/link";
import { resolveConfig } from "../lib/config";

export const metadata = {
  title: "Tokenbase · ERC-20 Token Creator for Base",
  description: "Create a standard ERC-20 token on Base. Non-custodial, fixed supply, no backdoor.",
};

export default function Home() {
  const config = resolveConfig(process.env);
  const freeMode = config.feeEth === "0" || config.feeEth === "";
  const steps = [
    "Configure Token",
    "Connect Wallet",
    "Sign Transaction",
    "Receive Address",
    "Verify On-Chain",
  ];

  return (
    <main className="shell">
      <nav className="nav">
        <Link href="/" className="brand">
          <span className="mark">T</span> Tokenbase
        </Link>
        <Link href="/creator" className="muted">
          Create Token →
        </Link>
      </nav>

      <section className="hero">
        <div className="hero-copy">
          <div className="eyebrow">Base · Non-custodial</div>
          <h1>Create your own token.</h1>
          <p>
            Create a standard ERC-20 token on {config.chainName} in minutes. Your wallet signs the
            transaction and you keep full control.
          </p>
          <div className="actions">
            <Link href="/creator" className="button">
              Create Token
            </Link>
            <span className="notice" style={{ margin: 0 }}>
              {config.chainName} · {freeMode ? "free (gas only)" : `${config.feeEth} ETH fee`}
            </span>
          </div>
        </div>
        <div className="hero-card">
          <div className="token-orb">
            <div className="coin">T</div>
          </div>
          <div className="mini-row">
            <span className="muted">Network</span>
            <strong>{config.chainName}</strong>
          </div>
          <div className="mini-row">
            <span className="muted">Standard</span>
            <strong>ERC-20</strong>
          </div>
          <div className="mini-row">
            <span className="muted">Custody</span>
            <strong style={{ color: "var(--accent)" }}>Your wallet</strong>
          </div>
        </div>
      </section>

      <section className="steps">
        <div className="eyebrow">How it works</div>
        <h2>From idea to contract.</h2>
        <div className="step-grid">
          {steps.map((step, index) => (
            <div className="step" key={step}>
              <div className="step-num">0{index + 1}</div>
              <strong>{step}</strong>
            </div>
          ))}
        </div>
      </section>

      <div className="footer-note">
        No private keys. No seed phrases. No hidden token features.{" "}
        <Link href="/setup" className="muted">
          <u>Factory setup</u>
        </Link>
      </div>
    </main>
  );
}
