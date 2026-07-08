# Benchmark BesuFHE

Modalita': mock-input-proof-proof-backed-mock-zk-operation-proof-all-ops
Gas price: 1000 wei

| Operazione | n | Gas medio | Latenza media (ms) | Dev. std latenza (%) |
|---|---:|---:|---:|---:|
| notarize | 10 | 989.283 | 1207 | 72,24 |
| decrypt | 10 | 0 | 2820 | 9,59 |
| add_view | 10 | 0 | 791 | 82,42 |
| add | 10 | 3.105.697 | 966 | 22,79 |
| mul_scalar | 10 | 3.103.859 | 912 | 27,62 |
| mean_view | 10 | 0 | 1977 | 4,25 |
| mean | 10 | 3.107.526 | 1270 | 66,74 |
| max_view | 10 | 0 | 2734 | 4,28 |
| max | 10 | 3.107.681 | 912 | 27,29 |

Nota: il benchmark usa `MockNoirProofVerifier` come input-proof verifier. Le tx `add`, `mul_scalar`, `mean` e `max` usano il flusso proof-backed ZK/Noir per evitare output FHE non deterministici tra validator. Le view restano chiamate native alla precompile su un singolo nodo.
