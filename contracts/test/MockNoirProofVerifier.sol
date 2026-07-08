// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../proof/INoirProofVerifier.sol";

/// @notice Test-only Barretenberg verifier stand-in for Noir adapter wiring.
contract MockNoirProofVerifier is INoirProofVerifier {
    bool public acceptProofs;
    bytes32[] private expectedPublicInputs;

    constructor(bool initialAcceptProofs) {
        acceptProofs = initialAcceptProofs;
    }

    function setAcceptProofs(bool newAcceptProofs) external {
        acceptProofs = newAcceptProofs;
    }

    function setExpectedPublicInputs(bytes32[] calldata publicInputs) external {
        expectedPublicInputs = publicInputs;
    }

    function verify(bytes calldata proof, bytes32[] calldata publicInputs) external view returns (bool) {
        if (proof.length == 0 || publicInputs.length != expectedPublicInputs.length) {
            return false;
        }
        for (uint256 i = 0; i < publicInputs.length; i++) {
            if (publicInputs[i] != expectedPublicInputs[i]) {
                return false;
            }
        }
        return acceptProofs;
    }
}
