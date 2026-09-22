// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title CreatedToken
 * @notice A deliberately minimal, standard ERC-20.
 *
 * Design rules (these are the whole security story, keep them true):
 *  - Fixed supply. Minted exactly once, inside the constructor, to `recipient_`.
 *  - No owner, no admin, no roles.
 *  - No `mint`, no `burn`, no `pause`, no blacklist, no fee-on-transfer, no hooks.
 *  - `decimals()` is the only non-standard behaviour, and it is immutable.
 *
 * In short: once deployed, nobody — including the factory deployer and the token
 * creator — can change supply or restrict transfers. There is no backdoor.
 */
contract CreatedToken is ERC20 {
    /// @dev Highest value accepted for `decimals`. Above this, most wallets and
    ///      UIs mis-render balances, so the factory refuses to create such tokens.
    uint8 public constant MAX_DECIMALS = 18;

    uint8 private immutable _customDecimals;

    error InvalidDecimals(uint8 decimals_);
    error InvalidRecipient();

    /**
     * @param name_          ERC-20 name.
     * @param symbol_        ERC-20 symbol.
     * @param decimals_      ERC-20 decimals, 0..18 inclusive. 0 is valid and is
     *                       the case that breaks naive `if (!decimals)` checks.
     * @param initialSupply_ Total supply in *base units*. When decimals_ is 18,
     *                       a human supply of "1000" must be passed as 1000e18.
     * @param recipient_     Receives the entire supply. Must not be the zero address.
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
 * @title TokenFactory
 * @notice Stateless ERC-20 deployer for Base. One call, one token, no fee.
 *
 * The factory holds no funds, has no owner and no upgrade path. Every call
 * deploys a fresh `CreatedToken` via CREATE and emits `TokenCreated`, which is
 * how the frontend discovers the new token address (it never trusts a locally
 * computed address).
 *
 * MVP configuration: platform service fee is 0 ETH. The caller pays gas only,
 * so `createToken` is intentionally non-payable and rejects stray ETH.
 */
contract TokenFactory {
    /// @notice Emitted once per successful creation.
    /// @dev Field order and indexing are part of the public interface — the
    ///      frontend decodes this event, so do not reorder or re-index it.
    event TokenCreated(address indexed token, address indexed creator, string name, string symbol);

    uint256 public constant MAX_NAME_BYTES = 32;
    uint256 public constant MAX_SYMBOL_BYTES = 12;
    uint8 public constant MAX_DECIMALS = 18;

    error EmptyName();
    error NameTooLong(uint256 length);
    error EmptySymbol();
    error SymbolTooLong(uint256 length);
    error ZeroSupply();
    error DecimalsTooHigh(uint8 decimals_);

    /**
     * @notice Deploy a new ERC-20 with a fixed supply sent to `msg.sender`.
     * @param name_     Token name, 1..32 UTF-8 bytes.
     * @param symbol_   Token symbol, 1..12 UTF-8 bytes.
     * @param decimals_ Token decimals, 0..18 inclusive.
     * @param supply_   Total supply in base units (already scaled by `decimals_`),
     *                  must be greater than zero.
     * @return token    Address of the deployed token.
     */
    function createToken(
        string calldata name_,
        string calldata symbol_,
        uint8 decimals_,
        uint256 supply_
    ) external returns (address token) {
        uint256 nameLength = bytes(name_).length;
        if (nameLength == 0) revert EmptyName();
        if (nameLength > MAX_NAME_BYTES) revert NameTooLong(nameLength);

        uint256 symbolLength = bytes(symbol_).length;
        if (symbolLength == 0) revert EmptySymbol();
        if (symbolLength > MAX_SYMBOL_BYTES) revert SymbolTooLong(symbolLength);

        if (supply_ == 0) revert ZeroSupply();
        if (decimals_ > MAX_DECIMALS) revert DecimalsTooHigh(decimals_);

        token = address(new CreatedToken(name_, symbol_, decimals_, supply_, msg.sender));

        emit TokenCreated(token, msg.sender, name_, symbol_);
    }
}
