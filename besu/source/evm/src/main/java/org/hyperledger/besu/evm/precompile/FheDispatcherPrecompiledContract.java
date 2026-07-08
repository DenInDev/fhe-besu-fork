/*
 * Copyright Hyperledger Besu Contributors.
 *
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with
 * the License. You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on
 * an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations under the License.
 *
 * SPDX-License-Identifier: Apache-2.0
 */
package org.hyperledger.besu.evm.precompile;

import org.hyperledger.besu.evm.frame.MessageFrame;
import org.hyperledger.besu.evm.gascalculator.GasCalculator;

import javax.annotation.Nonnull;

import org.apache.tuweni.bytes.Bytes;

/** Native TFHE-rs dispatcher precompile for local FHEBC Besu experiments. */
public final class FheDispatcherPrecompiledContract extends AbstractPrecompiledContract {

  public FheDispatcherPrecompiledContract(final GasCalculator gasCalculator) {
    super("FHEBC_TFHE_DISPATCHER", gasCalculator);
  }

  @Override
  public long gasRequirement(final Bytes input) {
    try {
      final FheRequest request = FheCodec.decodeRequest(input.toArrayUnsafe());
      return switch (request.operation()) {
        case FheConstants.OP_ADD -> 4_000_000L;
        case FheConstants.OP_SUB -> 4_000_000L;
        case FheConstants.OP_MUL_SCALAR -> 6_000_000L;
        case FheConstants.OP_EQ -> 12_000_000L;
        case FheConstants.OP_LT -> 18_000_000L;
        case FheConstants.OP_SELECT -> 12_000_000L;
        case FheConstants.OP_MEAN -> 6_000_000L + 2_000_000L * request.operands().size();
        case FheConstants.OP_MAX -> 14_000_000L + 4_000_000L * request.operands().size();
        default -> 1_000_000L;
      };
    } catch (RuntimeException ignored) {
      return 1_000_000L;
    }
  }

  @Nonnull
  @Override
  public PrecompileContractResult computePrecompile(
      final Bytes input, @Nonnull final MessageFrame messageFrame) {
    try {
      final byte[] canonicalRequest = input.toArrayUnsafe();
      final FheRequest request = FheCodec.decodeRequest(canonicalRequest);
      validateRequest(request);
      return PrecompileContractResult.success(Bytes.wrap(TfheNative.dispatch(canonicalRequest)));
    } catch (final FhePrecompileException exception) {
      return PrecompileContractResult.success(Bytes.wrap(FheCodec.encodeError(exception.status())));
    } catch (final Throwable throwable) {
      return PrecompileContractResult.success(
          Bytes.wrap(FheCodec.encodeError(FheConstants.STATUS_INTERNAL_ERROR)));
    }
  }

  private static void validateRequest(final FheRequest request) {
    if (request.parameterSet() != FheConstants.PARAM_TFHE_UINT32_V1) {
      throw new FhePrecompileException(FheConstants.STATUS_PARAMETER_SET_MISMATCH);
    }
    if (request.inputType() != FheConstants.TYPE_EUINT32) {
      throw new FhePrecompileException(FheConstants.STATUS_UNSUPPORTED_OPERATION);
    }

    final int operandCount = request.operands().size();
    switch (request.operation()) {
      case FheConstants.OP_ADD,
          FheConstants.OP_SUB,
          FheConstants.OP_EQ,
          FheConstants.OP_LT -> requireOperandCount(operandCount, 2);
      case FheConstants.OP_MUL_SCALAR -> requireOperandCount(operandCount, 2);
      case FheConstants.OP_SELECT -> requireOperandCount(operandCount, 3);
      case FheConstants.OP_MEAN, FheConstants.OP_MAX -> {
        if (operandCount == 0) {
          throw new FhePrecompileException(FheConstants.STATUS_INVALID_ENCODING);
        }
      }
      default -> throw new FhePrecompileException(FheConstants.STATUS_UNSUPPORTED_OPERATION);
    }
  }

  private static void requireOperandCount(final int actual, final int expected) {
    if (actual != expected) {
      throw new FhePrecompileException(FheConstants.STATUS_INVALID_ENCODING);
    }
  }
}
