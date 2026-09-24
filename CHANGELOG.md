# Changelog

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
