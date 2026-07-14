# BesuFHE

BesuFHE è un prototipo di ricerca per eseguire operazioni omomorfiche dentro
una chain EVM permissioned basata su Hyperledger Besu modificato. Il progetto
usa una precompile nativa all'indirizzo `0x100`, collegata a un backend
TFHE-rs, e mantiene i ciphertext completi nello stato on-chain.

## Flusso di di Registrazione/Notarizzazione di Ciphertext

Il repository presenta come flusso di registrazione dei ciphertext:

1. l'utente cifra localmente un valore energetico con `tfhe_tool`;
2. viene prodotta una input validation proof ZK tramite Groth16;
3. `EnergyDataNotaryOnChain` verifica la proof tramite `IInputProofVerifier`;
4. il ciphertext completo viene salvato on-chain tramite code storage;
5. le operazioni FHE possono essere eseguite nativamente dalla precompile Besu
   `0x100` per chiamate `view`/diagnostiche, oppure prodotte off-chain e
   accettate on-chain tramite operation proof leggera quando il risultato deve
   essere salvato nello stato condiviso;
6. nel flusso principale di benchmark, `add`, `mulScalar`, `mean` e `max`
   salvano risultati proof-backed come nuovi ciphertext on-chain;
7. il possessore della client key recupera e decifra localmente gli output.

Gli output ricreabili vengono generati sotto directory ignorate da Git
(`artifacts/`, `cache/`, `typechain-types/`, `runtime/`, `proof/groth16/**/target/`).

## Struttura

```text
besu/          Fork/wrapper Besu e rete QBFT locale autosufficiente.
contracts/     Contratti Solidity, middleware BesuFHE e adapter input proof.
native/        Backend Rust TFHE-rs, JNI e tool locale di cifratura/decifratura.
proof/         Circuiti Groth16 per validazione input e operation proof.
scripts/       Deploy, interazione e build delle proof.
test/          Test Hardhat con mock della precompile e del verifier Groth16.
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
- `contracts/proof/Groth16EnergyInputVerifierAdapter.sol`: adapter tra il notary
  e il verifier Solidity Groth16 BN254;
- `contracts/proof/Groth16OperationProofVerifierAdapter.sol`: adapter
  per operation proof Groth16 BN254;
- `native/src/tfhe_backend.rs`: backend reale TFHE-rs;
- `scripts/interact/energy-notary-benchmark.ts`: workflow end-to-end pulito.

## Requisiti
- Windows con WSL2 o Distro Linux.
- Node.js `20.x` e npm `10+`.
- Rust/Cargo in WSL.
- Java compatibile con la build Besu.
- `circom` 2.x e `snarkjs` per produrre/verificare le proof Groth16.
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

Il circuito Groth16 è intenzionalmente piccolo. Prova che:

```text
plaintext in [minValue, maxValue]
metadataHash = Poseidon(plaintext, salt, owner, ciphertextHashHi, ciphertextHashLo)
```

Per garantire la confidenzialità, il contratto non vede il plaintext. 
On-chain vengono verificati:

- proof Groth16 BN254;
- public input del circuito;
- binding con `chainId`, indirizzo del notary, owner, hash del ciphertext,
  range, metadata hash e nonce.

Build dei circuiti Groth16 e dei verifier Solidity generati:

```bash
npm run proof:build:energy-input
npm run proof:build:operation-authority
npm run compile
```

Il verifier on-chain Groth16 usa il pairing precompile
BN254 della EVM e un payload fisso `(a,b,c,publicSignals)`, quindi e'
normalmente piu' leggero da verificare rispetto a verifier universali piu'
pesanti.

## Operation ZK-Proof leggere

La verifica completa della semantica TFHE dentro una prova ZK è possibile in
linea teorica (vedere RISC-0, https://risczero.com/), ma troppo costosa per un setup scalabile. 
Per questo il main case usa una operation proof ZK Groth16 leggera, legata al digest canonico
dell'operazione:

```text
digest = H(chainId, notary, owner, operation, inputSetHash,
           resultCiphertextHash, resultMetadataHash, nonce)
