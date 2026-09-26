# Changelog

## 7.0.0

Burnable, Mintable and Pausable become selectable on the creation page, each with its own service fee.
The three are separate features, so this section is written around the rule that shaped the design.

### Added

- **Three optional token features, priced individually.** `Burnable`, `Mintable` and `Pausable` are
  checkboxes in the existing Token Properties panel; each adds 0.000001 ETH to the 0.000001 ETH base
  price, so all three cost 0.000004 ETH. Network gas is shown on its own line and is never folded into
  the service fee.
- **`contracts/tokens/CreatedTokens.sol`** — eight token contracts, one per feature combination, plus a
  shared `CreatedTokenBase` and a `BurnableFeature`. Why eight contracts rather than one with three
  flags: a flag-guarded feature still has its code on chain, so a token without Mintable would still
  carry `mint` and only a boolean would stand between a stranger and it. Each combination is therefore
  its own contract, and an unselected feature genuinely has no selector — checkable on BaseScan without
  trusting this repository. The contract test suite asserts this by searching the **deployed bytecode**
  for each selector, across all eight combinations, because a call that reverts can also just be a
  permission failure.
- **`contracts/TokenFactoryV2.sol`** — `TokenFactoryCore` and `TokenFactoryBurnable`. Two factories,
  because `new TokenX()` inlines TokenX's creation code and the eight variants total 30664 bytes against
  the 24576-byte EIP-170 limit; the split is on Burnable, the only feature needing no creator power, so
  "which factory" and "does this token have an admin" line up exactly. Both are `payable`, compute the
  price from their own table, require `msg.value` to match it exactly, and forward it to the recipient
  in the same call — one transaction, and the factory holds nothing.
- **`docs/TOKEN-PROPERTIES.md`** — the design, the bytecode budget, what `pause` does to mint and burn,
  and how to verify a token's powers on BaseScan yourself.

### Changed

- **Creating a token is now a single transaction.** The fee used to be paid in a separate transfer
  before deploying, which left a paid fee behind if the second transaction failed. The factory collects
  it inside `createToken`, so the fee and the token either both happen or neither does, and the failure
  state no longer has to distinguish "paid but undeployed" from "nothing happened".
- **The price shown is the price the contract reports.** The page displays `feeFor()` and the individual
  `baseFee`/`burnFee`/`mintFee`/`pauseFee` values read from the configured factory, so the number on
  screen and the number the chain demands cannot drift. The environment values decide what the factories
  are deployed with and are the fallback while no factory is configured.
- **`configuration`** — two factory addresses per network
  (`NEXT_PUBLIC_TOKEN_CONTRACT_FACTORY_CORE_SEPOLIA`, `..._BURNABLE_SEPOLIA`) and four prices
  (`NEXT_PUBLIC_TOKEN_CREATOR_FEE_SEPOLIA`, `NEXT_PUBLIC_BURNABLE_FEE_SEPOLIA`,
  `NEXT_PUBLIC_MINTABLE_FEE_SEPOLIA`, `NEXT_PUBLIC_PAUSABLE_FEE_SEPOLIA`).
- **The minimum-fee floor is gone.** A previous revision raised any non-zero fee below 0.0001 ETH up to
  that value; it would have silently rewritten the 0.000001 test price and made the page disagree with
  the chain. `test/unit/config.test.ts` guards against its return.
- **`/setup` deploys both factories** in sequence, with the prices from the environment as constructor
  arguments, and prints the full env block afterwards.

### Backend

- `migrations/003_token_features.sql` adds `burnable`, `mintable` and `pausable` to `tokens`, defaulting
  existing rows to false — the honest value, since those tokens predate the features. Accepted on create,
  **deliberately not updatable**: they record what was bought, which the deployed contract settles, and a
  later PATCH must not be able to make the table disagree with the chain. The admin records view shows
  them per row and per record.
- Nothing in the application can mint, burn, pause or unpause a token. The dashboard reads and displays;
  the on-chain `creator` remains the only address holding those powers.

### Compatibility

- The original factory `0xF7606511aC1E18224A21d851B1cFa7258D3AC684` and both tokens already created with
  it are untouched. Its source, ABI and compiled artifact are kept so
  `scripts/verify-live-factory.mjs` keeps verifying the live bytecode.
