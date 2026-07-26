// SPDX-License-Identifier: MIT
pragma solidity ^0.8.35;

import {IERC20} from "@openzeppelin/contracts/interfaces/IERC20.sol";
import {ERC20ToERC7984Wrapper} from
    "@iexec-nox/nox-confidential-contracts/contracts/token/extensions/ERC20ToERC7984Wrapper.sol";

/// @notice Confidential USDC: wrap plaintext mUSDC -> encrypted balance. Uses
///         the official iExec wrapper (no hand-rolled ERC-7984). wrap() reveals
///         the amount (plaintext calldata); only post-wrap movements are hidden.
contract cUSDC is ERC20ToERC7984Wrapper {
    constructor(IERC20 underlying)
        ERC20ToERC7984Wrapper("Confidential USDC", "cUSDC", "", underlying)
    {}
}
