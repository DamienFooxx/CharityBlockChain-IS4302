import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import addresses from "../config/addresses.json";
import AttestorRegistryArtifact from "../abi/AttestorRegistry.json";
import SGDCoinArtifact from "../abi/SGDCoin.json";
import { getWallets } from "../utils/wallets";

function short(addr) {
  if (!addr) return "";
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export default function AttestorsPage() {
  const rpcUrl = "http://127.0.0.1:8545";

  const [status, setStatus] = useState("");
  const [wallets, setWallets] = useState([]);
  const [adminWallet, setAdminWallet] = useState(null);

  const [attestors, setAttestors] = useState([
    { index: 11, registered: false, balance: "0", address: "" },
    { index: 12, registered: false, balance: "0", address: "" },
    { index: 13, registered: false, balance: "0", address: "" },
  ]);

  const [mintAmount, setMintAmount] = useState("10000");
  const [mintToIndex, setMintToIndex] = useState(11);

  useEffect(() => {
    (async () => {
      try {
        const loaded = await getWallets(rpcUrl);
        setWallets(loaded);
        if (!loaded[0]) throw new Error("No admin wallet");
        setAdminWallet(loaded[0]);
        setStatus("Loaded wallets");
        
        // Load attestor data
        await refreshAttestors(loaded);
      } catch (e) {
        setStatus("Failed to load: " + (e.message || e));
      }
    })();
  }, []);

  async function refreshAttestors(walletsToUse) {
    const w = walletsToUse || wallets;
    if (w.length === 0) return;

    try {
      const provider = new ethers.JsonRpcProvider(rpcUrl);
      const registry = new ethers.Contract(
        addresses.AttestorRegistry,
        AttestorRegistryArtifact.abi,
        provider
      );
      const sgd = new ethers.Contract(
        addresses.SGDCoin,
        SGDCoinArtifact.abi,
        provider
      );

      const updated = await Promise.all(
        [11, 12, 13].map(async (idx) => {
          const wallet = w[idx];
          if (!wallet) return { index: idx, registered: false, balance: "0", address: "" };
          
          const addr = await wallet.getAddress();
          let registered = false;
          try {
            registered = await registry.isRegistered(addr);
          } catch (e) {
            console.warn(`Failed to check registration for ${idx}:`, e);
          }

          let balance = "0";
          try {
            const bal = await sgd.balanceOf(addr);
            balance = ethers.formatUnits(bal, 18);
          } catch (e) {
            console.warn(`Failed to get balance for ${idx}:`, e);
          }

          return { index: idx, registered, balance, address: addr };
        })
      );

      setAttestors(updated);
      setStatus("Attestor data refreshed");
    } catch (e) {
      setStatus("Refresh failed: " + (e.message || e));
    }
  }

  async function registerAttestor(index) {
    const wallet = wallets[index];
    if (!wallet) return setStatus("Wallet not found at index " + index);
    if (!adminWallet) return setStatus("Admin wallet not ready");

    try {
      setStatus(`Registering attestor ${index}...`);
      const addr = await wallet.getAddress();
      
      // Use admin wallet (account 0) to register the attestor
      const registry = new ethers.Contract(
        addresses.AttestorRegistry,
        AttestorRegistryArtifact.abi,
        adminWallet
      );

      const tx = await registry.setAttestorRegistration(addr, true);
      setStatus(`Registration tx: ${tx.hash}`);
      await tx.wait();
      setStatus(`Attestor ${index} registered successfully!`);
      await refreshAttestors();
    } catch (e) {
      setStatus(`Registration failed for ${index}: ` + (e.message || e));
    }
  }

  async function mintSGD() {
    if (!adminWallet) return setStatus("Admin wallet not ready");
    const targetWallet = wallets[mintToIndex];
    if (!targetWallet) return setStatus("Target wallet not found");

    try {
      setStatus(`Minting ${mintAmount} SGD to account ${mintToIndex}...`);
      const sgd = new ethers.Contract(
        addresses.SGDCoin,
        SGDCoinArtifact.abi,
        adminWallet
      );

      const targetAddr = await targetWallet.getAddress();
      const amountWei = ethers.parseUnits(mintAmount, 18);
      
      const tx = await sgd.mint(targetAddr, amountWei);
      setStatus(`Mint tx: ${tx.hash}`);
      await tx.wait();
      setStatus(`Minted ${mintAmount} SGD to account ${mintToIndex} (${short(targetAddr)})`);
      await refreshAttestors();
    } catch (e) {
      setStatus("Mint failed: " + (e.message || e));
    }
  }

  return (
    <div style={{ padding: 20 }}>
      <h2>Attestor Registration & SGD Tokens</h2>
      <div style={{ marginBottom: 16, color: "#666" }}>{status}</div>

      <section style={{ marginBottom: 24 }}>
        <h3>Attestor Accounts (11, 12, 13)</h3>
        <div style={{ display: "grid", gap: 12, maxWidth: 800 }}>
          {attestors.map((attestor) => (
            <div
              key={attestor.index}
              style={{
                padding: 16,
                border: "1px solid #ddd",
                borderRadius: 8,
                backgroundColor: attestor.registered ? "#d4edda" : "#f8d7da",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div>
                  <div style={{ fontSize: 18, fontWeight: "bold" }}>
                    Account {attestor.index}
                  </div>
                  <div style={{ fontSize: 12, color: "#666", fontFamily: "monospace" }}>
                    {attestor.address ? short(attestor.address) : "Loading..."}
                  </div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div style={{ fontSize: 14, color: attestor.registered ? "#155724" : "#721c24" }}>
                    {attestor.registered ? "✓ Registered" : "Not Registered"}
                  </div>
                  <div style={{ fontSize: 14, marginTop: 4 }}>
                    <strong>{parseFloat(attestor.balance).toFixed(2)} SGD</strong>
                  </div>
                </div>
              </div>
              <div style={{ marginTop: 12 }}>
                <button
                  onClick={() => registerAttestor(attestor.index)}
                  disabled={attestor.registered}
                  style={{
                    padding: "8px 16px",
                    backgroundColor: attestor.registered ? "#ccc" : "#007bff",
                    color: "white",
                    border: "none",
                    borderRadius: 4,
                    cursor: attestor.registered ? "not-allowed" : "pointer",
                  }}
                >
                  {attestor.registered ? "Already Registered" : "Register as Attestor"}
                </button>
              </div>
            </div>
          ))}
        </div>
        <div style={{ marginTop: 16 }}>
          <button
            onClick={() => refreshAttestors()}
            style={{
              padding: "8px 16px",
              backgroundColor: "#6c757d",
              color: "white",
              border: "none",
              borderRadius: 4,
              cursor: "pointer",
            }}
          >
            Refresh Attestor Data
          </button>
        </div>
      </section>

      <section style={{ marginBottom: 24 }}>
        <h3>Admin: Mint SGD Tokens</h3>
        <div
          style={{
            padding: 16,
            border: "1px solid #ffc107",
            borderRadius: 8,
            backgroundColor: "#fff3cd",
            maxWidth: 600,
          }}
        >
          <div style={{ marginBottom: 8, fontSize: 12, color: "#856404" }}>
            <strong>⚠️ Admin Only:</strong> Account 0 can mint SGD tokens to any account
          </div>
          <div style={{ display: "grid", gap: 12 }}>
            <label>
              Mint to Account:
              <select
                value={mintToIndex}
                onChange={(e) => setMintToIndex(Number(e.target.value))}
                style={{ marginLeft: 8, padding: 4 }}
              >
                {wallets.map((_, idx) => (
                  <option key={idx} value={idx}>
                    Account {idx} {idx >= 11 && idx <= 13 ? "(Attestor)" : ""}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Amount (SGD):
              <input
                type="text"
                value={mintAmount}
                onChange={(e) => setMintAmount(e.target.value)}
                placeholder="e.g., 10000"
                style={{ marginLeft: 8, padding: 4, width: 150 }}
              />
            </label>
            <button
              onClick={mintSGD}
              style={{
                padding: "8px 16px",
                backgroundColor: "#28a745",
                color: "white",
                border: "none",
                borderRadius: 4,
                cursor: "pointer",
              }}
            >
              Mint SGD Tokens
            </button>
          </div>
        </div>
      </section>

      <section>
        <h3>ℹ️ About Attestors</h3>
        <div style={{ fontSize: 14, color: "#666", maxWidth: 700 }}>
          <p>
            <strong>Attestors</strong> are independent verifiers who validate charity evidence submissions.
          </p>
          <ul>
            <li><strong>Registration:</strong> Admin (account 0) registers attestors in AttestorRegistry before they can participate</li>
            <li><strong>SGD Tokens:</strong> Required for staking during voting (admin mints tokens)</li>
            <li><strong>Voting:</strong> Attestors stake SGD when voting on evidence verification</li>
            <li><strong>Rewards/Slashing:</strong> Correct votes earn rewards; incorrect votes lose stake</li>
            <li><strong>Typical Accounts:</strong> Use accounts 11-18 as attestors (accounts 1-10 for donors)</li>
          </ul>
        </div>
      </section>
    </div>
  );
}