- `lib/contracts.ts` now carries both generations: the shared ABI of the new factories and the original
  one, and `chain-verify.ts` accepts a `TokenCreated` log from either factory in either event shape.

### Verification

`typecheck`, `unit 161`, `contract 58`, `integration 23`, `build` and `smoke 35` all passing locally.

### Deployed to Base Sepolia

Both factories are live and the live site points at them:

- `TokenFactoryCore` — `0x490704f22558c57f95ddb501d8dae53f94b9274b`
- `TokenFactoryBurnable` — `0x7444bb7b14d65d180f1f993dee1a4fee4f141641`

Prices on chain: `baseFee`/`burnFee`/`mintFee`/`pauseFee` = 0.000001 ETH each (the Core
factory carries no `burnFee`, as it never deploys burnable tokens), and the fee recipient
is `0x75CBA94CDa95866a5294CDFf66C96d8a8B2663EA`. A full-feature token
(`0x23DffE25285b6b4d7E665Da50C2CCAac4BE8cAF1`) was created end to end and its
`burn`/`mint`/`pause`/`unpause` selectors verified on chain.

## 6.0.0

**This release contains no change to the code.** It exists to give a name to the code
that is already serving the live site.

The deployed build is the commit that added token records (`74ff86b`), and every file
under `app/`, `lib/`, `components/`, `contracts/` and `public/` in this release is
identical to that commit. The only differences from 5.0.0 are this file and the
`version` field in `package.json` and `package-lock.json`. No server was touched.

Why a new version number rather than a tag on that older commit: the live code sits
*between* 4.0.0 and 5.0.0 in the history and carries no tag of its own, so until now
there was no name for "what is actually deployed". Tagging it in place would have put
6.0.0 behind 5.0.0 and made every subsequent diff read backwards. 6.0.0 therefore
continues from 5.0.0 — whose runtime source is already identical to the live code —
and moves nothing but the version number.

**Further changes are made against this revision.** The known issues recorded under
5.0.0 still stand; the `-32002` connection-request loop in particular is still
unaddressed, and is the next thing to fix on top of this baseline.

### Verification

`git diff --stat 74ff86b HEAD -- app lib components contracts public` is empty, which
is the entire claim of this release: the runtime source here is exactly what the live
site serves.

## 5.0.0

Every token creation is now recorded and the operator can look it up. The on-chain
path is untouched: the factory, the token, `createToken`, the `TokenCreated` event,
wallet signing and the network configuration are all unchanged.

### Added

- **`POST /api/creations`** now stores the creator's wallet address, the token name,
  symbol, supply, decimals, network, the deployed token address and the transaction
  hash. One wallet owning many tokens is the ordinary case, so `wallet_address` has
  no unique constraint.
- **`/admin/records`** — a records view behind the existing `ADMIN_SECRET` session.
  Search by wallet address, by token contract, or by name and symbol; copy either
  address from a row; open the transaction or the token on BaseScan; open a record
  for every field including its verification state; and pick a wallet to see every
  token it created as a tree. `/api/admin/records` returns 401 without a session,
  and no public endpoint lists records.
- **`lib/chain-verify.ts`** — a record only becomes `success` when it names both the
  token address and the transaction hash **and the server confirms them against the
  chain itself**. A receipt that reverted, or that produced a different token, is
  refused with a 409 and nothing is stored. When the chain cannot be consulted the
  record is stored with `chain_verified = false` and the reason: an unverifiable
  claim is never upgraded, and a real creation is never lost because an RPC was slow.
- **`lib/record-write.ts`** — the decision to POST or PATCH is now a pure function
  with two rules: a POST always carries the complete creation context, and a PATCH
  requires a real UUID. `lib/record-query.ts` holds the same for search parameters.
- **`lib/admin-auth.ts`** — one implementation of the admin check, since a check that
  drifts is how an endpoint ends up accidentally public.
- **`docs/RECORDS-AND-ADMIN.md`** — the design, the migration, the two bugs the
  end-to-end suite caught, and the reason each record field is trusted or not.
- **The two test scripts those documents reference are now in the repository.**
  `README.md` and `docs/RECORDS-AND-ADMIN.md` referred to
  `tokenbase-migration-test.sh` and `tokenbase-e2e-records-test.sh` in six places,
  but neither file had ever been committed, so the instructions could not be
  followed. Both are added with every location overridable through the environment
  (`APP=`, `BASE=`, `ENVFILE=`, `COMPOSE_DIR=`) rather than hard-coding one host.

