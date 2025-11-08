// src/App.jsx
import { useState, useEffect } from "react";
import { ethers } from "ethers";
import addresses from "./config/addresses.json";


function App() {
  const [account, setAccount] = useState(null);
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
    <div>
      <h1>Charity Blockchain Demo</h1>
      <button onClick={connectWallet}>
        {account ? `Connected: ${account}` : "Connect Wallet"}
      </button>
    </div>
  );
}

export default App;
