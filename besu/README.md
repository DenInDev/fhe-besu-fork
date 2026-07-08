# Modifiche Effettuate a Besu -> BesuFHE

`source/` è un git checkout di Hyperledger Besu 24.3.0 modificato con
`FheDispatcherPrecompiledContract`.

La precompile è registrata all’indirizzo:

```text
0x0000000000000000000000000000000000000100
```

Decodifica la richiesta FHE, addebita il gas specifico per ciascuna operazione e
chiama `libbesu_fhe_native.so` tramite JNI (https://docs.oracle.com/javase/8/docs/technotes/guides/jni/index.html).

## Contenuto

```text
source/       checkout Besu modificato
patches/      patch riproducibile rispetto a Besu 24.3.0
network/      configurazione autonoma di una chain QBFT a quattro nodi e chiavi dei validatori
scripts/      script di build, avvio, arresto e generazione della genesis
wrapped-besu/ wrapper che avvia il fork Besu compilato con valori predefiniti per l’ambiente FHE
```

Compilare e avviare dalla root del progetto:

```bash
npm run build:native
npm run build:besu
npm run start:besu
```