### Fixed

- **`wallet_address must be a valid EVM address`** — reported from a real token
  creation, and it had two causes, the first producing the second.

  The `postgres` container had no `postgres` DNS alias: its network settings showed
  `Aliases: null` and only `tokenbuild-postgres-1`. Every write from the app failed
  with `getaddrinfo ENOTFOUND postgres` — the database was reachable by IP, the name
  simply did not resolve. That alone would have been a 503. The 400 came from the
  second cause: one `save()` handled every write and chose POST or PATCH from a piece
  of client state, and the payloads that advance a record's status carry no wallet
  address — correct for a PATCH, but with the first write failing no record id ever
  existed, so those payloads took the POST branch, which requires one.

- **Two bugs only the real API exposed.** The PATCH route validated and
  chain-verified `token_contract_address` and `transaction_hash`, then never wrote
  them into the payload, so a successful record would have been stored without the
  token address or hash and the write-once guard never fired. And `clampInt` treated
  `null` as `0` because `Number(null)` is 0, so an absent `?limit=` was clamped up to
  the minimum of 1 and every admin search returned a single row while reporting the
  correct total. A default must be the default, not the boundary.

### Changed

- `migrations/002_token_records.sql` renames `contract_address` to
  `token_contract_address` and `deployment_tx_hash` to `transaction_hash`. A rename
  moves the data rather than dropping it, and every statement is guarded, so running
  it twice is a no-op. Old rows survive verbatim; `tokenbase-migration-test.sh` proves
  that against a real PostgreSQL by writing rows under the old names first.
- The token address and transaction hash are write-once, and `chain_verified` is
  never taken from a request body.

### Known issues

- `PATCH /api/creations/:id` has no user-level authentication, because the project
  has no user accounts and a creator's browser must be able to advance its own
  record. The write-once rule and the server-side chain check bound the damage to
  writes about things that really happened on chain.
- If the wallet already holds an unanswered connection request, MetaMask refuses new
  ones with `-32002` **immediately**, so the Connect button looks idle again and each
  click produces another rejection. Not addressed in this release.

### Verification

`unit 185`, `contract 24`, `integration 23`, `smoke 35`, `tsc` and `next build` — all
passing. The migration suite runs against a real PostgreSQL and asserts that rows
written under the old column names survive the rename value for value.

## 4.0.0

**This release contains no change to the token functionality.** It publishes the
technical assessment for the requested extension features, so the plan can be
reviewed and versioned. The six features below are **assessed, not implemented**.

### Added

