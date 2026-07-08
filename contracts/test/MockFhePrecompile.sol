// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Hardhat-only executable mock for the FHE precompile address 0x100.
/// It understands the same binary request/response envelope as the native Besu
/// precompile, while treating ciphertext bytes as ABI-encoded plaintext values.
contract MockFhePrecompile {
    uint8 private constant VERSION = 1;

    uint8 private constant STATUS_OK = 0;
    uint8 private constant STATUS_INVALID_ENCODING = 1;
    uint8 private constant STATUS_UNSUPPORTED_OPERATION = 4;

    uint8 private constant OP_ADD = 1;
    uint8 private constant OP_SUB = 2;
    uint8 private constant OP_MUL_SCALAR = 3;
    uint8 private constant OP_EQ = 4;
    uint8 private constant OP_LT = 5;
    uint8 private constant OP_SELECT = 6;
    uint8 private constant OP_MEAN = 7;
    uint8 private constant OP_MAX = 8;

    uint8 private constant TYPE_EBOOL = 1;
    uint8 private constant TYPE_EUINT32 = 4;

    uint16 private constant PARAM_TFHE_UINT32_V1 = 1;

    fallback() external payable {
        bytes memory response = _dispatch(msg.data);
        assembly {
            return(add(response, 32), mload(response))
        }
    }

    receive() external payable {
        bytes memory response = _error(STATUS_INVALID_ENCODING);
        assembly {
            return(add(response, 32), mload(response))
        }
    }

    function _dispatch(bytes calldata input) private pure returns (bytes memory) {
        if (input.length < 6 || uint8(input[0]) != VERSION) {
            return _error(STATUS_INVALID_ENCODING);
        }

        uint8 operation = uint8(input[1]);
        uint8 inputType = uint8(input[2]);
        uint16 parameterSet = _u16(input, 3);
        uint8 operandCount = uint8(input[5]);

        if (inputType != TYPE_EUINT32 || parameterSet != PARAM_TFHE_UINT32_V1) {
            return _error(STATUS_INVALID_ENCODING);
        }

        if (operation == OP_ADD) {
            if (operandCount != 2) return _error(STATUS_INVALID_ENCODING);
            return _ok(TYPE_EUINT32, parameterSet, abi.encode(_readU32Operand(input, 0) + _readU32Operand(input, 1)));
        }
        if (operation == OP_SUB) {
            if (operandCount != 2) return _error(STATUS_INVALID_ENCODING);
            return _ok(TYPE_EUINT32, parameterSet, abi.encode(_readU32Operand(input, 0) - _readU32Operand(input, 1)));
        }
        if (operation == OP_MUL_SCALAR) {
            if (operandCount != 2) return _error(STATUS_INVALID_ENCODING);
            return _ok(TYPE_EUINT32, parameterSet, abi.encode(_readU32Operand(input, 0) * uint32(_readU64RawOperand(input, 1))));
        }
        if (operation == OP_EQ) {
            if (operandCount != 2) return _error(STATUS_INVALID_ENCODING);
            return _ok(TYPE_EBOOL, parameterSet, abi.encode(_readU32Operand(input, 0) == _readU32Operand(input, 1)));
        }
        if (operation == OP_LT) {
            if (operandCount != 2) return _error(STATUS_INVALID_ENCODING);
            return _ok(TYPE_EBOOL, parameterSet, abi.encode(_readU32Operand(input, 0) < _readU32Operand(input, 1)));
        }
        if (operation == OP_SELECT) {
            if (operandCount != 3) return _error(STATUS_INVALID_ENCODING);
            bool condition = abi.decode(_operand(input, 0), (bool));
            return _ok(TYPE_EUINT32, parameterSet, condition ? _operand(input, 1) : _operand(input, 2));
        }
        if (operation == OP_MEAN) {
            if (operandCount == 0) return _error(STATUS_INVALID_ENCODING);
            uint256 total = 0;
            for (uint8 i = 0; i < operandCount; i++) {
                total += _readU32Operand(input, i);
            }
            return _ok(TYPE_EUINT32, parameterSet, abi.encode(uint32(total / operandCount)));
        }
        if (operation == OP_MAX) {
            if (operandCount == 0) return _error(STATUS_INVALID_ENCODING);
            uint32 current = _readU32Operand(input, 0);
            for (uint8 i = 1; i < operandCount; i++) {
                uint32 candidate = _readU32Operand(input, i);
                if (candidate > current) {
                    current = candidate;
                }
            }
            return _ok(TYPE_EUINT32, parameterSet, abi.encode(current));
        }

        return _error(STATUS_UNSUPPORTED_OPERATION);
    }

    function _ok(uint8 outputType, uint16 parameterSet, bytes memory result) private pure returns (bytes memory) {
        return abi.encodePacked(STATUS_OK, outputType, parameterSet, uint32(result.length), result);
    }

    function _error(uint8 status) private pure returns (bytes memory) {
        return abi.encodePacked(status, uint8(0), uint16(0), uint32(0));
    }

    function _readU32Operand(bytes calldata input, uint8 index) private pure returns (uint32) {
        return abi.decode(_operand(input, index), (uint32));
    }

    function _readU64RawOperand(bytes calldata input, uint8 index) private pure returns (uint64 value) {
        bytes memory operand = _operand(input, index);
        if (operand.length != 8) {
            revert("invalid scalar operand");
        }
        for (uint256 i = 0; i < 8; i++) {
            value = (value << 8) | uint64(uint8(operand[i]));
        }
    }

    function _operand(bytes calldata input, uint8 wantedIndex) private pure returns (bytes memory value) {
        uint256 offset = 6;
        uint8 operandCount = uint8(input[5]);
        if (wantedIndex >= operandCount) {
            revert("operand out of bounds");
        }

        for (uint8 i = 0; i < operandCount; i++) {
            if (offset + 4 > input.length) {
                revert("malformed operand header");
            }
            uint32 length = _u32(input, offset);
            offset += 4;
            if (offset + length > input.length) {
                revert("malformed operand bytes");
            }
            if (i == wantedIndex) {
                value = new bytes(length);
                for (uint256 j = 0; j < length; j++) {
                    value[j] = input[offset + j];
                }
                return value;
            }
            offset += length;
        }
    }

    function _u16(bytes calldata data, uint256 offset) private pure returns (uint16) {
        return (uint16(uint8(data[offset])) << 8) | uint16(uint8(data[offset + 1]));
    }

    function _u32(bytes calldata data, uint256 offset) private pure returns (uint32) {
        return (uint32(uint8(data[offset])) << 24) | (uint32(uint8(data[offset + 1])) << 16)
            | (uint32(uint8(data[offset + 2])) << 8) | uint32(uint8(data[offset + 3]));
    }
}
