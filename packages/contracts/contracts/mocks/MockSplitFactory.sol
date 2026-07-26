// SPDX-License-Identifier: MIT
pragma solidity ^0.8.35;

import {IERC20} from "@openzeppelin/contracts/interfaces/IERC20.sol";
import {ISplitFactoryV2, IPushSplit, Split} from "../ISplitFactoryV2.sol";

/// @notice Test-only stand-in for 0xSplits V2. Real Splits isn't in the Nox
///         ephemeral stack, so tests use this to assert the settle path splits
///         the matching pool pro-rata to the revealed QF allocations.
contract MockPushSplit is IPushSplit {
    function distribute(Split calldata s, address token, address) external {
        uint256 bal = IERC20(token).balanceOf(address(this));
        uint256 total = s.totalAllocation;
        if (total == 0) return;
        for (uint256 i; i < s.recipients.length; ++i) {
            uint256 amt = (bal * s.allocations[i]) / total;
            if (amt > 0) IERC20(token).transfer(s.recipients[i], amt);
        }
    }
}

contract MockSplitFactory is ISplitFactoryV2 {
    event SplitCreated(address split, Split params);

    function createSplit(Split calldata params, address, address)
        external
        returns (address split)
    {
        split = address(new MockPushSplit());
        emit SplitCreated(split, params);
    }
}
