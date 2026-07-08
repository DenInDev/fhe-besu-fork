# Benchmark BesuFHE

Modalita': mock-input-proof
Gas price: 1000 wei

| Operazione | n | Gas medio | Latenza media (ms) | Dev. std latenza (%) |
|---|---:|---:|---:|---:|
| notarize | 1 | 989.274 | 553 | 0,00 |
| decrypt | 1 | 0 | 3713 | 0,00 |
| add_view | 1 | 0 | 268 | 0,00 |
| add | 1 | 7.023.622 | 1572 | 0,00 |
| mul_scalar | 1 | 8.927.868 | 30.876 | 0,00 |
| mean_view | 1 | 0 | 602 | 0,00 |
| mean | 1 | 13.004.755 | 3186 | 0,00 |
| max_view | 1 | 0 | 611 | 0,00 |
| max | 1 | 25.004.304 | 31.441 | 0,00 |

Nota: il benchmark usa `MockNoirProofVerifier` come input-proof verifier per isolare storage, precompile BesuFHE e costo delle transazioni. Non misura il costo gas di un verifier Noir/Groth16 reale.
