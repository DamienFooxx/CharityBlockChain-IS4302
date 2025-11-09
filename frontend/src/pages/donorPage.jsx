import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import addresses from "../config/addresses.json";
import SGDCoinArtifact from "../abi/SGDCoin.json";

function short(addr) {
  return addr ? `${addr.slice(0, 6)}...${addr.slice(-4)}` : "";
}

export default function DonorPage() {
  const [accounts, setAccounts] = useState([]); // { address, balance }
  const [loading, setLoading] = useState(false);
  const [connected, setConnected] = useState(null); // connected metamask address
  const [status, setStatus] = useState("");
  const [events, setEvents] = useState([]);

  const rpcUrl = "http://127.0.0.1:8545";

  useEffect(() => {
    refreshAll();
  }, []);

  // Attach event listeners for Transfer, Mint and optionally Minted
  useEffect(() => {
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const sgd = new ethers.Contract(addresses.SGDCoin, SGDCoinArtifact.abi, provider);

    let decimalsNum = 18;
    sgd.decimals()
      .then((d) => {
        decimalsNum = typeof d === "bigint" ? Number(d) : d;
      })
      .catch(() => {});

    function pushEvent(obj) {
      setEvents((prev) => [obj, ...prev].slice(0, 200));
    }

    const onTransfer = (from, to, value, event) => {
      const amount = (() => {
        try {
          return ethers.formatUnits(value, decimalsNum);
        } catch (e) {
          return value.toString();
        }
      })();
      pushEvent({ id: Date.now() + Math.random(), type: "Transfer", from, to, amount, tx: event.transactionHash });
    };

    const onMint = (to, amount, event) => {
      const amt = (() => {
        try {
          return ethers.formatUnits(amount, decimalsNum);
        } catch (e) {
          return amount.toString();
        }
      })();
      pushEvent({ id: Date.now() + Math.random(), type: "Mint", to, amount: amt, tx: event.transactionHash });
    };


    try { sgd.on("Transfer", onTransfer); } catch (e) {}
    try { sgd.on("Mint", onMint); } catch (e) {}

    return () => {
      try { sgd.off("Transfer", onTransfer); } catch (e) {}
      try { sgd.off("Mint", onMint); } catch (e) {}
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function refreshAll() {
    setLoading(true);
    setStatus("Loading accounts and balances...");

    try {
      const provider = new ethers.JsonRpcProvider(rpcUrl);

      // Try eth_accounts first (works with local node)
      let nodeAccounts = [];
      try {
        nodeAccounts = await provider.send("eth_accounts", []);
      } catch (e) {
        // ignore
      }

      // If eth_accounts returned nothing, fallback to asking for first 10 signers
      if (!nodeAccounts || nodeAccounts.length === 0) {
        const tmp = [];
        for (let i = 0; i < 10; i++) {
          try {
            const signer = provider.getSigner(i);
            const addr = await signer.getAddress();
            tmp.push(addr);
          } catch (e) {
            break;
          }
        }
        nodeAccounts = tmp;
      }

      // Take 10 accounts for users, start from account 1 as account 0 is the manin deployer for all
      nodeAccounts = nodeAccounts.slice(1, 11);

      // Create SGDCoin contract
      const sgdAddr = addresses.SGDCoin;
      const sgd = new ethers.Contract(sgdAddr, SGDCoinArtifact.abi, provider);

      const list = [];
      for (let i = 0; i < nodeAccounts.length; i++) {
        const a = nodeAccounts[i];
        let bal = 0n;
        try {
          bal = await sgd.balanceOf(a);
        } catch (e) {
          bal = 0n;
        }
        // balance is BigInt (ethers v6) — use ethers.formatUnits for safe conversion
        const decimals = await sgd.decimals().catch(() => 18);
        const decimalsNum = typeof decimals === "bigint" ? Number(decimals) : decimals;
        let human;
        try {
          human = ethers.formatUnits(bal, decimalsNum);
        } catch (e) {
          
          human = (Number(bal) / Math.pow(10, Number(decimalsNum))).toString();
        }
        list.push({ index: i + 1, address: a, balanceRaw: bal, balance: human });
      }

      setAccounts(list);
      setStatus("");
    } catch (e) {
      setStatus("Failed to load accounts: " + (e.message || e));
    } finally {
      setLoading(false);
    }
  }

  // Connect MetaMask to get signer for minting. Also fetch connected address
  async function connectWallet() {
    if (!window.ethereum) {
      setStatus("MetaMask not found");
      return;
    }
    try {
      const browserProvider = new ethers.BrowserProvider(window.ethereum);
      await browserProvider.send("eth_requestAccounts", []);
      const signer = await browserProvider.getSigner();
      const addr = await signer.getAddress();
      setConnected(addr);
      setStatus("Connected: " + addr);
    } catch (e) {
      setStatus("Wallet connection failed: " + (e.message || e));
    }
  }

  // Mint a fixed amount (100) to a target account using connected signer (MetaMask)
  async function mintTo(targetAddress, amount = "100") {
    if (!window.ethereum) {
      setStatus("MetaMask not found");
      return;
    }
    setStatus("Sending mint tx...");
    try {
      const browserProvider = new ethers.BrowserProvider(window.ethereum);
      const signer = await browserProvider.getSigner();
      const signerAddr = await signer.getAddress();
      // Create contract connected to signer
      const sgd = new ethers.Contract(addresses.SGDCoin, SGDCoinArtifact.abi, signer);

      // Convert human amount to token units (assume 18 decimals)
      const decimals = await sgd.decimals().catch(() => 18);
      const amountWei = ethers.parseUnits(amount.toString(), decimals);

      const tx = await sgd.mint(targetAddress, amountWei);
      setStatus("Mint transaction sent: " + tx.hash);
      await tx.wait();
      setStatus("Mint confirmed. Refreshing balances...");
      await refreshAll();
      setStatus("Mint completed");
    } catch (e) {
      setStatus("Mint failed: " + (e.message || e));
    }
  }

  // Mint to all loaded accounts using node signer 0 (JSON-RPC provider)
  async function mintToAll(amount = "1000") {
    setStatus("Minting to all accounts (using node account 0)...");
    try {
      if (!accounts || accounts.length === 0) {
        await refreshAll();
      }
      const provider = new ethers.JsonRpcProvider(rpcUrl);
      const signer0 = provider.getSigner(0);
      let signer0Addr;
      try {
        signer0Addr = await signer0.getAddress();
      } catch (err) {
        throw new Error("RPC signer 0 is not available — ensure local node is running and unlocked (npx hardhat node)");
      }

      const sgd = new ethers.Contract(addresses.SGDCoin, SGDCoinArtifact.abi, signer0);
      let ownerAddr = null;
      try { ownerAddr = await sgd.owner(); } catch (e) {}
      if (ownerAddr && ownerAddr.toLowerCase() !== signer0Addr.toLowerCase()) {
        throw new Error(`Node signer 0 (${signer0Addr}) is not the SGDCoin owner (${ownerAddr}). Only owner can call mint().`);
      }

      const decimals = await sgd.decimals().catch(() => 18);
      const decimalsNum = typeof decimals === "bigint" ? Number(decimals) : decimals;
      const amountWei = ethers.parseUnits(amount.toString(), decimalsNum);

      for (let i = 0; i < accounts.length; i++) {
        const target = accounts[i].address;
        setStatus(`Sending mint to ${short(target)}...`);
        const tx = await sgd.mint(target, amountWei);
        await tx.wait();
      }

      setStatus("All mints confirmed. Refreshing balances...");
      await refreshAll();
      setStatus("Mint to all completed");
    } catch (e) {
      setStatus("Mint to all failed: " + (e.message || e));
    }
  }

  return (
    <div style={{ padding: 20 }}>
      <h2>Node Accounts (first 10)</h2>
      <div style={{ marginBottom: 10 }}>
        <button onClick={refreshAll} disabled={loading}>
          Refresh
        </button>
        {/* <button
          onClick={() => mintToAll(1000)}
          style={{ marginLeft: 8 }}
          disabled={loading}
        >
          Mint 1000 SGD to all (from node account 0)
        </button> */}
        <button onClick={connectWallet} style={{ marginLeft: 8 }}>
          Connect MetaMask
        </button>
        <span style={{ marginLeft: 12 }}>{status}</span>
      </div>

      <div style={{ display: "flex", gap: 12 }}>
        <div style={{ flex: 2 }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 12 }}>
            {accounts.map((acct) => (
              <div key={acct.address} style={{ border: "1px solid #ddd", padding: 12, borderRadius: 6 }}>
                <div style={{ fontWeight: 600 }}>Account {acct.index}</div>
                <div style={{ fontFamily: "monospace", marginTop: 6 }}>{acct.address}</div>
                <div style={{ marginTop: 8 }}>SGD Balance: {acct.balance}</div>
                <div style={{ marginTop: 8 }}>
                  <button onClick={() => mintTo(acct.address, 100)}>
                    Mint 100 SGD to this account (from connected wallet)
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div style={{ flex: 1, borderLeft: "1px solid #eee", paddingLeft: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <h3 style={{ margin: 0 }}>Event Log</h3>
            <div>
              <button onClick={() => setEvents([])}>Clear</button>
            </div>
          </div>

          <div style={{ marginTop: 8, maxHeight: "70vh", overflow: "auto" }}>
            {events.length === 0 ? (
              <div style={{ color: "#666" }}>No events yet. Events (Transfer, Mint, Minted) will appear here.</div>
            ) : (
              events.map((ev) => (
                <div key={ev.id} style={{ borderBottom: "1px solid #f0f0f0", padding: 8 }}>
                  <div style={{ fontSize: 12, color: "#999" }}>{new Date().toLocaleTimeString()}</div>
                  <div style={{ fontWeight: 700 }}>{ev.type}</div>
                  {ev.type === "Transfer" && (
                    <div style={{ fontSize: 13 }}>
                      <div>from: <span style={{ fontFamily: "monospace" }}>{ev.from}</span></div>
                      <div>to: <span style={{ fontFamily: "monospace" }}>{ev.to}</span></div>
                      <div>amount: {ev.amount}</div>
                      <div style={{ fontSize: 11, color: "#666" }}>tx: {ev.tx}</div>
                    </div>
                  )}
                  {ev.type === "Mint" && (
                    <div style={{ fontSize: 13 }}>
                      <div>to: <span style={{ fontFamily: "monospace" }}>{ev.to}</span></div>
                      <div>amount: {ev.amount}</div>
                      <div style={{ fontSize: 11, color: "#666" }}>tx: {ev.tx}</div>
                    </div>
                  )}
                  {/* Minted events removed — contract emits Mint and Transfer only */}
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
