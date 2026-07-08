# Benchmark BesuFHE

Modalita': mock-input-proof-native-linear-mock-zk-operation-proof-aggregates
Gas price: 1000 wei

| Operazione | n | Gas medio | Latenza media (ms) | Dev. std latenza (%) |
|---|---:|---:|---:|---:|
| notarize | 10 | 989.267 | 885 | 27,74 |
| decrypt | 10 | 0 | 1456 | 3,29 |
| add_view | 10 | 0 | 404 | 6,53 |
| add | 10 | 7.023.897 | 18.488 | 78,28 |
| mul_scalar | 10 | 8.928.178 | 12.123 | 116,30 |
| mean_view | 10 | 0 | 1431 | 3,07 |
| mean | 10 | 3.107.553 | 895 | 27,61 |
| max_view | 10 | 0 | 1901 | 1,05 |
| max | 10 | 3.107.684 | 9314 | 286,61 |

Nota: il benchmark usa `MockNoirProofVerifier` come input-proof verifier. `add` e `mul_scalar` restano native; `mean` e `max` usano il flusso proof-backed ZK/Noir. In modalita' `mock-operation-proof`, l'adapter Noir e' reale ma il verifier Noir e' mocked per rendere il benchmark comparabile e ripetibile.
