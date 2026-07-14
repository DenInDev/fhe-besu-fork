// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../proof/IGroth16EnergyInputVerifier.sol";

contract MockGroth16EnergyInputVerifier is IGroth16EnergyInputVerifier {
    bool public acceptProofs;
    uint256[6] private expectedPublicSignals;

    constructor(bool initialAcceptProofs) {
        acceptProofs = initialAcceptProofs;
    }

    function setAcceptProofs(bool newAcceptProofs) external {
        acceptProofs = newAcceptProofs;
    }

    function setExpectedPublicSignals(uint256[6] calldata publicSignals) external {
        expectedPublicSignals = publicSignals;
    }

    function verifyProof(
        uint256[2] calldata,
        uint256[2][2] calldata,
        uint256[2] calldata,
        uint256[6] calldata publicSignals
    ) external view returns (bool) {
        for (uint256 i = 0; i < publicSignals.length; i++) {
            if (publicSignals[i] != expectedPublicSignals[i]) {
                return false;
            }
        }
        return acceptProofs;
    }
}
