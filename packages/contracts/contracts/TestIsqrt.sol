// SPDX-License-Identifier: MIT
pragma solidity ^0.8.35;

import {Nox, euint256, externalEuint256} from
    "@iexec-nox/nox-protocol-contracts/contracts/sdk/Nox.sol";
import {Isqrt} from "./Isqrt.sol";

/// @notice Test-only harness: exposes the encrypted sqrt and marks the result
///         publicly decryptable so a test can check it against floor(√x).
///         Production (LirihRound) never makes sqrt outputs public.
contract TestIsqrt {
    uint256 internal constant SQRT_BITS = 41;
    euint256[SQRT_BITS] internal BIT;
    euint256 internal EZERO;

    constructor() {
        EZERO = Nox.toEuint256(0);
        Nox.allowThis(EZERO);
        for (uint256 i; i < SQRT_BITS; ++i) {
            BIT[i] = Nox.toEuint256(uint256(1) << i);
            Nox.allowThis(BIT[i]);
        }
    }

    /// @notice publicly-decryptable floor(√a); read `lastResult` after the tx.
    euint256 public lastResult;

    function sqrtPublic(externalEuint256 encA, bytes calldata proof) external {
        euint256 a = Nox.fromExternal(encA, proof);
        euint256[] memory bits = new euint256[](SQRT_BITS);
        for (uint256 i; i < SQRT_BITS; ++i) bits[i] = BIT[i];
        euint256 handle = Isqrt.sqrt(a, bits, EZERO);
        Nox.allowThis(handle);
        Nox.allowPublicDecryption(handle);
        lastResult = handle;
    }
}
