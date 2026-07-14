// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Gestore Solidity per transazioni FHE su Besu (indirizzo FHE_PRECOMPILE).
library FhePrecompile {
    address internal constant FHE_PRECOMPILE = 0x0000000000000000000000000000000000000100;

    uint8 internal constant VERSION = 1;
    uint8 internal constant VERSION_STORED = 2;

    uint8 internal constant STATUS_OK = 0;

    uint8 internal constant OP_ADD = 1;
    uint8 internal constant OP_SUB = 2;
    uint8 internal constant OP_MUL_SCALAR = 3;
    uint8 internal constant OP_EQ = 4;
    uint8 internal constant OP_LT = 5;
    uint8 internal constant OP_SELECT = 6;
    uint8 internal constant OP_MEAN = 7;
    uint8 internal constant OP_MAX = 8;

    uint8 internal constant TYPE_EBOOL = 1;
    uint8 internal constant TYPE_EUINT8 = 2;
    uint8 internal constant TYPE_EUINT16 = 3;
    uint8 internal constant TYPE_EUINT32 = 4;

    uint16 internal constant PARAM_TFHE_UINT32_V1 = 1;

    struct BlobRef {
        address manifest;
        uint32 length;
        uint16 chunkCount;
        bytes32 contentHash;
    }

    error FheOperationFailed(bytes returnData);
    error FheMalformedOutput();
    error FhePrecompileError(uint8 status);
    error FheUnexpectedOutputType(uint8 expected, uint8 actual);
    error FheUnexpectedParameterSet(uint16 expected, uint16 actual);

    function precompileAddress() internal pure returns (address) {
        return FHE_PRECOMPILE;
    }

    function addU32(bytes memory lhs, bytes memory rhs) internal view returns (bytes memory) {
        return addU32At(FHE_PRECOMPILE, lhs, rhs);
    }

    function addU32At(address target, bytes memory lhs, bytes memory rhs) internal view returns (bytes memory) {
        bytes[] memory operands = _two(lhs, rhs);
        return _call(target, OP_ADD, TYPE_EUINT32, TYPE_EUINT32, PARAM_TFHE_UINT32_V1, operands);
    }

    function addStoredU32At(address target, BlobRef memory lhs, BlobRef memory rhs)
        internal
        returns (BlobRef memory)
    {
        BlobRef[] memory operands = new BlobRef[](2);
        operands[0] = lhs;
        operands[1] = rhs;
        return _callStored(target, OP_ADD, TYPE_EUINT32, TYPE_EUINT32, PARAM_TFHE_UINT32_V1, operands, "");
    }

    function subU32(bytes memory lhs, bytes memory rhs) internal view returns (bytes memory) {
        return subU32At(FHE_PRECOMPILE, lhs, rhs);
    }

    function subU32At(address target, bytes memory lhs, bytes memory rhs) internal view returns (bytes memory) {
        bytes[] memory operands = _two(lhs, rhs);
        return _call(target, OP_SUB, TYPE_EUINT32, TYPE_EUINT32, PARAM_TFHE_UINT32_V1, operands);
    }

    function mulScalarU32(bytes memory ciphertext, uint64 scalar) internal view returns (bytes memory) {
        return mulScalarU32At(FHE_PRECOMPILE, ciphertext, scalar);
    }

    function mulScalarU32At(address target, bytes memory ciphertext, uint64 scalar) internal view returns (bytes memory) {
        bytes[] memory operands = _two(ciphertext, abi.encodePacked(scalar));
        return _call(target, OP_MUL_SCALAR, TYPE_EUINT32, TYPE_EUINT32, PARAM_TFHE_UINT32_V1, operands);
    }

    function mulScalarStoredU32At(address target, BlobRef memory ciphertext, uint64 scalar)
        internal
        returns (BlobRef memory)
    {
        BlobRef[] memory operands = new BlobRef[](1);
        operands[0] = ciphertext;
        return _callStored(
            target,
            OP_MUL_SCALAR,
            TYPE_EUINT32,
            TYPE_EUINT32,
            PARAM_TFHE_UINT32_V1,
            operands,
            abi.encodePacked(scalar)
        );
    }

    function eqU32(bytes memory lhs, bytes memory rhs) internal view returns (bytes memory) {
        return eqU32At(FHE_PRECOMPILE, lhs, rhs);
    }

    function eqU32At(address target, bytes memory lhs, bytes memory rhs) internal view returns (bytes memory) {
        bytes[] memory operands = _two(lhs, rhs);
        return _call(target, OP_EQ, TYPE_EUINT32, TYPE_EBOOL, PARAM_TFHE_UINT32_V1, operands);
    }

    function ltU32(bytes memory lhs, bytes memory rhs) internal view returns (bytes memory) {
        return ltU32At(FHE_PRECOMPILE, lhs, rhs);
    }

    function ltU32At(address target, bytes memory lhs, bytes memory rhs) internal view returns (bytes memory) {
        bytes[] memory operands = _two(lhs, rhs);
        return _call(target, OP_LT, TYPE_EUINT32, TYPE_EBOOL, PARAM_TFHE_UINT32_V1, operands);
    }

    function selectU32(bytes memory encryptedCondition, bytes memory whenTrue, bytes memory whenFalse)
        internal
        view
        returns (bytes memory)
    {
        return selectU32At(FHE_PRECOMPILE, encryptedCondition, whenTrue, whenFalse);
    }

    function selectU32At(address target, bytes memory encryptedCondition, bytes memory whenTrue, bytes memory whenFalse)
        internal
        view
        returns (bytes memory)
    {
        bytes[] memory operands = new bytes[](3);
        operands[0] = encryptedCondition;
        operands[1] = whenTrue;
        operands[2] = whenFalse;
        return _call(target, OP_SELECT, TYPE_EUINT32, TYPE_EUINT32, PARAM_TFHE_UINT32_V1, operands);
    }

    function meanU32(bytes[] memory ciphertexts) internal view returns (bytes memory) {
        return meanU32At(FHE_PRECOMPILE, ciphertexts);
    }

    function meanU32At(address target, bytes[] memory ciphertexts) internal view returns (bytes memory) {
        return _call(target, OP_MEAN, TYPE_EUINT32, TYPE_EUINT32, PARAM_TFHE_UINT32_V1, ciphertexts);
    }

    function maxU32(bytes[] memory ciphertexts) internal view returns (bytes memory) {
        return maxU32At(FHE_PRECOMPILE, ciphertexts);
    }

    function maxU32At(address target, bytes[] memory ciphertexts) internal view returns (bytes memory) {
        return _call(target, OP_MAX, TYPE_EUINT32, TYPE_EUINT32, PARAM_TFHE_UINT32_V1, ciphertexts);
    }

    function _call(
        address target,
        uint8 operation,
        uint8 inputType,
        uint8 expectedOutputType,
        uint16 parameterSet,
        bytes[] memory operands
    ) private view returns (bytes memory result) {
        bytes memory request = _encodeRequest(operation, inputType, parameterSet, operands);
        (bool success, bytes memory output) = target.staticcall(request);
        if (!success) {
            revert FheOperationFailed(output);
        }
        return _decodeResponse(output, expectedOutputType, parameterSet);
    }

    function _callStored(
        address target,
        uint8 operation,
        uint8 inputType,
        uint8 expectedOutputType,
        uint16 parameterSet,
        BlobRef[] memory operands,
        bytes memory extra
    ) private returns (BlobRef memory result) {
        bytes memory request = _encodeStoredRequest(operation, inputType, parameterSet, operands, extra);
        (bool success, bytes memory output) = target.call(request);
        if (!success) {
            revert FheOperationFailed(output);
        }
        bytes memory payload = _decodeResponse(output, expectedOutputType, parameterSet);
        (address manifest, uint32 length, uint16 chunkCount, bytes32 contentHash) =
            abi.decode(payload, (address, uint32, uint16, bytes32));
        return BlobRef(manifest, length, chunkCount, contentHash);
    }

    function _encodeRequest(uint8 operation, uint8 dataType, uint16 parameterSet, bytes[] memory operands)
        internal
        pure
        returns (bytes memory encoded)
    {
        encoded = abi.encodePacked(VERSION, operation, dataType, parameterSet, uint8(operands.length));
        for (uint256 i = 0; i < operands.length; i++) {
            if (operands[i].length > type(uint32).max) {
                revert FheMalformedOutput();
            }
            encoded = bytes.concat(encoded, abi.encodePacked(uint32(operands[i].length)), operands[i]);
        }
    }

    function _encodeStoredRequest(
        uint8 operation,
        uint8 dataType,
        uint16 parameterSet,
        BlobRef[] memory operands,
        bytes memory extra
    ) private pure returns (bytes memory encoded) {
        encoded = abi.encodePacked(VERSION_STORED, operation, dataType, parameterSet, uint8(operands.length));
        for (uint256 i = 0; i < operands.length; i++) {
            encoded = bytes.concat(
                encoded,
                abi.encodePacked(
                    operands[i].manifest,
                    uint32(operands[i].length),
                    uint16(operands[i].chunkCount),
                    operands[i].contentHash
                )
            );
        }
        encoded = bytes.concat(encoded, extra);
    }

    function _decodeResponse(bytes memory output, uint8 expectedOutputType, uint16 expectedParameterSet)
        internal
        pure
        returns (bytes memory result)
    {
        if (output.length < 8) {
            revert FheMalformedOutput();
        }

        uint8 status = _u8(output, 0);
        if (status != STATUS_OK) {
            revert FhePrecompileError(status);
        }

        uint8 outputType = _u8(output, 1);
        if (outputType != expectedOutputType) {
            revert FheUnexpectedOutputType(expectedOutputType, outputType);
        }

        uint16 parameterSet = _u16(output, 2);
        if (parameterSet != expectedParameterSet) {
            revert FheUnexpectedParameterSet(expectedParameterSet, parameterSet);
        }

        uint32 resultLength = _u32(output, 4);
        if (output.length != 8 + uint256(resultLength)) {
            revert FheMalformedOutput();
        }

        result = _slice(output, 8, resultLength);
    }

    function _two(bytes memory lhs, bytes memory rhs) private pure returns (bytes[] memory operands) {
        operands = new bytes[](2);
        operands[0] = lhs;
        operands[1] = rhs;
    }

    function _slice(bytes memory data, uint256 offset, uint256 length) private pure returns (bytes memory result) {
        result = new bytes(length);
        if (length == 0) {
            return result;
        }

        uint256 src;
        uint256 dest;
        assembly {
            src := add(add(data, 0x20), offset)
            dest := add(result, 0x20)
        }

        for (uint256 i = 0; i < length; i += 32) {
            assembly {
                mstore(add(dest, i), mload(add(src, i)))
            }
        }
    }

    function _u8(bytes memory data, uint256 offset) private pure returns (uint8) {
        return uint8(data[offset]);
    }

    function _u16(bytes memory data, uint256 offset) private pure returns (uint16) {
        return (uint16(uint8(data[offset])) << 8) | uint16(uint8(data[offset + 1]));
    }

    function _u32(bytes memory data, uint256 offset) private pure returns (uint32) {
        return (uint32(uint8(data[offset])) << 24) | (uint32(uint8(data[offset + 1])) << 16)
            | (uint32(uint8(data[offset + 2])) << 8) | uint32(uint8(data[offset + 3]));
    }
}
