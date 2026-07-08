import "@nomicfoundation/hardhat-toolbox";
import { HardhatUserConfig } from "hardhat/config";

const DEFAULT_LOCAL_SUITE_MNEMONIC =
  "adapt mosquito move limb mobile illegal tree voyage juice mosquito burger raise father hope layer";

const config: HardhatUserConfig = {
  solidity: {
    compilers: [
      {
        version: "0.8.24",
        settings: {
          optimizer: {
            enabled: true,
            runs: 1
          }
        }
      },
      {
        version: "0.8.27",
        settings: {
          optimizer: {
            enabled: true,
            runs: 1
          }
        }
      }
    ]
  },
  networks: {
    fhebcBesu: {
      url: process.env.FHEBC_BESU_RPC_URL ?? "http://localhost:8545",
      chainId: Number(process.env.FHEBC_BESU_CHAIN_ID ?? "1337"),
      accounts: {
        mnemonic: process.env.FHEBC_BESU_MNEMONIC ?? DEFAULT_LOCAL_SUITE_MNEMONIC,
        path: "m/44'/60'/0'/0/",
        count: Number(process.env.FHEBC_BESU_ACCOUNT_COUNT ?? "5")
      },
      gasPrice: Number(process.env.FHEBC_BESU_GAS_PRICE_WEI ?? "1000")
    }
  }
};

export default config;
