"use client";

const networks = [
  { name: "Base", available: true },
  { name: "Ethereum", available: false },
  { name: "BNB Chain", available: false },
  { name: "Polygon", available: false },
  { name: "Avalanche", available: false },
  { name: "Solana", available: false },
  { name: "TRON", available: false },
  { name: "Sui", available: false },
];

export function NetworkSelector() {
  return <div className="network-picker">
    <label htmlFor="network-select">Select blockchain</label>
    <select id="network-select" defaultValue="Base">
      {networks.map(network => <option key={network.name} value={network.name} disabled={!network.available}>{network.name}{network.available ? "" : " — Coming soon"}</option>)}
    </select>
  </div>;
}
