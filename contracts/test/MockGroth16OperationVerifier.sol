// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../proof/IGroth16OperationVerifier.sol";

contract MockGroth16OperationVerifier is IGroth16OperationVerifier {
    bool public acceptProofs;
    uint256[4] private expectedPublicSignals;

    constructor(bool initialAcceptProofs) {
        acceptProofs = initialAcceptProofs;
    }

    function setAcceptProofs(bool newAcceptProofs) external {
        acceptProofs = newAcceptProofs;
    }

    function setExpectedPublicSignals(uint256[4] calldata publicSignals) external {
        expectedPublicSignals = publicSignals;
    }

    function verifyProof(
        uint256[2] calldata,
        uint256[2][2] calldata,
        uint256[2] calldata,
        uint256[4] calldata publicSignals
    ) external view returns (bool) {
        for (uint256 i = 0; i < publicSignals.length; i++) {
            if (publicSignals[i] != expectedPublicSignals[i]) {
                return false;
            }
        }
        return acceptProofs;
    }
}
