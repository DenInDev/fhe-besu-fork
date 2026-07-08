// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../proof/IInputProofVerifier.sol";

/// @title BesuFHEProtocol
/// @notice Primitive a livello di protocollo, condivise dai contratti BesuFHE.
/// @dev Questo layer verifica la validità delle proof e determina la forma dei digest.
abstract contract BesuFHEProtocol {
    enum OperationKind {
        Add,
        Sub,
        MulScalar,
        Eq,
        Lt,
        Select,
        Mean,
        Max
    }

    error NotProofAdmin(address caller);
    error ZeroAddress();
    error InputProofVerifierNotConfigured();
    error InvalidInputProof(bytes32 inputDigest);
    error InputProofConfigurationAlreadyFrozen();
    error InputProofConfigurationIsFrozen();

    bytes32 public constant VERIFIED_INPUT_TYPEHASH = keccak256("BESUFHE_VERIFIED_INPUT_V1");

    address public proofAdmin;
    IInputProofVerifier public inputProofVerifier;
    bool public inputProofConfigurationFrozen;

    event InputProofVerifierUpdated(address indexed verifier);
    event ProofAdminTransferred(address indexed previousAdmin, address indexed newAdmin);
    event InputProofConfigurationFrozen(address indexed admin, address indexed verifier);

    constructor() {
        proofAdmin = msg.sender;
    }

    function transferProofAdmin(address newAdmin) external {
        if (msg.sender != proofAdmin) {
            revert NotProofAdmin(msg.sender);
        }
        if (newAdmin == address(0)) {
            revert ZeroAddress();
        }
        emit ProofAdminTransferred(proofAdmin, newAdmin);
        proofAdmin = newAdmin;
    }

    function setInputProofVerifier(address newVerifier) external {
        if (msg.sender != proofAdmin) {
            revert NotProofAdmin(msg.sender);
        }
        if (inputProofConfigurationFrozen) {
            revert InputProofConfigurationIsFrozen();
        }
        if (newVerifier == address(0)) {
            revert ZeroAddress();
        }
        inputProofVerifier = IInputProofVerifier(newVerifier);
        emit InputProofVerifierUpdated(newVerifier);
    }

    function freezeInputProofConfiguration() external {
        if (msg.sender != proofAdmin) {
            revert NotProofAdmin(msg.sender);
        }
        if (inputProofConfigurationFrozen) {
            revert InputProofConfigurationAlreadyFrozen();
        }
        if (address(inputProofVerifier) == address(0)) {
            revert InputProofVerifierNotConfigured();
        }
        inputProofConfigurationFrozen = true;
        emit InputProofConfigurationFrozen(msg.sender, address(inputProofVerifier));
    }

    function verifiedInputDigestForCiphertext(
        address owner,
        bytes32 ciphertextHash,
        bytes32 inputContextHash,
        bytes32 nonce
    ) public view returns (bytes32) {
        return _verifiedInputDigest(owner, ciphertextHash, inputContextHash, nonce);
    }

    function _verifyInputProof(bytes32 inputDigest, bytes calldata inputProof) internal view {
        if (address(inputProofVerifier) == address(0)) {
            revert InputProofVerifierNotConfigured();
        }
        if (!inputProofVerifier.verifyInputProof(inputDigest, inputProof)) {
            revert InvalidInputProof(inputDigest);
        }
    }

    function _verifiedInputDigest(
        address owner,
        bytes32 ciphertextHash,
        bytes32 inputContextHash,
        bytes32 nonce
    ) internal view returns (bytes32) {
        return keccak256(
            abi.encode(VERIFIED_INPUT_TYPEHASH, block.chainid, address(this), owner, ciphertextHash, inputContextHash, nonce)
        );
    }
}
