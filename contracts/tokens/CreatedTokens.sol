// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

/**
 * @title CreatedTokenBase
 * @notice The shared body of every token the factory can deploy.
 *
 * Design rules that hold for *all* variants, including the ones with extra
 * features — keep them true:
 *
 *  - Fixed supply at deployment, sent to the creator. Only a variant that
 *    explicitly declares `mint` can ever add to it.
 *  - No owner in the OpenZeppelin sense. `creator` is a plain `immutable`
 *    address carrying exactly the powers its variant needs (mint and/or pause)
 *    and no others: no ownership transfer, no operator roles, no renounce —
 *    nothing that could be repurposed later.
 *  - No proxy, no upgrade path. The deployed bytecode is final.
 *  - `decimals()` is the only non-standard behaviour, and it is immutable.
 */
abstract contract CreatedTokenBase is ERC20 {
    /// @dev Highest value accepted for `decimals`. Above this, most wallets and
    ///      UIs mis-render balances, so such tokens are refused.
    uint8 public constant MAX_DECIMALS = 18;

    /**
     * @notice The wallet that created this token.
     *
     * It receives the whole initial supply and, in the variants that need it, is
     * the only address allowed to mint or pause. Immutable, so it can never be
     * changed or renounced — which also means there is no drain path to steal
     * later.
     *
     * Declared here rather than using OpenZeppelin's `Ownable` on purpose: a
     * token that only needs "the creator may mint" should not also carry
     * `transferOwnership`, `renounceOwnership` and owner-only machinery that no
     * feature uses. Less surface, smaller bytecode, easier to audit.
     *
     * The `onlyCreator` modifier below is declared here too, and that is safe:
     * a modifier is inlined at each use site, so a variant that never uses it
     * pays nothing for its presence. It must NOT be paired with any feature that
     * a variant did not buy — see the note above the eight contracts.
     */
    address public immutable creator;

    uint8 private immutable _customDecimals;

    error InvalidDecimals(uint8 decimals_);
    error InvalidRecipient();
    error NotCreator(address caller);

    modifier onlyCreator() {
        if (msg.sender != creator) revert NotCreator(msg.sender);
        _;
    }

    /**
     * @param name_          ERC-20 name.
     * @param symbol_        ERC-20 symbol.
     * @param decimals_      ERC-20 decimals, 0..18 inclusive. 0 is valid.
     * @param initialSupply_ Total supply in *base units*, already scaled.
     * @param recipient_     Receives the entire supply and becomes `creator`.
     */
    constructor(
        string memory name_,
        string memory symbol_,
        uint8 decimals_,
        uint256 initialSupply_,
        address recipient_
    ) ERC20(name_, symbol_) {
        if (decimals_ > MAX_DECIMALS) revert InvalidDecimals(decimals_);
        if (recipient_ == address(0)) revert InvalidRecipient();

        _customDecimals = decimals_;
        creator = recipient_;

        if (initialSupply_ > 0) {
            _mint(recipient_, initialSupply_);
        }
    }

    /// @inheritdoc ERC20
    function decimals() public view virtual override returns (uint8) {
        return _customDecimals;
    }
}

/**
 * @notice The burn capability, kept in its own contract so that only the
 *         variants that were paid for it inherit it.
 *
 * @dev Needs no creator power at all: `burn` acts on the caller's own balance and
 *      `burnFrom` on the ordinary ERC-20 allowance. This is the one feature that
 *      leaves the project's "no backdoor" promise fully intact.
 *
 *      Parent of exactly the four burnable variants. Putting these two functions
 *      in a base class that every variant inherits would hand `burn` to tokens
 *      whose owner never bought it — the precise failure this design exists to
 *      prevent.
 */
abstract contract BurnableFeature is CreatedTokenBase {
    /// @notice Destroy `amount` of the caller's own tokens. Anyone may call it:
    ///         it needs no permission because it can only reduce the caller's
    ///         own balance.
    function burn(uint256 amount) external {
        _burn(msg.sender, amount);
    }

    /// @notice Burn from `account` using the ordinary ERC-20 allowance. A third
    ///         party cannot burn someone else's tokens without being approved
    ///         first, so this needs no admin role either.
    function burnFrom(address account, uint256 amount) external {
        _spendAllowance(account, msg.sender, amount);
        _burn(account, amount);
    }
}

/**
 * IMPORTANT — why there are eight contracts below instead of one contract with
 * three boolean flags.
 *
 * The rule this product promises is:
 *
 *   "A feature that was not paid for must not exist, not merely be disabled."
 *
 * A single contract holding all three features behind flags would pass a
 * functional test and fail that promise: the code would sit on-chain and only a
 * flag would stand between a stranger and `mint()`. A buyer could not tell the
 * difference by reading the deployed bytecode. So each combination is its own
 * contract, and a token without Mintable genuinely has no `mint` selector at all
 * — verifiable on BaseScan by anyone, without trusting this repository.
 *
 * Two implementation notes that exist to keep that promise affordable:
 *
 *  1. Burn is two short functions in `BurnableFeature` rather than OpenZeppelin's
 *     `ERC20Burnable`. `ERC20Burnable` re-inherits `ERC20`, which forces every
 *     derived variant to re-declare `decimals()` to resolve the diamond —
 *     boilerplate and bytes we cannot spare here.
 *  2. Pause uses OpenZeppelin's `Pausable` (which does *not* inherit `ERC20`)
 *     plus a `_update` gate, instead of `ERC20Pausable`, for the same reason.
 *
 * See docs/TOKEN-PROPERTIES.md for the bytecode budget that makes this matter.
 */

