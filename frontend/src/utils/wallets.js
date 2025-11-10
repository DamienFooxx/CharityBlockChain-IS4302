import { ethers } from "ethers";

// Helper to load local private keys and construct ethers.Wallet objects.
// Reads frontend/src/config/accountPrivateKey.json (must be git-ignored and local).
export async function getWallets(rpcUrl = "http://127.0.0.1:8545") {
  try {
    const mod = await import("../config/accountPrivateKey.json");
    const keys = mod.default || mod;
    if (!Array.isArray(keys) || keys.length === 0) {
      throw new Error("accountPrivateKey.json is empty or invalid");
    }
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    return keys.map((pk) => new ethers.Wallet(pk, provider));
  } catch (e) {
    throw new Error(
      "Failed to load local accountPrivateKey.json: " + (e.message || e)
    );
  }
}

export async function getWallet(index, rpcUrl = "http://127.0.0.1:8545") {
  const wallets = await getWallets(rpcUrl);
  if (!wallets[index]) throw new Error(`No wallet at index ${index}`);
  return wallets[index];
}
