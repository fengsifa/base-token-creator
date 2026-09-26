# Changelog

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
