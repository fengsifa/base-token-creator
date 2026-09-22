import type { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-ethers";
import "@nomicfoundation/hardhat-chai-matchers";
import * as dotenv from "dotenv";

// `.env.local` is git-ignored and is the only place secrets belong.
// Loading it first means a developer's local override wins.
dotenv.config({ path: ".env.local" });
dotenv.config();

/**
 * Never hardcode a private key here and never commit one.
 * When DEPLOYER_PRIVATE_KEY is absent the Base networks still work for
 * read-only calls, they simply have no signer — which is the desired default.
 */
const deployerKey = process.env.DEPLOYER_PRIVATE_KEY?.trim();
const accounts = deployerKey ? [deployerKey] : [];

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      // "paris" keeps the bytecode free of PUSH0 so it is accepted by every
      // chain and RPC the frontend might talk to. Cost difference is negligible.
      evmVersion: "paris",
    },
  },
  paths: {
    sources: "./contracts",
    tests: "./test/contract",
    cache: "./cache",
    artifacts: "./artifacts",
  },
  networks: {
    hardhat: {
      chainId: 31337,
      // Mirrors Base Sepolia's op-stack behaviour closely enough for unit tests.
      allowUnlimitedContractSize: false,
    },
    localhost: {
      url: "http://127.0.0.1:8545",
      chainId: 31337,
    },
    baseSepolia: {
      url: process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org",
      chainId: 84532,
      accounts,
    },
    base: {
      url: process.env.BASE_MAINNET_RPC_URL || "https://mainnet.base.org",
      chainId: 8453,
      accounts,
    },
  },
  mocha: {
    timeout: 120_000,
  },
};

export default config;