/// @notice No optional features: fixed supply, no mint, no burn, no pause. The
///         behaviour the project shipped before this change.
contract TokenStandard is CreatedTokenBase {
    constructor(
        string memory name_,
        string memory symbol_,
        uint8 decimals_,
        uint256 initialSupply_,
        address recipient_
    ) CreatedTokenBase(name_, symbol_, decimals_, initialSupply_, recipient_) {}
}

/// @notice Burnable.
contract TokenBurnable is BurnableFeature {
    constructor(
        string memory name_,
        string memory symbol_,
        uint8 decimals_,
        uint256 initialSupply_,
        address recipient_
    ) CreatedTokenBase(name_, symbol_, decimals_, initialSupply_, recipient_) {}
}

/// @notice Mintable.
contract TokenMintable is CreatedTokenBase {
    constructor(
        string memory name_,
        string memory symbol_,
        uint8 decimals_,
        uint256 initialSupply_,
        address recipient_
    ) CreatedTokenBase(name_, symbol_, decimals_, initialSupply_, recipient_) {}

    /// @notice Create `amount` new tokens for `to`. Creator only.
    /// @dev Deliberately uncapped, per product decision: the creator paid for
    ///      this power and the creation page states it plainly. No other variant
    ///      carries this function.
    function mint(address to, uint256 amount) external onlyCreator {
        _mint(to, amount);
    }
}

/// @notice Pausable.
/// @dev The freeze gates `_update`, the single funnel every balance change goes
///      through. The consequence — deliberate, and identical to what
///      OpenZeppelin's `ERC20Pausable` produces — is that while paused,
///      transfers, `mint` and `burn` all fail together. Documented in
///      docs/TOKEN-PROPERTIES.md.
contract TokenPausable is CreatedTokenBase, Pausable {
    constructor(
        string memory name_,
        string memory symbol_,
        uint8 decimals_,
        uint256 initialSupply_,
        address recipient_
    ) CreatedTokenBase(name_, symbol_, decimals_, initialSupply_, recipient_) {}

    function pause() external onlyCreator {
        _pause();
    }

    function unpause() external onlyCreator {
        _unpause();
    }

    function _update(address from, address to, uint256 value)
        internal
        override
        whenNotPaused
    {
        super._update(from, to, value);
    }
}

/// @notice Burnable + Mintable.
contract TokenBurnableMintable is BurnableFeature {
    constructor(
        string memory name_,
        string memory symbol_,
        uint8 decimals_,
        uint256 initialSupply_,
        address recipient_
    ) CreatedTokenBase(name_, symbol_, decimals_, initialSupply_, recipient_) {}

    function mint(address to, uint256 amount) external onlyCreator {
        _mint(to, amount);
    }
}

/// @notice Burnable + Pausable.
contract TokenBurnablePausable is BurnableFeature, Pausable {
    constructor(
        string memory name_,
        string memory symbol_,
        uint8 decimals_,
        uint256 initialSupply_,
        address recipient_
    ) CreatedTokenBase(name_, symbol_, decimals_, initialSupply_, recipient_) {}

    function pause() external onlyCreator {
        _pause();
    }

    function unpause() external onlyCreator {
        _unpause();
    }

    function _update(address from, address to, uint256 value)
        internal
        override
        whenNotPaused
    {
        super._update(from, to, value);
    }
}

/// @notice Mintable + Pausable.
contract TokenMintablePausable is CreatedTokenBase, Pausable {
    constructor(
        string memory name_,
        string memory symbol_,
        uint8 decimals_,
        uint256 initialSupply_,
        address recipient_
    ) CreatedTokenBase(name_, symbol_, decimals_, initialSupply_, recipient_) {}

    function mint(address to, uint256 amount) external onlyCreator {
        _mint(to, amount);
    }

    function pause() external onlyCreator {
        _pause();
    }

    function unpause() external onlyCreator {
        _unpause();
    }

    function _update(address from, address to, uint256 value)
        internal
        override
        whenNotPaused
    {
        super._update(from, to, value);
    }
}

/// @notice All three features.
contract TokenFull is BurnableFeature, Pausable {
    constructor(
        string memory name_,
        string memory symbol_,
        uint8 decimals_,
        uint256 initialSupply_,
        address recipient_
    ) CreatedTokenBase(name_, symbol_, decimals_, initialSupply_, recipient_) {}

    function mint(address to, uint256 amount) external onlyCreator {
        _mint(to, amount);
    }

    function pause() external onlyCreator {
        _pause();
    }

    function unpause() external onlyCreator {
        _unpause();
    }

    function _update(address from, address to, uint256 value)
        internal
        override
        whenNotPaused
    {
        super._update(from, to, value);
    }
}
