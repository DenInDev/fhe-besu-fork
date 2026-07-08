# Diagnostic consensus note

Questo benchmark e' stato eseguito in modalita' `mock-input-proof-consensus-safe` su rete Besu locale a 4 validatori QBFT.

Le operazioni `notarize`, `add_view`, `add`, `mul_scalar` e `decrypt` sono state completate per 10 run mantenendo i nodi allineati.

Durante i tentativi precedenti di benchmark completo, l'operazione `meanLastEntryAndEncryptedTotal` ha prodotto `receipts root mismatch` sulla rete a 4 validatori. La transazione osservata aveva selector `0xa048a2eb`, corrispondente a `meanLastEntryAndEncryptedTotal()`. Per questo motivo `mean` e `max` sono state escluse dalla tabella finale: includerle avrebbe reso il benchmark non valido come misura su una chain permissioned con consenso reale.

Interpretazione: le primitive TFHE che richiedono PBS/confronto/divisione non sono ancora consensus-safe nella versione corrente del backend BesuFHE. Le operazioni basate su storage, notarizzazione, addizione raw e moltiplicazione scalare per addizioni ripetute sono invece misurabili senza causare divergenza dei validatori.
