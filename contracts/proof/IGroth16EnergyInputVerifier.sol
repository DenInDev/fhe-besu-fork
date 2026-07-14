// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IGroth16EnergyInputVerifier {
    function verifyProof(
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c,
        uint256[6] calldata publicSignals
    ) external view returns (bool);
}
