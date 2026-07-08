# BesuFHE Local Network

Questa directory contiene la configurazione Besu locale usata da BesuFHE.
Contenuto del repository:

- `genesis.json`: chain QBFT locale, `chainId` 1337, block period 1 secondo,
  timeout QBFT 3 secondi e gas limit alto per i benchmark FHE.
- `Node-*/data/key`: chiavi dei quattro validator locali.
- `Node-*/data/static-nodes.json`: peer statici dei validator.
- `Node-*/data/permissions_config.toml`: configurazione permissioning locale.
- `start-nodes.sh`: avvio, stop, reset e status dei quattro nodi.

I database, le cache e i log dei nodi sono generati a runtime e ignorati.

Comandi utili:

```bash
npm run start:besu
npm run stop:besu
bash besu/network/start-nodes.sh reset
bash besu/network/start-nodes.sh status
```