```

Il circuito prova conoscenza di un segreto di un nodo trusted associato a una
commitment pubblica autorizzata:

```text
authorityCommitment = Poseidon(secret)
attestationHash = Poseidon(secret, digestHi, digestLo)
```
Questo passaggio, purtroppo, richiede che il segreto sia associato a un nodo o un'autorità trusted.
In futuro, si esploreranno metodi più trasparenti e efficienti per la generazione di proof complete di computazione.

Il contratto verifica la proof tramite `Groth16OperationProofVerifierAdapter`, senza
vedere il secret del coprocessore. Questa resta una prova ZK di autorizzazione e
binding al digest, non una prova ZK completa della semantica TFHE. 
Quindi:
- correttezza del binding, non-riuso e disponibilita' sono gestite on-chain;
- l'autorizzazione di un'autorità può essere verificata in zero knowledge;
- la correttezza matematica del calcolo TFHE dipende ancora dal coprocessore,
  a meno di introdurre una proof molto piu' pesante della semantica TFHE.

## Deploy

Deploy del contratto sperimentale su Besu:

```bash
npm run deploy:besu
```

Lo script usa Groth16 come backend ZK principale. Opzione principale:

```bash
FHEBC_INPUT_PROOF_VERIFIER_ADDRESS=0x... npm run deploy:besu
```

Per le operation proof ZK Groth16:

```bash
npm run proof:build:operation-authority
npm run compile
FHEBC_OPERATION_ZK_AUTHORITY_COMMITMENT=0x... \
npm run deploy:besu
```

Deploy completo Groth16:

```bash
FHEBC_OPERATION_ZK_AUTHORITY_COMMITMENT=0x... \
npm run deploy:besu
```

La proof per una specifica operazione può essere prodotta con:

```bash
FHEBC_OPERATION_ZK_SECRET=12345 \
npm run proof:prove:operation-authority -- runtime/proof-contexts/operation.json
```

Benchmark Groth16:

```bash
FHEBC_BENCHMARK_INPUT_PROOF_MODE=groth16 \
FHEBC_BENCHMARK_OPERATION_PROOF_MODE=groth16 \
FHEBC_OPERATION_ZK_SECRET=12345 \
npm run benchmark:besu
```

Per provare direttamente il flusso proof-backed on-chain con verifier Groth16
reale sulle operazioni:

```bash
npm run benchmark:besu:proof-backed-onchain -- 1
```

Il comando usa `FHEBC_OPERATION_ZK_SECRET=12345` se non viene fornito un secret
diverso, calcola automaticamente la commitment Poseidon e imposta
`FHEBC_BENCHMARK_ALL_PROOF_BACKED=1`.

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
4. genera le input proof Groth16;
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
- `meanLastEntryAndEncryptedTotal()` (nativa sperimentale);
- `meanLastEntryAndEncryptedTotalProof(bytes,bytes32,bytes)`;
- `previewMaxLastEntryAndEncryptedTotal()`;
- `maxLastEntryAndEncryptedTotal()` (nativa sperimentale);
- `maxLastEntryAndEncryptedTotalProof(bytes,bytes32,bytes)`.

Le funzioni `preview*` sono `view`: misurano la latenza della computazione FHE
senza aggiornare lo storage. Il benchmark default e' consensus-safe e usa le
versioni `*Proof` per tutte le transazioni che salvano ciphertext risultato. Le
native lineari `add` e `mul_scalar` restano invocabili impostando
`FHEBC_BENCHMARK_ALL_PROOF_BACKED=0`, ma questa modalita' e' sperimentale:
salvare output TFHE compressi prodotti direttamente dai validator puo' creare
byte diversi per lo stesso risultato cifrato e quindi non va usato come percorso
QBFT principale.

## Storage Ciphertext

I ciphertext vengono salvati interamente on-chain:
1. il payload viene spezzato in chunk;
2. ogni chunk viene deployato come bytecode immutabile;
3. con un solo chunk il notary punta direttamente al data contract, senza
   creare un manifest separato;
4. con piu' chunk, un manifest conserva ordine e indirizzi;
5. il notary conserva puntatore, lunghezza, numero di chunk e content hash;
6. i record compattano owner, block number e tipo operazione nello stesso slot
   quando possibile, mentre i due contatori globali condividono uno slot;
7. letture e precompile ricostruiscono i bytes con `EXTCODECOPY`.

Questa scelta rende la disponibilità del ciphertext una proprietà dello stato
della chain, al prezzo di costi on-chain più alti (ma gestibili per una chain permissioned).

Le ottimizzazioni riguardano soltanto layout e numero di scritture: non
riducono il gas schedule della precompile e non spostano byte del ciphertext
off-chain.

### Output TFHE packed

Il keyset generato dal tool include le chiavi TFHE di list compression. In
pratica sono presenti tre casi:

- gli input utente sono `CompressedFheUint32` generati fuori dalla chain e poi
  inseriti in transazione;
- le `view` native possono restituire output TFHE prodotti dalla precompile,
  perche' non aggiornano state root o receipt;
- il percorso proof-backed usa `CompressedCiphertextList` generato off-chain e
  incluso interamente nella transazione, quindi tutti i validatori ricevono gli
  stessi byte da salvare.

La list compression non deve essere abilitata nel processo Besu tramite
`FHEBC_NATIVE_COMPRESSED_OUTPUTS`/`FHEBC_PACKED_OUTPUTS`: in esecuzione
concorrente tra validatori non garantisce un output byte-per-byte
deterministico. Anche la compressione nativa di un risultato TFHE puo' produrre
ciphertext equivalenti ma non identici nei byte. Per questo il percorso QBFT
principale della precompile restituisce output raw/canonici, mentre i tool
off-chain usati dal percorso proof-backed possono continuare a produrre
`CompressedCiphertextList`, perche' in quel caso tutti i validatori ricevono
gli stessi byte gia' calcolati nella transazione.

La proof operation corrente dimostra la conoscenza del segreto associato
all'authority commitment e lega digest, input set hash e output hash. Non
dimostra internamente l'intera semantica TFHE dell'operazione: per questa
garanzia forte va usato il percorso nativo, oppure un futuro circuito che
includa la relazione TFHE.

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
