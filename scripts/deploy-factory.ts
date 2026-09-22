/**
 * Deploy TokenFactory with Hardhat.
 *
 * This is the CLI alternative to the in-browser deployment at /setup. It needs a
 * funded private key in .env.local (DEPLOYER_PRIVATE_KEY). The browser route
 * needs no key at all and is the recommended path — use this one only if you
 * prefer a terminal.
 *
 * Never commit a private key. `.env.local` is git-ignored.
 *
 *   node_modules/.bin/hardhat run scripts/deploy-factory.ts --network baseSepolia
 */
import { ethers } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();

  if (!deployer) {
    console.error(
      "No signer available. Set DEPLOYER_PRIVATE_KEY in .env.local before running against a live network.",
    );
    process.exitCode = 1;
    return;
  }

  const network = await ethers.provider.getNetwork();
  const chainId = network.chainId;
  const balance = await ethers.provider.getBalance(deployer.address);

  console.log(`Network          : ${network.name} (chain id ${chainId})`);
  console.log(`Deployer         : ${deployer.address}`);
  console.log(`Deployer balance : ${ethers.formatEther(balance)} ETH`);

  // Guardrail: never touch Base mainnet by accident.
  if (chainId === 8453n && process.env.CONFIRM_MAINNET !== "yes") {
    console.error(
      "Refusing to deploy to Base mainnet. Re-run with CONFIRM_MAINNET=yes if that is really intended.",
    );
    process.exitCode = 1;
    return;
  }

  if (balance === 0n) {
    console.error("The deployer has no ETH on this network, so it cannot pay for the deployment.");
    process.exitCode = 1;
    return;
  }

  console.log("\nDeploying TokenFactory...");
  const factory = await ethers.deployContract("TokenFactory");
  const deploymentTx = factory.deploymentTransaction();

  console.log(`Transaction      : ${deploymentTx?.hash ?? "(unknown)"}`);
  await factory.waitForDeployment();

  const address = await factory.getAddress();
  const code = await ethers.provider.getCode(address);
  if (code === "0x") {
    console.error("Deployment reported success but no bytecode exists at the address.");
    process.exitCode = 1;
    return;
  }

  const explorer = chainId === 8453n ? "https://basescan.org" : "https://sepolia.basescan.org";
  const suffix = chainId === 8453n ? "MAINNET" : "SEPOLIA";

  console.log("\nTokenFactory deployed.");
  console.log(`Address          : ${address}`);
  console.log(`Explorer         : ${explorer}/address/${address}`);
  console.log(`Bytecode size    : ${(code.length - 2) / 2} bytes`);
  console.log("\nPaste this into the app environment file and restart the app container:");
  console.log(`NEXT_PUBLIC_TOKEN_CONTRACT_FACTORY_${suffix}=${address}`);
  console.log(`NEXT_PUBLIC_TOKEN_CREATOR_FEE_${suffix}=0`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
