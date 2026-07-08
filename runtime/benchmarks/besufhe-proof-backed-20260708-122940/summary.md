# Benchmark BesuFHE

Modalita': mock-input-proof-proof-backed
Gas price: 1000 wei

| Operazione | n | Gas medio | Latenza media (ms) | Dev. std latenza (%) |
|---|---:|---:|---:|---:|
| notarize | 10 | 989.260 | 903 | 27,76 |
| decrypt | 10 | 0 | 2708 | 6,88 |
| add_view | 10 | 0 | 230 | 6,35 |
| add | 10 | 3.084.521 | 5682 | 185,54 |
| mul_scalar | 10 | 3.082.636 | 6143 | 185,64 |
| mean_view | 10 | 0 | 670 | 5,80 |
| mean | 10 | 3.086.339 | 3105 | 243,19 |
| max_view | 10 | 0 | 593 | 4,18 |
| max | 10 | 3.086.475 | 3217 | 239,71 |

Nota: il benchmark usa `MockNoirProofVerifier` come input-proof verifier per isolare storage, proof-backed operation flow e costo delle transazioni. Non misura il costo gas di un verifier Noir/Groth16 reale.
