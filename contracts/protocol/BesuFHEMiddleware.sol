// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../lib/OnChainCiphertext.sol";
import "./BesuFHEProtocol.sol";

/// @notice Middleware generico per contratti che devono memorizzare ciphertext FHE on-chain e
/// associare i risultati di operazioni omomorfiche a identificativi di record riutilizzabili.
/// @dev I contratti applicativi dovrebbero esporre nomi e policy specifici del dominio,
/// delegando qui il ciclo di vita dei ciphertext e la gestione delle operazioni.
abstract contract BesuFHEMiddleware is BesuFHEProtocol {
    using OnChainCiphertext for OnChainCiphertext.Blob;

    struct FheCiphertextRecord {
        address owner;
        OnChainCiphertext.Blob ciphertext;
        bytes32 metadataHash;
        uint256 blockNumber;
    }

    struct FheOperationRecord {
        OperationKind kind;
        address owner;
        uint256 resultCiphertextId;
        bytes32 inputSetHash;
        uint256 blockNumber;
    }

    error FheEmptyCiphertext();
    error FheInvalidCiphertext(uint256 ciphertextId);
    error FheInvalidOperation(uint256 operationId);
    error FheNotOwner(address caller, address expected);
    error FheEmptyInputSet();

    uint256 private fheCiphertextCount;
    uint256 private fheOperationCount;

    mapping(uint256 => FheCiphertextRecord) private fheCiphertexts;
    mapping(uint256 => FheOperationRecord) private fheOperations;

    event FheCiphertextStored(
        uint256 indexed ciphertextId,
        address indexed owner,
        bytes32 indexed ciphertextHash,
        bytes32 metadataHash,
        uint256 ciphertextLength
    );

    event FheOperationStored(
        uint256 indexed operationId,
        OperationKind indexed kind,
        address indexed owner,
        uint256 resultCiphertextId,
        bytes32 inputSetHash,
        bytes32 ciphertextHash,
        uint256 ciphertextLength
    );

    function getFheCiphertextCount() public view returns (uint256) {
        return fheCiphertextCount;
    }

    function getFheOperationCount() public view returns (uint256) {
        return fheOperationCount;
    }

    function getFheCiphertext(uint256 ciphertextId)
        public
        view
        returns (address owner, bytes memory ciphertext, bytes32 metadataHash, uint256 blockNumber)
    {
        FheCiphertextRecord storage record = _requireFheCiphertext(ciphertextId);
        return (record.owner, record.ciphertext.read(), record.metadataHash, record.blockNumber);
    }

    function getFheOperation(uint256 operationId)
        public
        view
        returns (
            OperationKind kind,
            address owner,
            uint256 resultCiphertextId,
            bytes memory ciphertext,
            bytes32 inputSetHash,
            uint256 blockNumber
        )
    {
        FheOperationRecord storage operation = _requireFheOperation(operationId);
        FheCiphertextRecord storage result = _requireFheCiphertext(operation.resultCiphertextId);
        return (
            operation.kind,
            operation.owner,
            operation.resultCiphertextId,
            result.ciphertext.read(),
            operation.inputSetHash,
            operation.blockNumber
        );
    }

    function getFheCiphertextStorage(uint256 ciphertextId)
        public
        view
        returns (address manifest, uint256 ciphertextLength, uint256 chunkCount, bytes32 contentHash)
    {
        FheCiphertextRecord storage record = _requireFheCiphertext(ciphertextId);
        return record.ciphertext.metadata();
    }

    function getFheOperationCiphertextStorage(uint256 operationId)
        public
        view
        returns (address manifest, uint256 ciphertextLength, uint256 chunkCount, bytes32 contentHash)
    {
        FheOperationRecord storage operation = _requireFheOperation(operationId);
        FheCiphertextRecord storage result = _requireFheCiphertext(operation.resultCiphertextId);
        return result.ciphertext.metadata();
    }

    function _storeFheCiphertext(address owner, bytes memory ciphertext, bytes32 metadataHash)
        internal
        returns (uint256 ciphertextId)
    {
        if (ciphertext.length == 0) {
            revert FheEmptyCiphertext();
        }

        ciphertextId = ++fheCiphertextCount;
        FheCiphertextRecord storage record = fheCiphertexts[ciphertextId];
        record.owner = owner;
        record.metadataHash = metadataHash;
        record.blockNumber = block.number;
        record.ciphertext.write(ciphertext);

        emit FheCiphertextStored(
            ciphertextId,
            owner,
            record.ciphertext.contentHash,
            metadataHash,
            ciphertext.length
        );
    }

    function _storeFheOperation(OperationKind kind, address owner, bytes memory output, bytes32 inputSetHash)
        internal
        returns (uint256 operationId)
    {
        return _storeFheOperationWithMetadata(kind, owner, output, inputSetHash, bytes32(0));
    }

    function _storeFheOperationWithMetadata(
        OperationKind kind,
        address owner,
        bytes memory output,
        bytes32 inputSetHash,
        bytes32 resultMetadataHash
    ) internal returns (uint256 operationId)
    {
        uint256 resultCiphertextId = _storeFheCiphertext(owner, output, resultMetadataHash);

        operationId = ++fheOperationCount;
        FheOperationRecord storage operation = fheOperations[operationId];
        operation.kind = kind;
        operation.owner = owner;
        operation.resultCiphertextId = resultCiphertextId;
        operation.inputSetHash = inputSetHash;
        operation.blockNumber = block.number;

        emit FheOperationStored(
            operationId,
            kind,
            owner,
            resultCiphertextId,
            inputSetHash,
            _fheCiphertextHash(resultCiphertextId),
            output.length
        );
    }

    function _requireOwnedFheCiphertext(uint256 ciphertextId, address owner)
        internal
        view
        returns (FheCiphertextRecord storage record)
    {
        record = _requireFheCiphertext(ciphertextId);
        if (record.owner != owner) {
            revert FheNotOwner(owner, record.owner);
        }
    }

    function _ownedBinaryFheCiphertexts(uint256 leftId, uint256 rightId, address owner)
        internal
        view
        returns (bytes memory left, bytes memory right, bytes32 inputSetHash)
    {
        FheCiphertextRecord storage leftRecord = _requireOwnedFheCiphertext(leftId, owner);
        FheCiphertextRecord storage rightRecord = _requireOwnedFheCiphertext(rightId, owner);
        left = leftRecord.ciphertext.read();
        right = rightRecord.ciphertext.read();
        inputSetHash = keccak256(abi.encode(leftRecord.ciphertext.contentHash, rightRecord.ciphertext.contentHash));
    }

    function _ownedAggregateFheCiphertexts(uint256[] calldata ciphertextIds, address owner)
        internal
        view
        returns (bytes[] memory inputs, bytes32 inputSetHash)
    {
        if (ciphertextIds.length == 0) {
            revert FheEmptyInputSet();
        }

        inputs = new bytes[](ciphertextIds.length);
        bytes32[] memory hashes = new bytes32[](ciphertextIds.length);
        for (uint256 i = 0; i < ciphertextIds.length; i++) {
            FheCiphertextRecord storage record = _requireOwnedFheCiphertext(ciphertextIds[i], owner);
            inputs[i] = record.ciphertext.read();
            hashes[i] = record.ciphertext.contentHash;
        }
        inputSetHash = keccak256(abi.encode(hashes));
    }

    function _ownedAggregateFheCommitmentHash(uint256[] calldata ciphertextIds, address owner)
        internal
        view
        returns (bytes32 inputSetHash)
    {
        if (ciphertextIds.length == 0) {
            revert FheEmptyInputSet();
        }

        bytes32[] memory hashes = new bytes32[](ciphertextIds.length);
        for (uint256 i = 0; i < ciphertextIds.length; i++) {
            FheCiphertextRecord storage record = _requireOwnedFheCiphertext(ciphertextIds[i], owner);
            hashes[i] = keccak256(abi.encode(record.ciphertext.contentHash, record.metadataHash));
        }
        inputSetHash = keccak256(abi.encode(hashes));
    }

    function _fheScalarInputHash(uint256 ciphertextId, address owner, uint64 scalar)
        internal
        view
        returns (bytes32)
    {
        FheCiphertextRecord storage record = _requireOwnedFheCiphertext(ciphertextId, owner);
        return keccak256(abi.encode(record.ciphertext.contentHash, record.metadataHash, scalar));
    }

    function _fheCiphertextBytes(uint256 ciphertextId) internal view returns (bytes memory) {
        FheCiphertextRecord storage record = _requireFheCiphertext(ciphertextId);
        return record.ciphertext.read();
    }

    function _fheCiphertextHash(uint256 ciphertextId) internal view returns (bytes32) {
        FheCiphertextRecord storage record = _requireFheCiphertext(ciphertextId);
        return record.ciphertext.contentHash;
    }

    function _fheCiphertextOwner(uint256 ciphertextId) internal view returns (address) {
        return fheCiphertexts[ciphertextId].owner;
    }

    function _fheCiphertextMetadataHash(uint256 ciphertextId) internal view returns (bytes32) {
        FheCiphertextRecord storage record = _requireFheCiphertext(ciphertextId);
        return record.metadataHash;
    }

    function _fheCiphertextBlockNumber(uint256 ciphertextId) internal view returns (uint256) {
        FheCiphertextRecord storage record = _requireFheCiphertext(ciphertextId);
        return record.blockNumber;
    }

    function _fheOperationResultCiphertextId(uint256 operationId) internal view returns (uint256) {
        FheOperationRecord storage operation = _requireFheOperation(operationId);
        return operation.resultCiphertextId;
    }

    function _requireFheCiphertext(uint256 ciphertextId)
        internal
        view
        returns (FheCiphertextRecord storage record)
    {
        record = fheCiphertexts[ciphertextId];
        if (record.owner == address(0)) {
            revert FheInvalidCiphertext(ciphertextId);
        }
    }

    function _requireFheOperation(uint256 operationId)
        internal
        view
        returns (FheOperationRecord storage operation)
    {
        operation = fheOperations[operationId];
        if (operation.owner == address(0)) {
            revert FheInvalidOperation(operationId);
        }
    }
}
