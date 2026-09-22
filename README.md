# Tokenbase

A non-custodial ERC-20 Token Creator for Base. Your wallet signs the deployment
transaction; no private key or seed phrase ever reaches the application.

Target for this iteration: **Base Sepolia MVP**, chain id `84532`.

---

## What actually works

| Capability | Status |
| --- | --- |
| Connect MetaMask / injected wallet | Working |
| Detect the network and prompt to switch to Base Sepolia | Working |
| Name / Symbol / Supply / Decimals inputs with real validation | Working |
| Create ERC-20 through the Token Factory | Working, real transaction |
| Show the real token address, decoded from the `TokenCreated` event | Working |
| Re-read name/symbol/decimals/totalSupply/balanceOf from the chain | Working |
| Basescan links for the token and the transaction | Working |
| Admin dashboard over the PostgreSQL record mirror | Working |
| One-click Factory deployment from the browser (`/setup`) | Working |

Not implemented by the contract, and labelled as such in the UI: burnable,
mintable, pausable, anti-whale, anti-bot, blacklist, transaction fee, reflection,
deflation. Tokens are plain fixed-supply ERC-20s with no owner and no backdoor.

---

## Architecture

```
app/
  page.tsx                 landing page (server component)
  creator/page.tsx         token creation flow
  setup/page.tsx           one-time Factory deployment
  admin/page.tsx           admin dashboard
  layout.tsx               resolves the runtime config, mounts the providers
  api/creations/...        creation-record mirror (PostgreSQL)
  api/uploads/...          optional logo upload
  api/admin/...            admin session + data
components/
  creator-form.tsx         the creation flow (client)
  factory-setup.tsx        browser Factory deployment (client)
  logo-upload.tsx
contracts/
  TokenFactory.sol         CreatedToken + TokenFactory
lib/
  validation.ts            parameter validation and unit conversion (pure)
  creator-state.ts         UI state derivation (pure)
  config.ts                environment resolution (pure)
  contracts.ts             hand-written ABI + error decoding
  tokenfactory-artifact.json  compiled ABI + bytecode (generated)
  database.ts              PostgreSQL access
test/
  unit/                    pure logic, no chain
  contract/                Hardhat tests against the in-process EVM
  integration/             viem against a local Hardhat node
scripts/
  export-artifact.mjs      copies the compiled artifact into lib/
  deploy-factory.ts        CLI Factory deployment
  run-integration-tests.mjs
  smoke-test.mjs
```

Two design decisions are worth knowing up front:

1. **The chain is the only source of truth.** The token address comes from the
   `TokenCreated` event in the mined receipt, never from a locally computed
   address, and it is then read back from the chain. If the receipt has no such
   event the UI reports a problem instead of showing a success state.
2. **Configuration is resolved on the server per request.** `NEXT_PUBLIC_*`
   values are normally inlined at build time, which would force an image rebuild
   every time the Factory address changed. `app/layout.tsx` reads them at request
   time, so a container restart is enough.

---

## Requirements

- Node.js 20 or newer
- Docker with Compose (for PostgreSQL and the app container)
- A deployed Token Factory address (see below)

## 1. Configure

```bash
cp .env.example .env.local
```

Set at least:

- `NEXT_PUBLIC_TOKEN_CONTRACT_FACTORY_SEPOLIA` — the factory address
- `DATABASE_URL` — only if you want the admin record mirror
- `ADMIN_SECRET` — only if you want the `/admin` page

Create a root `.env` for Compose as well:

```
POSTGRES_PASSWORD=replace-with-a-long-random-password
```

and point `DATABASE_URL` at the `postgres` host name, which only resolves inside
the Compose network:

```
DATABASE_URL=postgresql://token_creator:<that same password>@postgres:5432/token_creator
```

## 2. Deploy the Factory (one time)

The factory is stateless and ownerless, so deploying it is a permissionless
operation you perform from your own wallet. Two equivalent ways:

**In the browser (no key, no CLI)** — start the app, open `/setup`, connect
MetaMask on Base Sepolia, click *Deploy TokenFactory*, then copy the printed
address into `NEXT_PUBLIC_TOKEN_CONTRACT_FACTORY_SEPOLIA`.

**From the CLI** — needs a funded key in `.env.local`:

```bash
npm run contracts:build
npm run deploy:factory          # Base Sepolia
```

The same page shows the deploying wallet address, which is a sensible choice for
`NEXT_PUBLIC_TOKEN_CREATOR_FEE_RECIPIENT_SEPOLIA` if you later enable a fee.

## 3. Service fee

- `NEXT_PUBLIC_TOKEN_CREATOR_FEE_SEPOLIA=0` → **free mode**. One signed
  transaction; the user pays gas only. This is the default and needs no
  recipient address.
- Any non-zero value → **paid mode**. Two signed transactions (fee, then deploy)
  and a recipient address is mandatory. Values below `0.0001` are raised to
  `0.0001`, because a dust fee costs the user an extra transaction for nothing.

## 4. Run

```bash
npm install
npm run dev            # http://localhost:3000
```

Or with Docker:

```bash
docker compose up -d --build
```

The database migration needs to run once:

```bash
docker compose exec -T postgres psql -U token_creator -d token_creator < migrations/001_initial.sql
```

After changing `.env.local`, restart the app container — no rebuild required:

```bash
docker compose up -d app
```

---

## Verification

```bash
npm run typecheck        # TypeScript
npm run lint             # ESLint
npm run contracts:build  # compile Solidity + refresh the browser artifact
npm run test:unit        # validation, config, UI state, ABI drift  (vitest)
npm run test:contract    # contract behaviour                    (hardhat)
npm run test:integration # real EVM, real bytecode, frontend ABI  (viem)
npm run build            # production build
npm run test:smoke       # pages boot with no wallet and no database
```

`npm test` runs the unit, contract and integration suites in order.

The integration suite starts its own Hardhat node, so it needs no testnet
account and spends nothing. Nothing in this repository sends a transaction to
Base Sepolia on its own.

## Manual end-to-end check on Base Sepolia

1. Open the site and click *Connect Wallet*; approve MetaMask.
2. If MetaMask is on the wrong network, click *Switch to Base Sepolia*.
3. Confirm the wallet holds test ETH (a faucet is linked on the page).
4. Enter name, symbol, decimals and supply. The panel under the fields shows the
   exact base-unit amount that will be minted, so decimal mistakes are visible
   before signing.
5. Press *Create Token* and confirm in MetaMask. In free mode this is the only
   transaction.
6. Wait for the receipt. The page then shows the token address taken from the
   `TokenCreated` event, plus the values read back from the chain.
7. Open *View on BaseScan* and confirm the token exists with exactly the
   parameters you entered.

## Deployment notes

The app is a single Next.js container listening on `127.0.0.1:3000`, behind a
reverse proxy. PostgreSQL runs on an internal Compose network with no published
port, so it is not reachable from the internet.

For BaseScan contract verification, add the optional
`@nomicfoundation/hardhat-verify` plugin and a `BASESCAN_API_KEY`, then:

```bash
npx hardhat verify --network baseSepolia <factory address>
```

## Security notes

- No private key, mnemonic or keystore is ever requested by the UI, and none is
  committed. `DEPLOYER_PRIVATE_KEY` exists only for the optional CLI path and
  lives in the git-ignored `.env.local`.
- `/api/creations` re-validates every field with the same rules as the browser.
- Uploaded logos are restricted to raster formats; SVG is rejected because it
  would be executable content served from this origin.
- The admin secret is compared in constant time.
