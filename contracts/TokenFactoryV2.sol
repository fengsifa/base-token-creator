// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {
    TokenStandard,
    TokenMintable,
    TokenPausable,
    TokenMintablePausable,
    TokenBurnable,
    TokenBurnableMintable,
    TokenBurnablePausable,
    TokenFull
} from "./tokens/CreatedTokens.sol";

/**
 * @title TokenFactoryBase
 * @notice Everything the two factories below share: the price table, the input
 *         validation, and settling the service fee.
 *
 * @dev Deliberately holds no `new Token…()` call. The creation code of a token
 *      variant is inlined into whichever contract constructs it, so keeping the
 *      constructors in the two concrete factories is what lets each of them stay
 *      under EIP-170. See the note in TokenFactoryCore.
 */
abstract contract TokenFactoryBase {
    /// @notice Platform service fee in wei, one component per selectable feature.
    /// @dev Set at deployment from the environment, not hardcoded, so mainnet and
    ///      testnet can be priced independently without touching the source.
    uint256 public immutable baseFee;
    uint256 public immutable burnFee;
    uint256 public immutable mintFee;
    uint256 public immutable pauseFee;

    /// @notice Receives every service fee. Never holds funds: each call forwards
    ///         the fee immediately, so the factory is not a pot to be drained.
    address public immutable feeRecipient;

    uint256 public constant MAX_NAME_BYTES = 32;
    uint256 public constant MAX_SYMBOL_BYTES = 12;
    uint8 public constant MAX_DECIMALS = 18;

    /// @notice Emitted once per successful creation.
    /// @dev The three feature flags are part of the event so a record can be
    ///      built from chain data alone, without trusting what the page claimed.
    event TokenCreated(
        address indexed token,
        address indexed creator,
        string name,
        string symbol,
        bool burnable,
        bool mintable,
        bool pausable
    );

    error EmptyName();
    error NameTooLong(uint256 length);
    error EmptySymbol();
    error SymbolTooLong(uint256 length);
    error ZeroSupply();
    error DecimalsTooHigh(uint8 decimals_);
    error InvalidFeeRecipient();
    /// @dev The caller sent an amount that does not match the published price.
    ///      Deliberately an exact match: the page shows one number and the chain
    ///      must require exactly that number, never more and never less.
    error WrongFee(uint256 required, uint256 sent);
    error FeeTransferFailed();
    /// @dev The requested feature set belongs to the other factory.
    error FeatureNotSupportedHere();

    constructor(
        uint256 baseFee_,
        uint256 burnFee_,
        uint256 mintFee_,
        uint256 pauseFee_,
        address feeRecipient_
    ) {
        if (feeRecipient_ == address(0)) revert InvalidFeeRecipient();

        baseFee = baseFee_;
        burnFee = burnFee_;
        mintFee = mintFee_;
        pauseFee = pauseFee_;
        feeRecipient = feeRecipient_;
    }

    /**
     * @notice The exact price for a feature combination, in wei.
     *
     * This is the single source of truth for the price. The page reads it and
     * displays it, and `createToken` requires exactly it, so the two cannot
     * disagree without the transaction failing loudly.
     */
    function feeFor(
        bool burnable_,
        bool mintable_,
        bool pausable_
    ) public view returns (uint256) {
        return
            baseFee +
            (burnable_ ? burnFee : 0) +
            (mintable_ ? mintFee : 0) +
            (pausable_ ? pauseFee : 0);
    }

    function _validateToken(
        string calldata name_,
        string calldata symbol_,
        uint8 decimals_,
        uint256 supply_
    ) internal pure {
        uint256 nameLength = bytes(name_).length;
        if (nameLength == 0) revert EmptyName();
        if (nameLength > MAX_NAME_BYTES) revert NameTooLong(nameLength);

        uint256 symbolLength = bytes(symbol_).length;
        if (symbolLength == 0) revert EmptySymbol();
        if (symbolLength > MAX_SYMBOL_BYTES) revert SymbolTooLong(symbolLength);

        if (supply_ == 0) revert ZeroSupply();
        if (decimals_ > MAX_DECIMALS) revert DecimalsTooHigh(decimals_);
    }

    function _settleFee(uint256 required) internal {
        if (required == 0) return;

        (bool ok, ) = feeRecipient.call{value: required}("");
        if (!ok) revert FeeTransferFailed();
    }
}

