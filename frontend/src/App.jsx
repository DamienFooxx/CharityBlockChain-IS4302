// src/App.jsx
import { useState, useEffect } from "react";
import { ethers } from "ethers";
import addresses from "./config/addresses.json";
import DonorPage from "./pages/donorPage";


function App() {
  const [account, setAccount] = useState(null);
  const [showDonor, setShowDonor] = useState(false);

  useEffect(() => {
    console.log("Loaded contract addresses:", addresses);
  }, []);

  async function connectWallet() {
    if (window.ethereum) {
      const provider = new ethers.BrowserProvider(window.ethereum);
      const signer = await provider.getSigner();
      const userAddress = await signer.getAddress();
      setAccount(userAddress);
    } else {
      alert("Please install MetaMask!");
    }
  }

  return (
    <div style={{ padding: 20 }}>
      <header style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <h1 style={{ margin: 0 }}>Charity Blockchain Demo</h1>
        <div style={{ marginLeft: "auto" }}>
          <button onClick={connectWallet}>
            {account ? `Connected: ${account}` : "Connect Wallet"}
          </button>
          <button style={{ marginLeft: 8 }} onClick={() => setShowDonor((s) => !s)}>
            {showDonor ? "Close Donor Page" : "Open Donor Page"}
          </button>
        </div>
      </header>

      <main style={{ marginTop: 16 }}>
        {showDonor ? (
          <DonorPage />
        ) : (
          <div>
            <p>Use the "Open Donor Page" button to view node accounts and token minting helper.</p>
          </div>
        )}
      </main>
    </div>
  );
}

export default App;
