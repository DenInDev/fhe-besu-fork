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
import org.apache.tuweni.bytes.MutableBytes;

/**
 * Experimental ZK verifier precompile for BesuFHE.
 *
 * <p>This first implementation is a deterministic development fast path: it validates that calldata
 * is structurally non-empty and returns ABI-encoded true. It is intentionally separated from the
 * Solidity adapter so the backend can later be replaced with a real native Barretenberg verifier
 * without changing application contracts.
 */
public final class ZkVerifierPrecompiledContract extends AbstractPrecompiledContract {

  private static final Bytes ABI_FALSE = abiBool(false);
  private static final Bytes ABI_TRUE = abiBool(true);

  public ZkVerifierPrecompiledContract(final GasCalculator gasCalculator) {
    super("FHEBC_ZK_VERIFIER", gasCalculator);
  }

  @Override
  public long gasRequirement(final Bytes input) {
    return 50_000L + 8L * input.size();
  }

  @Nonnull
  @Override
  public PrecompileContractResult computePrecompile(
      final Bytes input, @Nonnull final MessageFrame messageFrame) {
    if (input == null || input.isEmpty()) {
      return PrecompileContractResult.success(ABI_FALSE);
    }
    return PrecompileContractResult.success(ABI_TRUE);
  }

  private static Bytes abiBool(final boolean value) {
    final MutableBytes encoded = MutableBytes.create(32);
    if (value) {
      encoded.set(31, (byte) 1);
    }
    return encoded;
  }
}
