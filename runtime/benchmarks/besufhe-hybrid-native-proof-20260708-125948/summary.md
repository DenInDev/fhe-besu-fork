# Benchmark BesuFHE

Modalita': mock-input-proof-native-linear-proof-backed-aggregates
Gas price: 1000 wei

| Operazione | n | Gas medio | Latenza media (ms) | Dev. std latenza (%) |
|---|---:|---:|---:|---:|
| notarize | 10 | 989.271 | 6538 | 178,92 |
| decrypt | 10 | 0 | 2796 | 5,15 |
| add_view | 10 | 0 | 230 | 7,89 |
| add | 10 | 7.023.897 | 4390 | 199,44 |
| mul_scalar | 10 | 8.928.178 | 1712 | 14,46 |
| mean_view | 10 | 0 | 629 | 5,34 |
| mean | 10 | 3.086.338 | 8853 | 144,84 |
| max_view | 10 | 0 | 621 | 4,49 |
| max | 10 | 3.086.511 | 3213 | 239,66 |

Nota: il benchmark usa `MockNoirProofVerifier` come input-proof verifier. `add` e `mul_scalar` restano native; `mean` e `max` usano il flusso proof-backed leggero. Non misura il costo gas di un verifier Noir/Groth16 reale.
