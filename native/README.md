# Backend nativo TFHE-rs

Questo crate Rust compila:

- `libbesu_fhe_native.so`, caricata dalla JVM Besu modificata tramite JNI;
- `tfhe_tool`, usato per generazione delle chiavi, cifratura, decifratura e operazioni TFHE lato proof.

## Build

```bash
bash scripts/build.sh
```

Lo script copia gli artefatti di release in `../runtime/native`.

## Chiavi

```bash
../runtime/native/tfhe_tool keygen \
  ../runtime/keys/client.key \
  ../runtime/keys/server.key
```

I validatori Besu caricano la server key da
`FHEBC_TFHE_SERVER_KEY_PATH`. Gli script lato client usano la client key per cifrare
e decifrare i valori.

## Test della Precompile

Dopo aver prodotto due file ciphertext:

```bash
python scripts/call_besu_precompile_add.py \
  http://127.0.0.1:8545 \
  a.ct b.ct result.ct 0x35a4e900
```