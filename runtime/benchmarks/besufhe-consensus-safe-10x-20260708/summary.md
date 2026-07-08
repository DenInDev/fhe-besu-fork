# Benchmark BesuFHE

Modalita': mock-input-proof-consensus-safe
Gas price: 1000 wei

| Operazione | n | Gas medio | Latenza media (ms) | Dev. std latenza (%) |
|---|---:|---:|---:|---:|
| notarize | 10 | 989.255 | 1057 | 1,01 |
| decrypt | 10 | 0 | 2940 | 5,03 |
| add_view | 10 | 0 | 201 | 4,81 |
| add | 10 | 7.023.622 | 4440 | 199,98 |
| mul_scalar | 10 | 8.927.868 | 10.073 | 265,38 |

Nota: il benchmark usa `MockNoirProofVerifier` come input-proof verifier per isolare storage, precompile BesuFHE e costo delle transazioni. Non misura il costo gas di un verifier Noir/Groth16 reale.

Nota consensus-safe: `mean` e `max` non sono incluse perche' nella rete Besu a 4 validatori hanno prodotto `receipts root mismatch`; includerle renderebbe il benchmark non valido.
