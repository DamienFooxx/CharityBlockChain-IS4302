import { ethers } from "ethers";

// Import your ABI files
import AttestorVotingABI from "../abi/AttestorVoting.json";
import EscrowVaultABI from "../abi/EscrowVault.json";
// import other contracts as needed

// Addresses for local Hardhat deployment (update after deploy)
const ADDRESSES = {
  AttestorVoting: "0xYourAttestorVotingAddress",
  EscrowVault: "0xYourEscrowVaultAddress",
  // other contracts...
};

let provider;
let signer;

export async function initProvider() {
  if (!window.ethereum) throw new Error("MetaMask not installed");
  provider = new ethers.BrowserProvider(window.ethereum);
  signer = await provider.getSigner();
  return { provider, signer };
}

export function getContract(name) {
  if (!signer)
    throw new Error("Provider not initialized. Call initProvider() first.");

  switch (name) {
    case "AttestorVoting":
      return new ethers.Contract(
        ADDRESSES.AttestorVoting,
        AttestorVotingABI.abi,
        signer
      );
    case "EscrowVault":
      return new ethers.Contract(
        ADDRESSES.EscrowVault,
        EscrowVaultABI.abi,
        signer
      );
    // Add other contracts here
    default:
      throw new Error("Unknown contract: " + name);
  }
}