/**
 * @title TokenFactoryCore
 * @notice Creates tokens that do **not** have the burn feature: Standard,
 *         Mintable, Pausable and Mintable+Pausable.
 *
 * @dev Why this factory exists at all — the EIP-170 constraint.
 *
 * `new TokenX(...)` inlines TokenX's *creation code* into the deploying
 * contract's runtime bytecode. Measured with this repository's own compiler
 * settings, the eight variants total 30,664 bytes of creation code, against a
 * hard limit of 24,576 bytes per contract (EIP-170). One factory therefore cannot
 * host all eight, and no amount of cleverness changes that: every variant has to
 * carry a full ERC-20 implementation, and the compiler will not share it between
 * them.
 *
 * Splitting by the burn flag is the natural cut because burn is the only feature
 * that needs no creator power at all — so "which factory" and "does this token
 * have an admin" line up exactly. Four variants each, comfortably under the
 * limit, and both factories publish the same `createToken` signature so callers
 * only have to pick the right address.
 *
 * The alternative considered and rejected was EIP-1167 minimal proxies: cheaper
 * per creation, but it would have turned every token into a proxy whose real code
 * lives elsewhere — precisely the "is there something hidden in here?" question
 * this product exists to answer honestly. A plain, verifiable contract per token
 * is worth the extra gas at this stage.
 */
contract TokenFactoryCore is TokenFactoryBase {
    constructor(
        uint256 baseFee_,
        uint256 mintFee_,
        uint256 pauseFee_,
        address feeRecipient_
    ) TokenFactoryBase(baseFee_, 0, mintFee_, pauseFee_, feeRecipient_) {}

    /**
     * @notice Deploy a non-burnable ERC-20 with a fixed supply sent to `msg.sender`.
     * @param burnable_ Must be false — burnable tokens are created by
     *                  `TokenFactoryBurnable`. Reverting here rather than
     *                  silently ignoring keeps the two factories honest about
     *                  which one is allowed to mint what.
     */
    function createToken(
        string calldata name_,
        string calldata symbol_,
        uint8 decimals_,
        uint256 supply_,
        bool burnable_,
        bool mintable_,
        bool pausable_
    ) external payable returns (address token) {
        if (burnable_) revert FeatureNotSupportedHere();

        _validateToken(name_, symbol_, decimals_, supply_);

        uint256 required = feeFor(false, mintable_, pausable_);
        if (msg.value != required) revert WrongFee(required, msg.value);

        if (mintable_) {
            if (pausable_) {
                token = address(
                    new TokenMintablePausable(name_, symbol_, decimals_, supply_, msg.sender)
                );
            } else {
                token = address(
                    new TokenMintable(name_, symbol_, decimals_, supply_, msg.sender)
                );
            }
        } else {
            if (pausable_) {
                token = address(
                    new TokenPausable(name_, symbol_, decimals_, supply_, msg.sender)
                );
            } else {
                token = address(
                    new TokenStandard(name_, symbol_, decimals_, supply_, msg.sender)
                );
            }
        }

        _settleFee(required);

        emit TokenCreated(
            token,
            msg.sender,
            name_,
            symbol_,
            false,
            mintable_,
            pausable_
        );
    }
}

/**
 * @title TokenFactoryBurnable
 * @notice Creates tokens that **do** have the burn feature: Burnable,
 *         Burnable+Mintable, Burnable+Pausable, and all three.
 *
 * @dev Identical signature and price table to `TokenFactoryCore`; only the set of
 *      variants it can deploy differs. See that contract for why there are two.
 */
contract TokenFactoryBurnable is TokenFactoryBase {
    constructor(
        uint256 baseFee_,
        uint256 burnFee_,
        uint256 mintFee_,
        uint256 pauseFee_,
        address feeRecipient_
    ) TokenFactoryBase(baseFee_, burnFee_, mintFee_, pauseFee_, feeRecipient_) {}

    /**
     * @notice Deploy a burnable ERC-20 with a fixed supply sent to `msg.sender`.
     * @param burnable_ Must be true — non-burnable tokens are created by
     *                  `TokenFactoryCore`.
     */
    function createToken(
        string calldata name_,
        string calldata symbol_,
        uint8 decimals_,
        uint256 supply_,
        bool burnable_,
        bool mintable_,
        bool pausable_
    ) external payable returns (address token) {
        if (!burnable_) revert FeatureNotSupportedHere();

        _validateToken(name_, symbol_, decimals_, supply_);

        uint256 required = feeFor(true, mintable_, pausable_);
        if (msg.value != required) revert WrongFee(required, msg.value);

        if (mintable_) {
            if (pausable_) {
                token = address(
                    new TokenFull(name_, symbol_, decimals_, supply_, msg.sender)
                );
            } else {
                token = address(
                    new TokenBurnableMintable(name_, symbol_, decimals_, supply_, msg.sender)
                );
            }
        } else {
            if (pausable_) {
                token = address(
                    new TokenBurnablePausable(name_, symbol_, decimals_, supply_, msg.sender)
                );
            } else {
                token = address(
                    new TokenBurnable(name_, symbol_, decimals_, supply_, msg.sender)
                );
            }
        }

        _settleFee(required);

        emit TokenCreated(
            token,
            msg.sender,
            name_,
            symbol_,
            true,
            mintable_,
            pausable_
        );
    }
}
