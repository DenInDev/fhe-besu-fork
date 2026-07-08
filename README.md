# BesuFHE

BesuFHE è un prototipo di ricerca per eseguire operazioni omomorfiche dentro
una chain EVM permissioned basata su Hyperledger Besu modificato. Il progetto
usa una precompile nativa all'indirizzo `0x100`, collegata a un backend
TFHE-rs, e mantiene i ciphertext completi nello stato on-chain.

## Flusso di di Registrazione/Notarizzazione di Ciphertext

Il repository presenta come flusso di registrazione dei ciphertext:

1. l'utente cifra localmente un valore energetico con `tfhe_tool`;
2. viene prodotta una input validation proof ZK tramite Noir/Barretenberg;
3. `EnergyDataNotaryOnChain` verifica la proof tramite `IInputProofVerifier`;
4. il ciphertext completo viene salvato on-chain tramite code storage;
5. le operazioni FHE possono essere eseguite nativamente dalla precompile Besu
   `0x100` oppure prodotte off-chain e accettate on-chain tramite operation
   proof leggera;
6. nel flusso principale di benchmark, `add`, `mulScalar`, `mean` e `max`
   salvano risultati proof-backed come nuovi ciphertext on-chain;
7. il possessore della client key recupera e decifra localmente gli output.

Gli output ricreabili vengono generati sotto directory ignorate da Git
(`artifacts/`, `cache/`, `typechain-types/`, `runtime/`, `proof/noir/**/target/`).

## Struttura

```text
besu/          Fork/wrapper Besu e rete QBFT locale autosufficiente.
contracts/     Contratti Solidity, middleware BesuFHE e adapter input proof.
native/        Backend Rust TFHE-rs, JNI e tool locale di cifratura/decifratura.
proof/         Circuito Noir per la validazione ZK degli input energetici.
scripts/       Deploy, interazione e build delle proof.
test/          Test Hardhat con mock della precompile e del verifier Noir.
runtime/       Solo output locali ricreati dagli script; non e' sorgente.
```

File principali:

- `contracts/EnergyDataNotaryOnChain.sol`: contratto benchmark per l'uso
  energetico;
- `contracts/protocol/BesuFHEProtocol.sol`: configurazione del verifier input
  proof e digest canonico;
- `contracts/protocol/BesuFHEInputProof.sol`: replay resistance e storage degli
  input verificati;
- `contracts/protocol/BesuFHEOperationProof.sol`: replay resistance e verifica
  delle operation proof leggere;
- `contracts/protocol/BesuFHEMiddleware.sol`: registrazione generica di
  ciphertext e risultati FHE on-chain;
- `contracts/lib/FhePrecompile.sol`: ABI codec verso la precompile `0x100`;
- `contracts/lib/OnChainCiphertext.sol`: salvataggio dei ciphertext in code
  chunks;
- `contracts/proof/NoirEnergyInputVerifierAdapter.sol`: adapter tra il notary e
  il verifier Solidity generato da Noir/Barretenberg;
- `contracts/proof/NoirOperationProofVerifierAdapter.sol`: adapter ZK per le
  operation proof del coprocessore;
- `native/src/tfhe_backend.rs`: backend reale TFHE-rs;
- `scripts/interact/energy-notary-benchmark.ts`: workflow end-to-end pulito.

## Requisiti
- Windows con WSL2 o Distro Linux.
- Node.js `20.x` e npm `10+`.
- Rust/Cargo in WSL.
- Java compatibile con la build Besu.
- `nargo` e `bb` per produrre/verificare le proof Noir.
- Rete BesuFHE locale inclusa in `besu/network`.

Installazione dipendenze Node:

```bash
npm install
```

## Build

Per compilare il backend nativo TFHE-rs:

```bash
npm run build:native
```

Output ricreati:

```text
runtime/native/libbesu_fhe_native.so
runtime/native/tfhe_tool
```

Per compilare il fork Besu:

```bash
npm run build:besu
```

Output ricreato:

```text
runtime/besu/
```

Per compilare i contratti:

```bash
npm run compile
```

## Proof ZK di input

Il circuito Noir è intenzionalmente piccolo. Prova che:

```text
plaintext in [minValue, maxValue]
metadataHash = Poseidon(plaintext, salt, owner, ciphertextHashHi, ciphertextHashLo)
```

Per garantire la confidenzialità, il contratto non vede il plaintext. 
On-chain vengono verificati:

- proof Barretenberg/Noir;
- public input del circuito;
- binding con `chainId`, indirizzo del notary, owner, hash del ciphertext,
  range, metadata hash e nonce.

Build del circuito e del verifier Solidity generato:

```bash
npm run proof:build:energy-input
npm run compile
```

Deploy separato del verifier generato:

```bash
npm run deploy:besu:noir-input-verifier
```

Deploy dell'adapter, se il verifier generato e' gia' noto:

```bash
FHEBC_NOIR_INPUT_VERIFIER_ADDRESS=0x... npm run deploy:besu:input-adapter
```

## Operation ZK-Proof leggere

