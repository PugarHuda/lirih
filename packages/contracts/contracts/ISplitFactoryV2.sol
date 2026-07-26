// SPDX-License-Identifier: MIT
pragma solidity ^0.8.35;

/// @notice Minimal 0xSplits V2 surface. PushSplitFactory V2.2 (Ethereum Sepolia)
///         0x8E8eB0cC6AE34A38B67D5Cf91ACa38f60bc3Ecf4, Warehouse
///         0x8fb66F38cF86A3d5e8768f8F1754A24A6c661Fb8.
/// @dev VERIFIED 2026-07-22 against source + live eth_call: struct/order and
///      createSplit selector 0x2556fa39 confirmed; createSplit returns the split
///      address. INVARIANT enforced by the factory at creation:
///      sum(allocations) == totalAllocation (else InvalidSplit_TotalAllocationMismatch),
///      and recipients.length == allocations.length. settle() satisfies both.
struct Split {
    address[] recipients;
    uint256[] allocations;
    uint256 totalAllocation;
    uint16 distributionIncentive;
}

interface ISplitFactoryV2 {
    function createSplit(Split calldata splitParams, address owner, address creator)
        external
        returns (address split);
}

interface IPushSplit {
    function distribute(Split calldata splitParams, address token, address distributor)
        external;
}
