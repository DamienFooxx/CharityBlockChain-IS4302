require("@nomicfoundation/hardhat-toolbox");

/** @type import('hardhat/config').HardhatUserConfig */
const DEFAULT_DEMO_MNEMONIC =
  process.env.HARDHAT_MNEMONIC ||
  "test test test test test test test test test test test junk";

module.exports = {
  solidity: {
    version: "0.8.28",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      viaIR: true,
    },
  },
  networks: {
    localhost: {
      url: "http://127.0.0.1:8545",
      accounts: { mnemonic: DEFAULT_DEMO_MNEMONIC },
    },
  },
};