La verifica completa della semantica TFHE dentro una prova ZK è possibile in
linea teorica (vedere RISC-0, https://risczero.com/), ma troppo costosa per un setup scalabile. 
Per questo il main case usa una operation proof ZK Noir leggera, legata al digest canonico
dell'operazione:

```text
digest = H(chainId, notary, owner, operation, inputSetHash,
           resultCiphertextHash, resultMetadataHash, nonce)
```

Il circuito prova conoscenza di un segreto di un nodo trusted associato a una
commitment pubblica autorizzata:

```text
authorityCommitment = Poseidon(secret)
attestationHash    = Poseidon(secret, digestHi, digestLo)
```
Questo passaggio, purtroppo, richiede che il segreto sia associato a un nodo o un'autorità trusted.
In futuro, si esploreranno metodi più trasparenti e efficienti per la generazione di proof complete di computazione.

Il contratto verifica la proof tramite `NoirOperationProofVerifierAdapter`, senza
vedere il secret del coprocessore. Questa resta una prova ZK di autorizzazione e
binding al digest.

## Deploy

Deploy del contratto sperimentale su Besu:

```bash
npm run deploy:besu
```

Lo script richiede un verifier ZK reale o lo genera dagli artifact Noir se sono
presenti. Le opzioni principali sono:

```bash
FHEBC_INPUT_PROOF_VERIFIER_ADDRESS=0x... npm run deploy:besu
```

oppure:

```bash
FHEBC_NOIR_INPUT_VERIFIER_ADDRESS=0x... npm run deploy:besu
```

Per le operation proof ZK Noir:

```bash
npm run proof:build:operation-authority
npm run compile
FHEBC_OPERATION_ZK_AUTHORITY_COMMITMENT=0x... \
npm run deploy:besu
```

La proof per una specifica operazione può essere prodotta con:

```bash
FHEBC_OPERATION_ZK_SECRET=12345 \
npm run proof:prove:operation-authority -- runtime/proof-contexts/operation.json
```

Lo script di benchmark usa automaticamente il prover Noir se
`FHEBC_OPERATION_ZK_SECRET` e' configurato.

Il manifest viene scritto in:

```text
runtime/deployments/fhebc-besu.local.json
```

## Avvio Besu modificato

Se serve riallineare i parametri del genesis interno per i benchmark:

```bash
npm run configure:besu
```

Avvio:

```bash
npm run start:besu
```

Stop:

```bash
npm run stop:besu
```

Lo script di start usa il binario generato in `runtime/besu`, la libreria nativa
in `runtime/native`, la server key in `runtime/keys/server.key` e la rete
locale contenuta in `besu/network`.

## Interazione End-to-End dell'Architettura

Esecuzione del workflow completo:

```bash
npm run interact:besu
```

Lo script:
1. controlla che la precompile `0x100` risponda;
2. genera le chiavi TFHE se non esistono;
3. cifra un valore iniziale e una entry energetica;
4. genera le input proof Noir;
5. deploya o aggancia il notary;
6. chiama `initializeEncryptedTotal` e `addEnergyEntry`;
7. produce off-chain i ciphertext risultato per `add`, `mulScalar`, `mean`,
   `max`, firma le operation proof e invia le transazioni proof-backed;
8. legge i ciphertext on-chain;
9. decifra localmente i risultati;
10. salva un report JSON in `runtime/runs/`.

Variabili utili:

```bash
FHEBC_NOTARY_ADDRESS=0x...          # usa un contratto esistente
FHEBC_DEPLOYMENT_MANIFEST=...       # usa il manifest di deploy
FHEBC_INITIAL_TOTAL=10
FHEBC_ENTRY_VALUE=42
FHEBC_SCALAR=3
FHEBC_BESU_RPC_URL=http://localhost:8545
FHEBC_BESU_CHAIN_ID=1337
FHEBC_ZK_PROOF_COMMAND="node scripts/proof/prove-energy-input-noir.js"
FHEBC_OPERATION_ZK_SECRET=12345
```

## Contratto per Caso d'Uso (Energy Context)

`EnergyDataNotaryOnChain` prevede come operazioni:
- `initializeEncryptedTotal(...)`;
- `addEnergyEntry(...)`;
- `getEntryCount()`;
- `getLastEntryValue()`;
- `getEncryptedTotal()`;
- `getLastResult()`;
- `previewAddLastEntryToEncryptedTotal()`;
- `addLastEntryToEncryptedTotal()`;
- `addLastEntryToEncryptedTotalProof(bytes,bytes32,bytes)`;
- `previewMultiplyLastEntryByConstant(uint64)`;
- `multiplyLastEntryByConstant(uint64)`;
- `multiplyLastEntryByConstantProof(uint64,bytes,bytes32,bytes)`;
- `previewMeanLastEntryAndEncryptedTotal()`;
- `meanLastEntryAndEncryptedTotal()`;
- `meanLastEntryAndEncryptedTotalProof(bytes,bytes32,bytes)`;
- `previewMaxLastEntryAndEncryptedTotal()`;
- `maxLastEntryAndEncryptedTotal()`;
- `maxLastEntryAndEncryptedTotalProof(bytes,bytes32,bytes)`.

## Storage Ciphertext

I ciphertext vengono salvati interamente on-chain:
1. il payload viene spezzato in chunk;
2. ogni chunk viene deployato come bytecode immutabile;
3. un manifest conserva ordine e indirizzi;
4. il notary conserva manifest, lunghezza, numero di chunk e content hash;
5. letture e precompile ricostruiscono i bytes con `EXTCODECOPY`.

Questa scelta rende la disponibilità del ciphertext una proprietà dello stato
della chain, al prezzo di costi on-chain più alti (ma gestibili per una chain permissioned).

## Verifica Locale

```bash
npm run compile
npm run typecheck
npm test
```

Sanity Test della Precompile con Besu già avviato:

```bash
npm run smoke:besu:precompile
```

Backend Rust:

```bash
cd native
cargo check
```
