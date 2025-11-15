// src/App.jsx
import { useState, useEffect } from "react";
import { ethers } from "ethers";
import addresses from "./config/addresses.json";
import DonorPage from "./pages/donorPage";
import CharityPage from "./pages/charityPage";
import AdminPage from "./pages/adminPage";
import EventsPage from "./pages/eventsPage";
import VotingPage from "./pages/votingPage";
import AttestorsPage from "./pages/attestorsPage";


function App() {
  const [account, setAccount] = useState(null);
  const [showDonor, setShowDonor] = useState(false);
  const [showCharity, setShowCharity] = useState(false);
  const [showAdmin, setShowAdmin] = useState(false);
  const [showEvents, setShowEvents] = useState(false);
  const [showVoting, setShowVoting] = useState(false);
  const [showAttestors, setShowAttestors] = useState(false);

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
          <button style={{ marginLeft: 8 }} onClick={() => setShowEvents((s) => !s)}>
            {showEvents ? "Close Events Page" : "Open Events Page"}
          </button>
          <button style={{ marginLeft: 8 }} onClick={() => setShowVoting((s) => !s)}>
            {showVoting ? "Close Voting Page" : "Open Voting Page"}
          </button>
          <button style={{ marginLeft: 8 }} onClick={() => setShowAttestors((s) => !s)}>
            {showAttestors ? "Close Attestors Page" : "Open Attestors Page"}
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
        ) : showEvents ? (
          <EventsPage />
        ) : showVoting ? (
          <VotingPage />
        ) : showAttestors ? (
          <AttestorsPage />
        ) : (
          <div>
            <p>
              Use the "Open Donor Page", "Open Charity Page", "Open Admin Page",
              "Open Events Page", "Open Voting Page" or "Open Attestors Page" buttons to view helpers.
            </p>
          </div>
        )}
      </main>
    </div>
  );
}

export default App;
