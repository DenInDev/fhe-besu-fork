// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./lib/FhePrecompile.sol";
import "./protocol/BesuFHEOperationProof.sol";

/// @title EnergyDataNotaryOnChain
/// @notice Contratto per la gestione On-Chain del caso d'uso del consumo/produzione energetico
contract EnergyDataNotaryOnChain is BesuFHEOperationProof {
    error MissingLastEntry(address owner);
    error MissingEncryptedTotal(address owner);
    error MissingLastResult(address owner);

    mapping(address => uint256) private lastEntryIds;
    mapping(address => uint256) private encryptedTotalIds;
    mapping(address => uint256) private lastResultIds;

    // Eventi per la notarizzazione di operazioni/notarizzazioni
    event EnergyEntryAdded(
        address indexed owner,
        uint256 indexed ciphertextId,
        bytes32 indexed ciphertextHash,
        uint256 ciphertextLength
    );

    event EncryptedTotalInitialized(
        address indexed owner,
        uint256 indexed ciphertextId,
        bytes32 indexed ciphertextHash,
        uint256 ciphertextLength
    );

    event EnergyOperationExecuted(
        address indexed owner,
        OperationKind indexed kind,
        uint256 indexed resultCiphertextId,
        bytes32 ciphertextHash,
        uint256 ciphertextLength
    );

    // Aggiunge una energy entry cifrata relativa a un address, memorizzando il ciphertext con il metodo chunk/storage.
    // Verifica che la input proof sia coerente con il ciphertext fornito esternamente.
    function addEnergyEntry(
        bytes calldata encryptedValue,
        bytes32 metadataHash,
        uint256 minValue,
        uint256 maxValue,
        bytes32 nonce,
        bytes calldata inputProof
    ) external returns (uint256 ciphertextId) {
        (ciphertextId,) =
            _storeFheCiphertextWithInputProof(msg.sender, encryptedValue, metadataHash, minValue, maxValue, nonce, inputProof);
        lastEntryIds[msg.sender] = ciphertextId;
        emit EnergyEntryAdded(msg.sender, ciphertextId, _fheCiphertextHash(ciphertextId), encryptedValue.length);
    }

    // Restituisce il numero di energy entry di un determinato utente
    function getEntryCount() external view returns (uint256) {
        return lastEntryIds[msg.sender] == 0 ? 0 : 1;
    }

    // Restituisce l'ultima energy entry relativa a un certo utente
    function getLastEntryValue() external view returns (bytes memory) {
        return _fheCiphertextBytes(_requireLastEntryId(msg.sender));
    }

    // Restituisce il totale energetico cifrato relativo a un certo utente
    function getEncryptedTotal() external view returns (bytes memory) {
        return _fheCiphertextBytes(_requireEncryptedTotalId(msg.sender));
    }

    // Restituisce l'ultimo risultato omomorfico relativo a un certo utente
    function getLastResult() external view returns (bytes memory) {
        return _fheCiphertextBytes(_requireLastResultId(msg.sender));
    }

    // Restituisce informazioni dello storage relative all'ultima entry energetica
    function getLastEntryCiphertextStorage()
        external
        view
        returns (address manifest, uint256 ciphertextLength, uint256 chunkCount, bytes32 contentHash)
    {
        return getFheCiphertextStorage(_requireLastEntryId(msg.sender));
    }

    // Restituisce informazioni dello storage relative al totale cifrato
    function getEncryptedTotalCiphertextStorage()
        external
        view
        returns (address manifest, uint256 ciphertextLength, uint256 chunkCount, bytes32 contentHash)
    {
        return getFheCiphertextStorage(_requireEncryptedTotalId(msg.sender));
    }

    // Restituisce informazioni dello storage relative all'ultimo risultato omomorfico
    function getLastResultCiphertextStorage()
        external
        view
        returns (address manifest, uint256 ciphertextLength, uint256 chunkCount, bytes32 contentHash)
    {
        return getFheCiphertextStorage(_requireLastResultId(msg.sender));
    }

    function previewAddLastEntryToEncryptedTotal() external view returns (bytes memory) {
        (bytes memory lastEntry, bytes memory encryptedTotal,) = _lastEntryAndTotal(msg.sender);
        return FhePrecompile.addU32At(_fhePrecompile(), encryptedTotal, lastEntry);
    }

    // Aggiunge l'ultima entry energetica al totale energetico relativo a un utente (senza operationProof)
    function addLastEntryToEncryptedTotal() external returns (bytes memory output) {
        (bytes memory lastEntry, bytes memory encryptedTotal, bytes32 inputSetHash) = _lastEntryAndTotal(msg.sender);
        
        output = FhePrecompile.addU32At(_fhePrecompile(), encryptedTotal, lastEntry);
        uint256 operationId = _storeFheOperation(OperationKind.Add, msg.sender, output, inputSetHash);

        encryptedTotalIds[msg.sender] = _fheOperationResultCiphertextId(operationId);
        _emitResult(OperationKind.Add, encryptedTotalIds[msg.sender], output.length);
    }

    // Aggiunge l'ultima entry energetica al totale energetico relativo a un utente (con operationProof)
    function addLastEntryToEncryptedTotalProof(
        bytes calldata output,
        bytes32 nonce,
        bytes calldata operationProof
    ) external returns (bytes memory) {
        bytes32 inputSetHash = _lastEntryAndTotalHash(msg.sender);
        (uint256 operationId,) =
            _storeFheOperationWithProof(OperationKind.Add, msg.sender, output, inputSetHash, bytes32(0), nonce, operationProof);
        encryptedTotalIds[msg.sender] = _fheOperationResultCiphertextId(operationId);
        _emitResult(OperationKind.Add, encryptedTotalIds[msg.sender], output.length);
        return output;
    }

    function previewMultiplyLastEntryByConstant(uint64 scalar) external view returns (bytes memory) {
        return FhePrecompile.mulScalarU32At(_fhePrecompile(), _fheCiphertextBytes(_requireLastEntryId(msg.sender)), scalar);
    }
    
    // Moltiplica l'ultima entry energetica con un valore scalare (senza operationProof)
    function multiplyLastEntryByConstant(uint64 scalar) external returns (bytes memory output) {
        uint256 lastEntryId = _requireLastEntryId(msg.sender);
        output = FhePrecompile.mulScalarU32At(_fhePrecompile(), _fheCiphertextBytes(lastEntryId), scalar);

        bytes32 inputSetHash = _fheScalarInputHash(lastEntryId, msg.sender, scalar);
        uint256 operationId = _storeFheOperation(OperationKind.MulScalar, msg.sender, output, inputSetHash);

        lastResultIds[msg.sender] = _fheOperationResultCiphertextId(operationId);
        _emitResult(OperationKind.MulScalar, lastResultIds[msg.sender], output.length);
    }

    // Moltiplica l'ultima entry energetica con un valore scalare (con operationProof)
    function multiplyLastEntryByConstantProof(
        uint64 scalar,
        bytes calldata output,
        bytes32 nonce,
        bytes calldata operationProof
    ) external returns (bytes memory) {
        uint256 lastEntryId = _requireLastEntryId(msg.sender);
        bytes32 inputSetHash = _fheScalarInputHash(lastEntryId, msg.sender, scalar);

        (uint256 operationId,) = _storeFheOperationWithProof(
            OperationKind.MulScalar,
            msg.sender,
            output,
            inputSetHash,
            bytes32(0),
            nonce,
            operationProof
        );

        lastResultIds[msg.sender] = _fheOperationResultCiphertextId(operationId);
        _emitResult(OperationKind.MulScalar, lastResultIds[msg.sender], output.length);
        return output;
    }

    function previewMeanLastEntryAndEncryptedTotal() external view returns (bytes memory) {
        bytes[] memory operands = _lastEntryAndTotalOperands(msg.sender);
        return FhePrecompile.meanU32At(_fhePrecompile(), operands);
    }

    // Moltiplica l'ultima entry energetica con un valore scalare (con operationProof)
    function meanLastEntryAndEncryptedTotal() external returns (bytes memory output) {
        bytes[] memory operands = _lastEntryAndTotalOperands(msg.sender);
        output = FhePrecompile.meanU32At(_fhePrecompile(), operands);

        uint256 operationId = _storeFheOperation(OperationKind.Mean, msg.sender, output, _lastEntryAndTotalHash(msg.sender));
        lastResultIds[msg.sender] = _fheOperationResultCiphertextId(operationId);

        _emitResult(OperationKind.Mean, lastResultIds[msg.sender], output.length);
    }

    function previewMaxLastEntryAndEncryptedTotal() external view returns (bytes memory) {
        bytes[] memory operands = _lastEntryAndTotalOperands(msg.sender);
        return FhePrecompile.maxU32At(_fhePrecompile(), operands);
    }

    // Ottiene tutte le entry energetiche relative a un utente e ne restituisce il massimo (senza operationProof)
    function maxLastEntryAndEncryptedTotal() external returns (bytes memory output) {
        bytes[] memory operands = _lastEntryAndTotalOperands(msg.sender);
        output = FhePrecompile.maxU32At(_fhePrecompile(), operands);

        uint256 operationId = _storeFheOperation(OperationKind.Max, msg.sender, output, _lastEntryAndTotalHash(msg.sender));
        lastResultIds[msg.sender] = _fheOperationResultCiphertextId(operationId);

        _emitResult(OperationKind.Max, lastResultIds[msg.sender], output.length);
    }

    // Ottiene tutte le entry energetiche relative a un utente e ne restituisce il massimo (con operationProof)
    function maxLastEntryAndEncryptedTotalProof(
        bytes calldata output,
        bytes32 nonce,
        bytes calldata operationProof
    ) external returns (bytes memory) {
        return _storeProofBackedLastEntryAndTotal(OperationKind.Max, output, nonce, operationProof);
    }

    // Ottiene tutte le entry energetiche relative a un utente, il loro numero e ne restituisce la media (con inputProof)
    function meanLastEntryAndEncryptedTotalProof(
        bytes calldata output,
        bytes32 nonce,
        bytes calldata operationProof
    ) external returns (bytes memory) {
        return _storeProofBackedLastEntryAndTotal(OperationKind.Mean, output, nonce, operationProof);
    }
    
    // Inizializza la variabile di EncryptedTotal, così che possa essere sommata a futuri ciphertext
    function initializeEncryptedTotal(
        bytes calldata encryptedInitialTotal,
        bytes32 metadataHash,
        uint256 minValue,
        uint256 maxValue,
        bytes32 nonce,
        bytes calldata inputProof
    ) external returns (uint256 ciphertextId) {
        (ciphertextId,) = _storeFheCiphertextWithInputProof(
            msg.sender,
            encryptedInitialTotal,
            metadataHash,
            minValue,
            maxValue,
            nonce,
            inputProof
        );
        encryptedTotalIds[msg.sender] = ciphertextId;
        emit EncryptedTotalInitialized(
            msg.sender,
            ciphertextId,
            _fheCiphertextHash(ciphertextId),
            encryptedInitialTotal.length
        );
    }

    // Restituisce l'ultima entry energetica e il totale energetico cifrato
    function _lastEntryAndTotal(address owner)
        private
        view
        returns (bytes memory lastEntry, bytes memory encryptedTotal, bytes32 inputSetHash)
    {
        uint256 lastEntryId = _requireLastEntryId(owner);
        uint256 encryptedTotalId = _requireEncryptedTotalId(owner);

        lastEntry = _fheCiphertextBytes(lastEntryId);
        encryptedTotal = _fheCiphertextBytes(encryptedTotalId);

        inputSetHash = _lastEntryAndTotalHash(owner);
    }

    // Restituisce l'ultima entry energetica e il totale energetico cifrato (come operandi)
    function _lastEntryAndTotalOperands(address owner) private view returns (bytes[] memory operands) {
        (bytes memory lastEntry, bytes memory encryptedTotal,) = _lastEntryAndTotal(owner);
        operands = new bytes[](2);
        operands[0] = lastEntry;
        operands[1] = encryptedTotal;
    }

    // Restituisce l'ultima entry energetica e l'hash del totale energetico
    function _lastEntryAndTotalHash(address owner) private view returns (bytes32) {
        uint256 lastEntryId = _requireLastEntryId(owner);
        uint256 encryptedTotalId = _requireEncryptedTotalId(owner);
        return keccak256(abi.encode(_fheCiphertextHash(lastEntryId), _fheCiphertextHash(encryptedTotalId)));
    }

    // Emette l'evento relativo all'esecuzione di un'operazione omomorfica, indicandone i riferimenti
    function _emitResult(OperationKind kind, uint256 resultCiphertextId, uint256 ciphertextLength) private {
        emit EnergyOperationExecuted(
            msg.sender,
            kind,
            resultCiphertextId,
            _fheCiphertextHash(resultCiphertextId),
            ciphertextLength
        );
    }

    // Registrazione dell'ultima entry energetica e del totale (fornendo una operationProof)
    function _storeProofBackedLastEntryAndTotal(
        OperationKind kind,
        bytes calldata output,
        bytes32 nonce,
        bytes calldata operationProof
    ) private returns (bytes memory) {
        bytes32 inputSetHash = _lastEntryAndTotalHash(msg.sender);
        (uint256 operationId,) =
            _storeFheOperationWithProof(kind, msg.sender, output, inputSetHash, bytes32(0), nonce, operationProof);

        uint256 resultCiphertextId = _fheOperationResultCiphertextId(operationId);
        lastResultIds[msg.sender] = resultCiphertextId;

        _emitResult(kind, resultCiphertextId, output.length);
        return output;
    }

    function _requireLastEntryId(address owner) private view returns (uint256 ciphertextId) {
        ciphertextId = lastEntryIds[owner];
        if (ciphertextId == 0) revert MissingLastEntry(owner);
    }

    function _requireEncryptedTotalId(address owner) private view returns (uint256 ciphertextId) {
        ciphertextId = encryptedTotalIds[owner];
        if (ciphertextId == 0) revert MissingEncryptedTotal(owner);
    }

    function _requireLastResultId(address owner) private view returns (uint256 ciphertextId) {
        ciphertextId = lastResultIds[owner];
        if (ciphertextId == 0) revert MissingLastResult(owner);
    }

    function _fhePrecompile() internal view virtual returns (address) {
        return FhePrecompile.precompileAddress();
    }
}
