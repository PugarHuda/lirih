// SPDX-License-Identifier: MIT
pragma solidity ^0.8.35;

import {Nox, ebool, euint256} from
    "@iexec-nox/nox-protocol-contracts/contracts/sdk/Nox.sol";

/// @title Isqrt — floor(√a) on encrypted euint256 via bounded binary search.
/// @notice Nox has no sqrt and no bit ops, so Newton can't be seeded to
///         converge in a fixed loop. Bit-by-bit binary search using only
///         add/mul/le/select is exact and deterministic. Proven exact over
///         [0, 1e24] in reference/qf-reference.mjs. Cost = 4 ops × bit.length.
/// @dev Caller precomputes `bit[i] = toEuint256(1<<i)` (public constants) and
///      `zero = toEuint256(0)` once, and must `allowThis` each — passing them
///      in keeps this a pure-compute helper that mints no handles per call.
library Isqrt {
    function sqrt(euint256 a, euint256[] memory bit, euint256 zero)
        internal
        returns (euint256 result)
    {
        result = zero;
        for (uint256 i = bit.length; i > 0; --i) {
            euint256 trial = Nox.add(result, bit[i - 1]);
            ebool ok = Nox.le(Nox.mul(trial, trial), a);
            result = Nox.select(ok, trial, result);
        }
    }
}
