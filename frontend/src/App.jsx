// src/App.jsx
import { useState, useEffect } from "react";
import { ethers } from "ethers";
import addresses from "./config/addresses.json";
import DonorPage from "./pages/donorPage";
import CharityPage from "./pages/charityPage";
import AdminPage from "./pages/adminPage";


function App() {
  const [account, setAccount] = useState(null);
  const [showDonor, setShowDonor] = useState(false);
  const [showCharity, setShowCharity] = useState(false);
  const [showAdmin, setShowAdmin] = useState(false);

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
          <button style={{ marginLeft: 8 }} onClick={() => setShowCharity((s) => !s)}>
            {showCharity ? "Close Charity Page" : "Open Charity Page"}
          </button>
          <button style={{ marginLeft: 8 }} onClick={() => setShowAdmin((s) => !s)}>
            {showAdmin ? "Close Admin Page" : "Open Admin Page"}
          </button>
        </div>
      </header>

      <main style={{ marginTop: 16 }}>
        {showAdmin ? (
          <AdminPage />
        ) : showDonor ? (
          <DonorPage />
        ) : showCharity ? (
          <CharityPage />
        ) : (
          <div>
            <p>Use the "Open Donor Page", "Open Charity Page" or "Open Admin Page" button to view helpers.</p>
          </div>
        )}
      </main>
    </div>
  );
}

export default App;