- **`docs/EXTENSIONS-ASSESSMENT.md`** — the full technical assessment for adding
  Burnable, Mintable, Pausable, Anti Whale, Anti Bot and Blacklist to the token
  creator. It covers:
  - how the current `TokenFactory` + `CreatedToken` pair is implemented, with
    measured bytecode sizes (Factory runtime 4,333 bytes, of which 3,255 bytes —
    75% — is `CreatedToken`'s creation code)
  - why adding any token feature **requires redeploying the Factory**: `new
    CreatedToken(...)` inlines the child's creation code into the Factory's
    runtime, so new token code can only reach the chain via a new Factory. The
    deployed Factory has no owner and no upgrade path, so it cannot be changed in
    place. This is a compile-time constraint, not a preference.
  - a per-feature change list, the permission each feature needs, and the
    EIP-170 budget (20,243 bytes free — room for roughly three to five variants,
    given feature-bearing tokens are larger than the current one)
  - the risk register, led by: unbounded `mint` (infinite dilution), `pause`
    freezing a DEX pool (holders cannot sell), and anti-whale limits that omit the
    pair/router address (transfers revert, liquidity can lock)
  - how to keep the frontend from offering features the contract does not have,
    built on the existing four defences plus four new ones

### Not included

The following are **not implemented** and are not part of this release:

| Feature | Needs an owner? | Status |
| --- | --- | --- |
| Burnable | No — `burn` burns the caller's own balance; `burnFrom` uses ERC-20 allowance | Not implemented |
| Mintable | Yes | Not implemented |
| Pausable | Yes | Not implemented |
| Anti Whale | Yes | Not implemented |
| Anti Bot | Yes | Not implemented |
| Blacklist | Yes | Not implemented |

The creator page already lists all six as **Unavailable** with an explicit
"not implemented" note, so the UI does not claim anything the contracts cannot
do. Note also that the current token has no `burn` at all: sending tokens to a
dead address reduces your balance but leaves `totalSupply` unchanged, which is
not the same thing as burning.

Implementation is blocked on eight product decisions recorded in section 7 of the
assessment — most importantly who owns the tokens (the creator's own wallet or
the platform), whether `mint` must be capped by a hard `maxSupply`, and whether
`pause` ships at all given what it does to DEX liquidity.

### Changed

- `package.json` and `package-lock.json` to 4.0.0. No dependency changes; the
  installed dependency tree is identical to 2.0.0.

## 2.0.0

The first release where the token creator actually works end to end. The
repository previously contained a 400-line skeleton: `TokenFactory.sol` was a
single minified line, there was no Solidity toolchain, no test, no deploy script,
and no factory address anywhere.

### Added

- **Browser factory deployment** at `/setup`. Deploys `TokenFactory` from the
  user's own wallet — no private key, no CLI. The address shown comes from the
  mined receipt, never from a locally predicted value.
- **Token creation flow** at `/creator`: name, symbol, supply and decimals, with
  a live preview of the base-unit amount that will be minted.
- **Hardhat 2 + OpenZeppelin 5** toolchain, solc pinned to 0.8.24, with the
  compiled artifact exported into `lib/` for the browser.
- **`lib/network.ts`** — wallet network plumbing. Hands the wallet our own RPC,
  chain name, native currency and explorer, and adds the network itself when the
  wallet does not know it. A user rejection is never mistaken for a missing chain.
- **`lib/validation.ts`, `lib/creator-state.ts`** — token parameter validation and
  the whole UI state machine as pure, testable functions.
- **`scripts/verify-live-factory.mjs`** — read-only verification of a deployed
  factory: code present, runtime bytecode identical to this repository's build,
  `MAX_DECIMALS == 18`, no privileged function, `createToken` simulates at 0/6/18
  decimals, invalid input refused.
- 152 unit tests, 24 contract tests, 17 integration tests, 25 smoke checks.

### Fixed

- `POST /api/creations` rejected `decimals = 0` because it tested the value for
  truthiness. Zero is a legal number of decimals; `decimals = 0` worked nowhere
  before this release.
- Zero-fee mode dead-locked. `pay()` required a truthy fee and `deploy()` required
  a payment hash, so with no fee configured the primary button could never become
  enabled. Free mode now creates a token in a single transaction.
- `lib/config.ts` read `process.env.BASE_NETWORK` — without the `NEXT_PUBLIC_`
  prefix — inside a client component, so the value was always `undefined` in the
  browser. Network selection silently ignored the environment.
- `NEXT_PUBLIC_*` values were inlined at build time, so changing the factory
  address required a full image rebuild. Config is now resolved on the server per
  request, so an address change is a container restart.
- The configured factory address was never checked for code before the wallet was
  asked to send a transaction.
- Logo uploads accepted SVG and were served from this origin — executable content
  on our own domain. Raster formats only now.
- The admin secret was compared with `!==`, a timing side channel. Constant time
  now.
- A missing wallet surfaced as the raw `Provider not found. Version:
  @wagmi/core@2.22.1`. That is wagmi's `ProviderNotFoundError`, raised only when
  `window.ethereum` is undefined — a version pairing was never the problem.
  `/setup` now detects the situation like `/creator` already did.
- A missing factory was reported twice — once as a dedicated, actionable notice and
  once from the generic configuration issue list, which also travelled into the
  RSC payload. "Not configured yet" is a state (`factoryAddress === ""`), not a
  misconfiguration, so it is no longer an issue at all.

### Changed

- The service fee defaults to `0` (free mode, one signed transaction). A non-zero
  fee uses two transactions and requires a recipient; a non-zero fee below
  `0.0001 ETH` is raised to the floor rather than charging an amount that costs an
  extra transaction for nothing.
- The created token is read back from the chain after creation, so the success
  panel proves itself instead of trusting a locally computed value.

### Notes

- The factory is intentionally not deployed by this repository. Deploying it is
  the operator's own transaction; see the README.
- No mock provider, no fabricated hash, no fabricated address, and no fabricated
  success state exists anywhere in this codebase. When the chain says no, the UI
  says no.
