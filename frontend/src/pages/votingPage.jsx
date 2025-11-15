import React, { useEffect, useState, useMemo } from "react";
import { ethers } from "ethers";
import addresses from "../config/addresses.json";
import CharityEventArtifact from "../abi/CharityEvent.json";
import DonorVotingArtifact from "../abi/DonorVoting.json";
import AttestorVotingArtifact from "../abi/AttestorVoting.json";
import OracleArtifact from "../abi/Oracle.json";
import DonorRegistryArtifact from "../abi/DonorRegistry.json";
import DonorRankingArtifact from "../abi/DonorRanking.json";
import EscrowVaultArtifact from "../abi/EscrowVault.json";
import AttestorRegistryArtifact from "../abi/AttestorRegistry.json";
import SGDCoinArtifact from "../abi/SGDCoin.json";
import { getWallets } from "../utils/wallets";

function short(addr) {
  if (!addr) return "";
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export default function VotingPage() {
  const rpcUrl = "http://127.0.0.1:8545";

  const [status, setStatus] = useState("");
  const [adminWallet, setAdminWallet] = useState(null);
  const [wallets, setWallets] = useState([]);

  // Context
  const [eventAddress, setEventAddress] = useState("");
  const [eventId, setEventId] = useState("");
  const [donorVotingAddr, setDonorVotingAddr] = useState("");
  const [attestorVotingAddr, setAttestorVotingAddr] = useState("");

  const [eventSummary, setEventSummary] = useState(null);
  const [overallResult, setOverallResult] = useState(null);
  const [donorPhase, setDonorPhase] = useState(null);
  const [deadlineInfo, setDeadlineInfo] = useState(null);
  const [modulesStatus, setModulesStatus] = useState(null);

  // Input helpers
  const [assignDonorIndex, setAssignDonorIndex] = useState(1);
  const [assignStream, setAssignStream] = useState(0);
  const [assignAttestorIndex, setAssignAttestorIndex] = useState(11);
  const [assignAttestorStream, setAssignAttestorStream] = useState(0);
  const [commitDonorIndex, setCommitDonorIndex] = useState(1);
  const [commitChoice, setCommitChoice] = useState("true");
  const [commitAttestorIndex, setCommitAttestorIndex] = useState(11);
  const [commitAttestorChoice, setCommitAttestorChoice] = useState("true");
  const [attestorStake, setAttestorStake] = useState("1000"); // Default 1000 SGD

  const [saltCache, setSaltCache] = useState({});
  const [attestorSaltCache, setAttestorSaltCache] = useState({});
  const [events, setEvents] = useState([]);
  const [donorPledgesList, setDonorPledgesList] = useState([]);
  const [donorStreamSelections, setDonorStreamSelections] = useState({});

  useEffect(() => {
    (async () => {
      try {
        const loaded = await getWallets(rpcUrl);
        setWallets(loaded);
        if (!loaded[0]) throw new Error("No admin wallet (index 0)");
        setAdminWallet(loaded[0]);
        setStatus("Loaded local wallets (admin index 0)");
      } catch (e) {
        setStatus("Failed to load wallets: " + (e.message || e));
      }
    })();
  }, []);

  // Auto-refresh phase and deadlines when donorVotingAddr changes
  useEffect(() => {
    if (donorVotingAddr) {
      refreshDonorPhase();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [donorVotingAddr]);

  // Auto-check modules status when eventId changes
  useEffect(() => {
    if (eventId) {
      checkModulesStatus();
      fetchDonorsWithPledges();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventId]);

  async function fetchDonorsWithPledges() {
    if (!eventId) return;
    try {
      setStatus("Fetching donors with pledges...");
      
      // Use EscrowVault to get pledge information via events
      const escrowContract = new ethers.Contract(
        addresses.EscrowVault,
        EscrowVaultArtifact.abi,
        provider
      );

      // Query PledgeDeposited events for this eventId
      const filter = escrowContract.filters.PledgeDeposited(null, eventId);
      const events = await escrowContract.queryFilter(filter);
      
      // Group pledges by donor
      const donorMap = new Map();
      
      for (const event of events) {
        const pledgeId = event.args.pledgeId;
        const donorAddr = event.args.donor;
        const amount = event.args.amount;
        
        // Check if pledge is still active
        const isActive = await escrowContract.pledgeActive(pledgeId);
        
        if (isActive) {
          if (donorMap.has(donorAddr)) {
            donorMap.get(donorAddr).amount += amount;
          } else {
            donorMap.set(donorAddr, {
              address: donorAddr,
              amount: amount,
            });
          }
        }
      }
      
      const donorsList = Array.from(donorMap.values());
      setDonorPledgesList(donorsList);
      
      // Initialize stream selections to 0
      const initialSelections = {};
      donorsList.forEach(donor => {
        initialSelections[donor.address] = 0;
      });
      setDonorStreamSelections(initialSelections);
      
      setStatus(`Found ${donorsList.length} donors with pledges`);
    } catch (e) {
      console.error("Failed to fetch donors:", e);
      setStatus("Failed to fetch donors: " + (e.message || e));
    }
  }

  const provider = useMemo(() => new ethers.JsonRpcProvider(rpcUrl), []);

  async function loadEventSummary(addr) {
    if (!addr) return;
    try {
      const ev = new ethers.Contract(addr, CharityEventArtifact.abi, provider);
      const summary = await ev.getEventSummary();
      setEventSummary({
        eventId: summary[0],
        orgId: Number(summary[1]),
        phase: Number(summary[2]),
        goal: summary[3],
        raised: summary[4],
        beneficiary: summary[5],
        verified: summary[6],
      });
      if (!eventId) setEventId(summary[0]);
      setStatus("Loaded event summary");
    } catch (e) {
      setStatus("Failed to load summary: " + (e.message || e));
    }
  }

  async function refreshDeadlineInfo() {
    if (!donorVotingAddr || !eventId) {
      setDeadlineInfo(null);
      return;
    }
    try {
      // Try to get the actual DonorVoting address from Oracle modules first
      let actualDonorAddr = donorVotingAddr;
      try {
        const oracle = await oracleContract();
        const modules = await oracle.modules(eventId);
        if (modules && modules.donor !== ethers.ZeroAddress) {
          actualDonorAddr = modules.donor;
        }
      } catch (e) {
        // If Oracle lookup fails (modules not set), use the provided address
        // This is fine - we'll just read from the manually entered address
      }

      const dv = new ethers.Contract(actualDonorAddr, DonorVotingArtifact.abi, provider);
      
      // Read deadlines - these should be public view functions
      let commitDeadline = 0;
      let revealDeadline = 0;
      try {
        commitDeadline = Number(await dv.commitDeadline());
      } catch (e) {
        console.warn("Failed to read commitDeadline:", e);
      }
      try {
        revealDeadline = Number(await dv.revealDeadline());
      } catch (e) {
        console.warn("Failed to read revealDeadline:", e);
      }
      
      const now = Math.floor(Date.now() / 1000);
      setDeadlineInfo({
        commitDeadline,
        revealDeadline,
        now,
        commitReady: commitDeadline > 0 && now >= commitDeadline,
        revealReady: revealDeadline > 0 && now >= revealDeadline,
        actualAddress: actualDonorAddr,
      });
    } catch (e) {
      console.error("refreshDeadlineInfo error:", e);
      setDeadlineInfo(null);
    }
  }

  async function refreshDonorPhase() {
    if (!donorVotingAddr) {
      setDonorPhase(null);
      return;
    }
    try {
      // Try to get the actual DonorVoting address from Oracle modules first
      let actualDonorAddr = donorVotingAddr;
      if (eventId) {
        try {
          const oracle = await oracleContract();
          const modules = await oracle.modules(eventId);
          if (modules.donor !== ethers.ZeroAddress) {
            actualDonorAddr = modules.donor;
          }
        } catch (e) {
          // If Oracle lookup fails, use the provided address
        }
      }

      const dv = new ethers.Contract(actualDonorAddr, DonorVotingArtifact.abi, provider);
      const phase = await dv.phase();
      const phaseNum = Number(phase);
      setDonorPhase(phaseNum);
      const phaseName = phaseNum === 0 ? "Pending" : phaseNum === 1 ? "Commit" : phaseNum === 2 ? "Reveal" : phaseNum === 3 ? "Finalized" : `Unknown (${phaseNum})`;
      setStatus("Donor phase refreshed: " + phaseName + ` (from ${short(actualDonorAddr)})`);
      await refreshDeadlineInfo();
    } catch (e) {
      setStatus("Failed to refresh donor phase: " + (e.message || e));
      setDonorPhase(null);
    }
  }

  async function refreshOverall() {
    if (!donorVotingAddr) return;
    try {
      const dv = new ethers.Contract(donorVotingAddr, DonorVotingArtifact.abi, provider);
      const result = await dv.overallResult();
      setOverallResult({
        decided: result[0],
        passed: result[1],
        perStream: result[2],
      });
    } catch (e) {
      setStatus("Failed to fetch overall result: " + (e.message || e));
    }
  }

  async function deployDonorVoting() {
    if (!adminWallet) return setStatus("Admin wallet not ready");
    if (!eventId) return setStatus("Set eventId first (load from CharityEvent)");
    try {
      setStatus("Deploying DonorVoting...");
      const factory = new ethers.ContractFactory(
        DonorVotingArtifact.abi,
        DonorVotingArtifact.bytecode,
        adminWallet
      );
      const contract = await factory.deploy(
        addresses.Governance,
        addresses.DonorRegistry,
        addresses.DonorPledges,
        addresses.DonorRanking,
        eventId
      );
      setStatus("DonorVoting tx: " + contract.deploymentTransaction().hash);
      const deployed = await contract.waitForDeployment();
      const addr = deployed.target;
      setDonorVotingAddr(addr);
      setStatus("DonorVoting deployed at " + addr);
      await refreshDonorPhase();
    } catch (e) {
      setStatus("Deploy DonorVoting failed: " + (e.message || e));
    }
  }

  async function deployAttestorVoting() {
    if (!adminWallet) return setStatus("Admin wallet not ready");
    try {
      setStatus("Deploying AttestorVoting...");
      const factory = new ethers.ContractFactory(
        AttestorVotingArtifact.abi,
        AttestorVotingArtifact.bytecode,
        adminWallet
      );
      const contract = await factory.deploy(
        addresses.Governance,
        addresses.SGDCoin,
        addresses.AttestorRegistry
      );
      setStatus("AttestorVoting tx: " + contract.deploymentTransaction().hash);
      const deployed = await contract.waitForDeployment();
      const addr = deployed.target;
      setAttestorVotingAddr(addr);
      setStatus("AttestorVoting deployed at " + addr);
    } catch (e) {
      setStatus("Deploy AttestorVoting failed: " + (e.message || e));
    }
  }

  async function oracleContract() {
    // Account 19 has ORACLE_ROLE (set in deployment script)
    const oracleWallet = wallets[19];
    if (!oracleWallet) throw new Error("Oracle wallet (index 19) not ready");
    return new ethers.Contract(addresses.Oracle, OracleArtifact.abi, oracleWallet);
  }

  async function checkModulesStatus() {
    if (!eventId) {
      setModulesStatus({ error: "No eventId set" });
      return;
    }
    try {
      const oracle = await oracleContract();
      const modules = await oracle.modules(eventId);
      if (modules.donor === ethers.ZeroAddress || modules.attestor === ethers.ZeroAddress) {
        setModulesStatus({ 
          set: false, 
          donor: modules.donor, 
          attestor: modules.attestor,
          message: "Modules not set in Oracle"
        });
      } else {
        setModulesStatus({ 
          set: true, 
          donor: modules.donor, 
          attestor: modules.attestor,
          charity: modules.charity,
          message: "Modules are set"
        });
      }
    } catch (e) {
      const errorMsg = e.message || String(e);
      // If we can't decode (modules not set), treat it as "not set" rather than an error
      if (errorMsg.includes("could not decode") || errorMsg.includes("BAD_DATA") || errorMsg.includes("value=\"0x\"")) {
        setModulesStatus({ 
          set: false,
          donor: ethers.ZeroAddress,
          attestor: ethers.ZeroAddress,
          message: "Modules not set in Oracle (empty mapping)"
        });
      } else {
        setModulesStatus({ 
          error: errorMsg,
          message: "Could not read modules: " + errorMsg
        });
      }
    }
  }

  async function doSetModules() {
    if (!eventId || !donorVotingAddr || !attestorVotingAddr || !eventAddress) {
      return setStatus("Need eventId, eventAddress, donorVoting and attestorVoting");
    }
    try {
      const oracle = await oracleContract();
      const tx = await oracle.setModules(eventId, donorVotingAddr, attestorVotingAddr, eventAddress);
      setStatus("setModules tx: " + tx.hash);
      await tx.wait();
      
      // Verify modules were actually set
      try {
        const modules = await oracle.modules(eventId);
        if (modules.donor === ethers.ZeroAddress || modules.attestor === ethers.ZeroAddress) {
          setStatus("Warning: Modules may not have been set correctly");
        } else {
          setStatus(`Modules set successfully! Donor: ${short(modules.donor)}, Attestor: ${short(modules.attestor)}`);
        }
      } catch (e) {
        setStatus("Modules set (verification failed: " + (e.message || e) + ")");
      }
      
      await checkModulesStatus();
      await refreshDonorPhase();
      await refreshDeadlineInfo();
    } catch (e) {
      setStatus("setModules failed: " + (e.message || e));
    }
  }

  async function doSetDeadlines() {
    console.log("=== doSetDeadlines called ===");
    console.log("eventId:", eventId);
    console.log("donorVotingAddr (local state):", donorVotingAddr);
    console.log("attestorVotingAddr (local state):", attestorVotingAddr);
    
    if (!eventId) {
      console.log("FAILED: No eventId");
      return setStatus("Need eventId first");
    }
    
    try {
      // Fetch modules from Oracle contract (they might have been set in eventsPage)
      console.log("Getting oracle contract with wallet 19...");
      const oracle = await oracleContract();
      console.log("Oracle contract obtained, reading modules for eventId:", eventId);
      
      const modules = await oracle.modules(eventId);
      console.log("Modules read from contract:");
      console.log("  donor:", modules.donor);
      console.log("  attestor:", modules.attestor);
      console.log("  charity:", modules.charity);
      
      if (modules.donor === ethers.ZeroAddress || modules.attestor === ethers.ZeroAddress) {
        console.log("FAILED: Modules not set in contract");
        setStatus(`Cannot set deadlines: Modules not set in Oracle. Please set up voting modules first.`);
        await checkModulesStatus();
        return;
      }
      
      // Update local state with the addresses from Oracle
      if (!donorVotingAddr && modules.donor !== ethers.ZeroAddress) {
        console.log("Updating local donorVotingAddr from Oracle:", modules.donor);
        setDonorVotingAddr(modules.donor);
      }
      if (!attestorVotingAddr && modules.attestor !== ethers.ZeroAddress) {
        console.log("Updating local attestorVotingAddr from Oracle:", modules.attestor);
        setAttestorVotingAddr(modules.attestor);
      }
      
      console.log("Modules verified successfully");
      setStatus(`Modules verified - Donor: ${short(modules.donor)}, Attestor: ${short(modules.attestor)}`);
      
      const now = Math.floor(Date.now() / 1000);
      const commit = now + 60;
      const reveal = commit + 60;
      const commit2 = commit;
      const reveal2 = reveal;
      
      console.log("Calculated deadlines:");
      console.log("  donorCommit:", commit);
      console.log("  donorReveal:", reveal);
      console.log("  attestorCommit:", commit2);
      console.log("  attestorReveal:", reveal2);
      
      setStatus(`Setting deadlines: commit=${commit}, reveal=${reveal}...`);
      console.log("Calling oracle.setDeadlines...");
      const tx = await oracle.setDeadlines(eventId, commit, reveal, commit2, reveal2);
      console.log("Transaction sent:", tx.hash);
      setStatus("setDeadlines tx: " + tx.hash);
      console.log("Waiting for transaction confirmation...");
      const receipt = await tx.wait();
      console.log("Transaction receipt:", receipt);
      
      // Check if transaction reverted
      if (receipt.status === 0) {
        console.log("ERROR: Transaction reverted");
        return setStatus("setDeadlines transaction reverted. Check if phase is Pending.");
      }
      console.log("Transaction confirmed successfully");
      
      // Wait a bit for state to update
      await new Promise(resolve => setTimeout(resolve, 500));
      
      // Use the donor address from the modules we already fetched
      const actualDonorAddr = modules.donor;
      console.log("Verifying deadlines on DonorVoting contract:", actualDonorAddr);
      
      // Verify deadlines were set on the actual contract
      const dv = new ethers.Contract(actualDonorAddr, DonorVotingArtifact.abi, provider);
      const commitDeadline = Number(await dv.commitDeadline());
      const revealDeadline = Number(await dv.revealDeadline());
      
      if (commitDeadline === 0 || revealDeadline === 0) {
        console.log("WARNING: Deadlines may not have been set properly");
        setStatus(`Warning: Deadlines may not have been set. Commit: ${commitDeadline}, Reveal: ${revealDeadline}. Reading from: ${short(actualDonorAddr)}`);
      } else {
        console.log("SUCCESS: Deadlines set successfully");
        setStatus(`Deadlines set successfully! Commit: ${commitDeadline}, Reveal: ${revealDeadline}`);
      }
      
      // Force refresh with the correct address
      await refreshDeadlineInfo();
      await refreshDonorPhase();
    } catch (e) {
      console.error("=== ERROR in doSetDeadlines ===");
      console.error("Error object:", e);
      console.error("Error reason:", e.reason);
      console.error("Error message:", e.message);
      console.error("Error code:", e.code);
      console.error("Error data:", e.data);
      
      const errorMsg = e.reason || e.message || String(e);
      if (errorMsg.includes("donor module not set") || errorMsg.includes("attestor module not set") || errorMsg.includes("eventExists")) {
        console.log("ERROR TYPE: Modules not set");
        setStatus("setDeadlines failed: Modules not set in Oracle. Please call 'Set Modules' first.");
        await checkModulesStatus();
      } else {
        console.log("ERROR TYPE: Other error");
        setStatus("setDeadlines failed: " + errorMsg);
      }
    }
  }

  async function doAssignDonor() {
    if (!eventId || !donorVotingAddr) return setStatus("Set event & donorVoting");
    const wallet = wallets[assignDonorIndex];
    if (!wallet) return setStatus("No wallet at index " + assignDonorIndex);
    try {
      const oracle = await oracleContract();
      const addr = await wallet.getAddress();
      const tx = await oracle.assignVoter(eventId, addr, Number(assignStream));
      setStatus("assignVoter tx: " + tx.hash);
      await tx.wait();
      setStatus(`Assigned donor ${short(addr)} to stream ${assignStream}`);
    } catch (e) {
      setStatus("assignVoter failed: " + (e.message || e));
    }
  }

  async function assignSpecificDonor(donorAddress, stream) {
    if (!eventId || !donorVotingAddr) return setStatus("Set event & donorVoting");
    try {
      const oracle = await oracleContract();
      const tx = await oracle.assignVoter(eventId, donorAddress, Number(stream));
      setStatus(`Assigning ${short(donorAddress)} to stream ${stream}...`);
      await tx.wait();
      setStatus(`✓ Assigned donor ${short(donorAddress)} to stream ${stream}`);
    } catch (e) {
      setStatus(`Failed to assign ${short(donorAddress)}: ` + (e.message || e));
    }
  }

  async function doAssignAttestor() {
    if (!eventId || !attestorVotingAddr) return setStatus("Set event & attestorVoting");
    const wallet = wallets[assignAttestorIndex];
    if (!wallet) return setStatus("No wallet at index " + assignAttestorIndex);
    try {
      const oracle = await oracleContract();
      const addr = await wallet.getAddress();
      const tx = await oracle.assignAttestor(eventId, addr, Number(assignAttestorStream));
      setStatus("assignAttestor tx: " + tx.hash);
      await tx.wait();
      setStatus(`Assigned attestor ${short(addr)} to stream ${assignAttestorStream}`);
    } catch (e) {
      setStatus("assignAttestor failed: " + (e.message || e));
    }
  }

  async function doAdvanceDonorPhase() {
    if (!eventId) return setStatus("Need eventId");
    if (!donorVotingAddr) return setStatus("Need DonorVoting address");
    try {
      // Check current phase and deadlines before advancing
      const dv = new ethers.Contract(donorVotingAddr, DonorVotingArtifact.abi, provider);
      const currentPhase = Number(await dv.phase());
      const commitDeadline = Number(await dv.commitDeadline());
      const revealDeadline = Number(await dv.revealDeadline());
      const now = Math.floor(Date.now() / 1000);
      
      if (currentPhase === 0) {
        // Pending -> Commit: needs deadlines set
        if (commitDeadline === 0 || revealDeadline === 0) {
          return setStatus("Cannot advance: Deadlines not set. Please call 'Set Deadlines' first.");
        }
      } else if (currentPhase === 1) {
        // Commit -> Reveal: needs current time >= commitDeadline
        if (now < commitDeadline) {
          const waitSeconds = commitDeadline - now;
          return setStatus(`Cannot advance: Commit phase still open. Wait ${waitSeconds} seconds or mine blocks. Current: ${now}, Deadline: ${commitDeadline}`);
        }
      } else if (currentPhase === 2) {
        // Reveal -> Finalized: needs current time >= revealDeadline
        if (now < revealDeadline) {
          const waitSeconds = revealDeadline - now;
          return setStatus(`Cannot advance: Reveal phase still open. Wait ${waitSeconds} seconds or mine blocks. Current: ${now}, Deadline: ${revealDeadline}`);
        }
      } else if (currentPhase === 3) {
        return setStatus("Phase already finalized");
      }

      const oracle = await oracleContract();
      const tx = await oracle.advanceDonorPhase(eventId);
      setStatus("advanceDonorPhase tx: " + tx.hash);
      await tx.wait();
      setStatus("Donor phase advanced");
      await refreshDonorPhase();
      await refreshOverall();
    } catch (e) {
      const errorMsg = e.reason || e.message || String(e);
      setStatus("advanceDonorPhase failed: " + errorMsg);
      if (errorMsg.includes("Deadlines not set")) {
        setStatus("advanceDonorPhase failed: Deadlines not set. Please call 'Set Deadlines' first.");
      } else if (errorMsg.includes("Commit open") || errorMsg.includes("deadline")) {
        setStatus("advanceDonorPhase failed: Current time hasn't reached the deadline yet. Wait or mine blocks.");
      }
    }
  }

  async function doAdvanceAttestorPhase() {
    if (!eventId) return setStatus("Need eventId");
    try {
      const oracle = await oracleContract();
      const tx = await oracle.advanceAttestorPhase(eventId);
      setStatus("advanceAttestorPhase tx: " + tx.hash);
      await tx.wait();
      setStatus("Attestor phase advanced");
    } catch (e) {
      setStatus("advanceAttestorPhase failed: " + (e.message || e));
    }
  }

  async function doAdvanceBothPhases() {
    if (!eventId) return setStatus("Need eventId");
    try {
      const oracle = await oracleContract();
      const tx = await oracle.advanceBothPhases(eventId);
      setStatus("advanceBothPhases tx: " + tx.hash);
      await tx.wait();
      setStatus("Both phases advanced");
    } catch (e) {
      setStatus("advanceBothPhases failed: " + (e.message || e));
    }
  }

  async function donorCommit() {
    if (!donorVotingAddr) return setStatus("DonorVoting address missing");
    const wallet = wallets[commitDonorIndex];
    if (!wallet) return setStatus("No wallet at index " + commitDonorIndex);
    try {
      const saltHex = ethers.hexlify(ethers.randomBytes(32));
      const saltBig = BigInt(saltHex);
      const choiceBool = commitChoice === "true";
      const commitment = ethers.solidityPackedKeccak256(
        ["bool", "uint256"],
        [choiceBool, saltBig]
      );
      const contract = new ethers.Contract(donorVotingAddr, DonorVotingArtifact.abi, wallet);
      const tx = await contract.commit(commitment);
      setStatus("commit tx: " + tx.hash);
      await tx.wait();
      setStatus(`Commit stored for donor ${commitDonorIndex}, choice=${choiceBool}, salt=${saltHex}`);
      setSaltCache((prev) => ({
        ...prev,
        [commitDonorIndex]: { choice: choiceBool, salt: saltBig, saltHex },
      }));
      await refreshDonorPhase();
    } catch (e) {
      setStatus("Commit failed: " + (e.message || e));
    }
  }

  async function donorReveal(index) {
    if (!donorVotingAddr) return setStatus("DonorVoting address missing");
    const wallet = wallets[index];
    if (!wallet) return setStatus("No wallet at index " + index);
    const data = saltCache[index];
    if (!data) return setStatus("No cached commit for donor " + index);
    try {
      const contract = new ethers.Contract(donorVotingAddr, DonorVotingArtifact.abi, wallet);
      const tx = await contract.reveal(data.choice, data.salt);
      setStatus("reveal tx: " + tx.hash);
      await tx.wait();
      setStatus(`Reveal confirmed for donor ${index}`);
      await refreshDonorPhase();
      await refreshOverall();
    } catch (e) {
      setStatus("Reveal failed: " + (e.message || e));
    }
  }

  async function attestorCommit() {
    if (!attestorVotingAddr) return setStatus("AttestorVoting address missing");
    const wallet = wallets[commitAttestorIndex];
    if (!wallet) return setStatus("No wallet at index " + commitAttestorIndex);
    try {
      const stakeWei = ethers.parseUnits(attestorStake, 18);
      
      // First approve SGD token spending
      const sgd = new ethers.Contract(addresses.SGDCoin, SGDCoinArtifact.abi, wallet);
      setStatus("Approving SGD token for staking...");
      const approveTx = await sgd.approve(attestorVotingAddr, stakeWei);
      await approveTx.wait();
      
      // Generate commitment
      const saltHex = ethers.hexlify(ethers.randomBytes(32));
      const saltBig = BigInt(saltHex);
      const choiceBool = commitAttestorChoice === "true";
      const commitment = ethers.solidityPackedKeccak256(
        ["bool", "uint256"],
        [choiceBool, saltBig]
      );
      
      const contract = new ethers.Contract(attestorVotingAddr, AttestorVotingArtifact.abi, wallet);
      setStatus("Committing attestor vote with stake...");
      const tx = await contract.commit(commitment, stakeWei);
      setStatus("commit tx: " + tx.hash);
      await tx.wait();
      setStatus(`Commit stored for attestor ${commitAttestorIndex}, choice=${choiceBool}, stake=${attestorStake} SGD, salt=${saltHex}`);
      setAttestorSaltCache((prev) => ({
        ...prev,
        [commitAttestorIndex]: { choice: choiceBool, salt: saltBig, saltHex, stake: attestorStake },
      }));
    } catch (e) {
      setStatus("Attestor commit failed: " + (e.message || e));
    }
  }

  async function attestorReveal(index) {
    if (!attestorVotingAddr) return setStatus("AttestorVoting address missing");
    const wallet = wallets[index];
    if (!wallet) return setStatus("No wallet at index " + index);
    const data = attestorSaltCache[index];
    if (!data) return setStatus("No cached commit for attestor " + index);
    try {
      const contract = new ethers.Contract(attestorVotingAddr, AttestorVotingArtifact.abi, wallet);
      const tx = await contract.reveal(data.choice, data.salt);
      setStatus("reveal tx: " + tx.hash);
      await tx.wait();
      setStatus(`Reveal confirmed for attestor ${index}`);
    } catch (e) {
      setStatus("Attestor reveal failed: " + (e.message || e));
    }
  }

  async function doSettleAttestors() {
    if (!eventId) return setStatus("Need eventId");
    try {
      const oracle = await oracleContract();
      const tx = await oracle.settleAttestors(eventId);
      setStatus("settleAttestors tx: " + tx.hash);
      await tx.wait();
      setStatus("Attestors settled");
    } catch (e) {
      setStatus("settleAttestors failed: " + (e.message || e));
    }
  }

  async function doDisburse() {
    if (!eventId) return setStatus("Need eventId");
    try {
      const oracle = await oracleContract();
      const tx = await oracle.disburseIfVerified(eventId);
      setStatus("disburseIfVerified tx: " + tx.hash);
      await tx.wait();
      setStatus("Disbursement executed (if verified)");
      await loadEventSummary(eventAddress);
    } catch (e) {
      setStatus("Disburse failed: " + (e.message || e));
    }
  }

  function donorOptions() {
    const opts = [];
    for (let i = 0; i < wallets.length; i++) {
      opts.push(
        <option key={i} value={i}>
          {i} - {wallets[i] ? short(wallets[i].address) : "unknown"}
        </option>
      );
    }
    return opts;
  }

  // Event listeners for DonorVoting, AttestorVoting, and Oracle
  useEffect(() => {
    const provider = new ethers.JsonRpcProvider(rpcUrl);

    function pushEvent(obj) {
      setEvents((prev) => [obj, ...prev].slice(0, 200));
    }

    const cleanupFunctions = [];

    // Listen to DonorVoting events
    if (donorVotingAddr) {
      const dv = new ethers.Contract(donorVotingAddr, DonorVotingArtifact.abi, provider);
      
      const onVoterAssigned = (voter, stream, event) => {
        pushEvent({ id: Date.now() + Math.random(), type: 'VoterAssigned', voter, stream: Number(stream), tx: event.transactionHash });
      };
      const onVoted = (voter, stream, event) => {
        pushEvent({ id: Date.now() + Math.random(), type: 'Voted', voter, stream: Number(stream), tx: event.transactionHash });
      };
      const onRevealed = (voter, stream, choice, weight, event) => {
        pushEvent({ id: Date.now() + Math.random(), type: 'Revealed', voter, stream: Number(stream), choice, weight: weight.toString(), tx: event.transactionHash });
      };
      const onFinalized = (overallPassed, streamResults, event) => {
        pushEvent({ id: Date.now() + Math.random(), type: 'Finalized', overallPassed, streamResults: streamResults.map(String), tx: event.transactionHash });
      };
      const onPhaseAdvanced = (newPhase, event) => {
        pushEvent({ id: Date.now() + Math.random(), type: 'DonorPhaseAdvanced', newPhase: Number(newPhase), tx: event.transactionHash });
      };

      try { dv.on('VoterAssigned', onVoterAssigned); } catch (e) {}
      try { dv.on('Voted', onVoted); } catch (e) {}
      try { dv.on('Revealed', onRevealed); } catch (e) {}
      try { dv.on('Finalized', onFinalized); } catch (e) {}
      try { dv.on('PhaseAdvanced', onPhaseAdvanced); } catch (e) {}

      cleanupFunctions.push(() => {
        try { dv.off('VoterAssigned', onVoterAssigned); } catch (e) {}
        try { dv.off('Voted', onVoted); } catch (e) {}
        try { dv.off('Revealed', onRevealed); } catch (e) {}
        try { dv.off('Finalized', onFinalized); } catch (e) {}
        try { dv.off('PhaseAdvanced', onPhaseAdvanced); } catch (e) {}
      });
    }

    // Listen to Oracle events
    if (addresses.Oracle && eventId) {
      const oracle = new ethers.Contract(addresses.Oracle, OracleArtifact.abi, provider);
      
      const onModulesSet = (evId, donor, attestor, charity, event) => {
        if (evId === eventId) {
          pushEvent({ id: Date.now() + Math.random(), type: 'ModulesSet', eventId: evId, donor, attestor, charity, tx: event.transactionHash });
        }
      };
      const onVoterAssigned = (evId, voter, stream, event) => {
        if (evId === eventId) {
          pushEvent({ id: Date.now() + Math.random(), type: 'OracleVoterAssigned', eventId: evId, voter, stream: Number(stream), tx: event.transactionHash });
        }
      };
      const onPhasesAdvanced = (evId, which, event) => {
        if (evId === eventId) {
          pushEvent({ id: Date.now() + Math.random(), type: 'PhasesAdvanced', eventId: evId, which, tx: event.transactionHash });
        }
      };
      const onDisbursed = (evId, to, event) => {
        if (evId === eventId) {
          pushEvent({ id: Date.now() + Math.random(), type: 'Disbursed', eventId: evId, to, tx: event.transactionHash });
        }
      };

      try { oracle.on('ModulesSet', onModulesSet); } catch (e) {}
      try { oracle.on('VoterAssigned', onVoterAssigned); } catch (e) {}
      try { oracle.on('PhasesAdvanced', onPhasesAdvanced); } catch (e) {}
      try { oracle.on('Disbursed', onDisbursed); } catch (e) {}

      cleanupFunctions.push(() => {
        try { oracle.off('ModulesSet', onModulesSet); } catch (e) {}
        try { oracle.off('VoterAssigned', onVoterAssigned); } catch (e) {}
        try { oracle.off('PhasesAdvanced', onPhasesAdvanced); } catch (e) {}
        try { oracle.off('Disbursed', onDisbursed); } catch (e) {}
      });
    }

    return () => {
      cleanupFunctions.forEach(fn => fn());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [donorVotingAddr, eventId]);

  return (
    <div style={{ padding: 20 }}>
      <h2>Voting & Oracle Orchestration</h2>
      <div style={{ marginBottom: 8 }}>{status}</div>

      <div style={{ display: 'flex', gap: 12 }}>
        <div style={{ flex: 2 }}>

      <section style={{ marginBottom: 16 }}>
        <h3>Load Event Context</h3>
        <div style={{ display: "grid", gap: 8, maxWidth: 600 }}>
          <input
            placeholder="CharityEvent address"
            value={eventAddress}
            onChange={(e) => setEventAddress(e.target.value)}
          />
          <div>
            <button onClick={() => loadEventSummary(eventAddress)}>Load Event Summary</button>
          </div>
          <div>eventId: <code>{eventId || "n/a"}</code></div>
          {eventSummary ? (
            <div style={{ fontSize: 14, color: "#444" }}>
              <div>phase: {eventSummary.phase}</div>
              <div>goal: {eventSummary.goal?.toString?.() ?? ""}</div>
              <div>raised: {eventSummary.raised?.toString?.() ?? ""}</div>
              <div>beneficiary: <code>{eventSummary.beneficiary}</code></div>
              <div>verified: {String(eventSummary.verified)}</div>
            </div>
          ) : (
            <div style={{ color: "#777" }}>Load event summary to populate eventId.</div>
          )}
        </div>
      </section>

      <section style={{ marginBottom: 16 }}>
        <h3>Oracle Setup & Voting Control</h3>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <button onClick={doSetDeadlines}>Set Deadlines (+60s/+120s)</button>
          <button onClick={doAdvanceDonorPhase}>Advance Donor Phase</button>
          <button onClick={doAdvanceAttestorPhase}>Advance Attestor Phase</button>
          <button onClick={doAdvanceBothPhases}>Advance Both Phases</button>
        </div>
        {modulesStatus && (
          <div style={{ marginTop: 12, padding: 8, backgroundColor: modulesStatus.set ? "#d4edda" : "#f8d7da", borderRadius: 4, fontSize: 13 }}>
            <div><strong>Modules Status:</strong> {modulesStatus.message}</div>
            {modulesStatus.set && (
              <div style={{ marginTop: 4, fontSize: 12 }}>
                <div>Donor: <code>{short(modulesStatus.donor)}</code></div>
                <div>Attestor: <code>{short(modulesStatus.attestor)}</code></div>
                {modulesStatus.charity && <div>Charity: <code>{short(modulesStatus.charity)}</code></div>}
              </div>
            )}
            {modulesStatus.error && (
              <div style={{ marginTop: 4, fontSize: 11, color: "#721c24" }}>Error: {modulesStatus.error}</div>
            )}
          </div>
        )}
        <div style={{ marginTop: 12, display: "grid", gap: 8, maxWidth: 600 }}>
          <div style={{ padding: 8, backgroundColor: "#fff3cd", borderRadius: 4, fontSize: 12 }}>
            <strong>ℹ️ Typical Setup:</strong> Donors (accounts 1-10), Attestors (accounts 11-18), Oracle (account 19)
          </div>
          
          <div style={{ marginTop: 8 }}>
            <strong>Assign Donors (who pledged funds)</strong>
          </div>
          {donorPledgesList.length === 0 ? (
            <div style={{ padding: 8, backgroundColor: "#f8f9fa", borderRadius: 4, fontSize: 13, color: "#666" }}>
              No donors with pledges found. Load event first or create pledges.
            </div>
          ) : (
            <div style={{ display: "grid", gap: 8, marginTop: 8 }}>
              {donorPledgesList.map((donor) => (
                <div
                  key={donor.address}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    padding: 12,
                    border: "1px solid #ddd",
                    borderRadius: 6,
                    backgroundColor: "#f8f9fa",
                  }}
                >
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13, fontFamily: "monospace", fontWeight: "bold" }}>
                      {short(donor.address)}
                    </div>
                    <div style={{ fontSize: 12, color: "#666", marginTop: 2 }}>
                      Pledged: {ethers.formatUnits(donor.amount, 18)} SGD
                    </div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <label style={{ fontSize: 12, margin: 0 }}>
                      Stream:
                      <select
                        value={donorStreamSelections[donor.address] || 0}
                        onChange={(e) =>
                          setDonorStreamSelections((prev) => ({
                            ...prev,
                            [donor.address]: Number(e.target.value),
                          }))
                        }
                        style={{ marginLeft: 6, padding: 4 }}
                      >
                        <option value="0">0</option>
                        <option value="1">1</option>
                        <option value="2">2</option>
                      </select>
                    </label>
                    <button
                      onClick={() =>
                        assignSpecificDonor(
                          donor.address,
                          donorStreamSelections[donor.address] || 0
                        )
                      }
                      style={{
                        padding: "6px 12px",
                        fontSize: 12,
                        backgroundColor: "#007bff",
                        color: "white",
                        border: "none",
                        borderRadius: 4,
                        cursor: "pointer",
                      }}
                    >
                      Assign
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
          <div style={{ marginTop: 8 }}>
            <button
              onClick={fetchDonorsWithPledges}
              style={{
                padding: "6px 12px",
                fontSize: 12,
                backgroundColor: "#6c757d",
                color: "white",
                border: "none",
                borderRadius: 4,
                cursor: "pointer",
              }}
            >
              Refresh Donor List
            </button>
          </div>
          
          <div style={{ marginTop: 16, paddingTop: 16, borderTop: "1px solid #ddd" }}>
            <strong>Assign Attestors (independent verifiers)</strong>
          </div>
          <div style={{ padding: 8, backgroundColor: "#ffe7e7", borderRadius: 4, fontSize: 11, marginBottom: 8 }}>
            <strong>⚠️ Attestors must:</strong><br/>
            1. Be registered in AttestorRegistry first<br/>
            2. Approve SGD token spending for staking<br/>
            3. Have enough SGD balance for stake (amount chosen during commit)<br/>
            4. Stake is between sigmaMin and sigmaMax (configurable, check contract)
          </div>
          <label>
            Attestor wallet index
            <select value={assignAttestorIndex} onChange={(e) => setAssignAttestorIndex(Number(e.target.value))}>
              {donorOptions()}
            </select>
          </label>
          <label>
            Stream (0-2)
            <input
              type="number"
              min="0"
              max="2"
              value={assignAttestorStream}
              onChange={(e) => setAssignAttestorStream(Number(e.target.value))}
            />
          </label>
          <button onClick={doAssignAttestor}>Assign Attestor to Stream</button>
          
          <div style={{ marginTop: 16, padding: 8, backgroundColor: "#e7f3ff", borderRadius: 4, fontSize: 12 }}>
            <strong>🎯 Phase Advancement:</strong><br/>
            • Use "Advance Donor/Attestor Phase" AFTER setup is complete<br/>
            • Pending → Commit: Opens voting (after deadlines set & voters assigned)<br/>
            • Commit → Reveal: Must wait until commitDeadline passes<br/>
            • Reveal → Finalized: Must wait until revealDeadline passes<br/>
            • Use "Advance Both Phases" to move both donor & attestor together
          </div>
        </div>
      </section>

      <section style={{ marginBottom: 16 }}>
        <h3>Donor Commit-Reveal</h3>
        <div style={{ display: "grid", gap: 8, maxWidth: 600 }}>
          <div style={{ padding: 8, backgroundColor: "#e7f3ff", borderRadius: 4, fontSize: 12, marginBottom: 8 }}>
            <strong>📅 How Deadlines Work:</strong>
            <div style={{ marginTop: 4 }}>
              • <strong>Pending</strong> → Set deadlines first<br/>
              • <strong>Commit Phase</strong> → Vote before commit deadline (vote is secret)<br/>
              • <strong>Reveal Phase</strong> → Reveal vote after commit deadline, before reveal deadline<br/>
              • <strong>Finalized</strong> → Voting closed, results calculated<br/>
              • ⚠️ <strong>Late votes REVERT</strong> - you MUST vote before the deadline!
            </div>
          </div>
          
          <div style={{ padding: 8, backgroundColor: "#f0f0f0", borderRadius: 4 }}>
            <strong>Current Phase:</strong> {donorPhase === null ? "Not loaded" : donorPhase === 0 ? "Pending" : donorPhase === 1 ? "Commit ✓" : donorPhase === 2 ? "Reveal ✓" : donorPhase === 3 ? "Finalized ✓" : "Unknown"}
            <button style={{ marginLeft: 8 }} onClick={refreshDonorPhase}>Refresh Phase</button>
          </div>
          {deadlineInfo && (
            <div style={{ padding: 8, backgroundColor: "#e8f4f8", borderRadius: 4, fontSize: 13 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div><strong>Deadline Info:</strong> {deadlineInfo.actualAddress && <span style={{ fontSize: 11, color: "#666" }}>(from {short(deadlineInfo.actualAddress)})</span>}</div>
                <button style={{ fontSize: 11, padding: "2px 8px" }} onClick={refreshDeadlineInfo}>Refresh</button>
              </div>
              <div>Commit Deadline: {deadlineInfo.commitDeadline > 0 ? deadlineInfo.commitDeadline : "Not set"} 
                {deadlineInfo.commitDeadline > 0 && (
                  <span style={{ color: deadlineInfo.commitReady ? "#28a745" : "#dc3545" }}>
                    {deadlineInfo.commitReady ? " ✓ Ready" : ` (Wait ${deadlineInfo.commitDeadline - deadlineInfo.now}s)`}
                  </span>
                )}
              </div>
              <div>Reveal Deadline: {deadlineInfo.revealDeadline > 0 ? deadlineInfo.revealDeadline : "Not set"}
                {deadlineInfo.revealDeadline > 0 && (
                  <span style={{ color: deadlineInfo.revealReady ? "#28a745" : "#dc3545" }}>
                    {deadlineInfo.revealReady ? " ✓ Ready" : ` (Wait ${deadlineInfo.revealDeadline - deadlineInfo.now}s)`}
                  </span>
                )}
              </div>
              <div style={{ fontSize: 11, color: "#666" }}>Current Time: {deadlineInfo.now}</div>
              {deadlineInfo.actualAddress && deadlineInfo.actualAddress.toLowerCase() !== donorVotingAddr.toLowerCase() && (
                <div style={{ fontSize: 11, color: "#dc3545", marginTop: 4 }}>
                  ⚠️ Address mismatch: Using {short(deadlineInfo.actualAddress)} from Oracle modules instead of {short(donorVotingAddr)}
                </div>
              )}
            </div>
          )}
          <label>
            Donor wallet index
            <select value={commitDonorIndex} onChange={(e) => setCommitDonorIndex(Number(e.target.value))}>
              {donorOptions()}
            </select>
          </label>
          <label>
            Vote choice
            <select value={commitChoice} onChange={(e) => setCommitChoice(e.target.value)}>
              <option value="true">Approve (true)</option>
              <option value="false">Reject (false)</option>
            </select>
          </label>
          <button onClick={donorCommit} disabled={donorPhase !== 1}>
            Commit Vote {donorPhase !== 1 ? "(Phase must be Commit)" : ""}
          </button>
          <button onClick={() => donorReveal(commitDonorIndex)} disabled={donorPhase !== 2}>
            Reveal Vote (using cached salt) {donorPhase !== 2 ? "(Phase must be Reveal)" : ""}
          </button>
          <div style={{ fontSize: 13, color: "#444" }}>
            Cached commits:
            <ul>
              {Object.entries(saltCache).map(([idx, data]) => (
                <li key={idx}>
                  Donor {idx}: choice={String(data.choice)} salt={data.saltHex}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      <section style={{ marginBottom: 16 }}>
        <h3>Attestor Commit-Reveal (with Staking)</h3>
        <div style={{ display: "grid", gap: 8, maxWidth: 600 }}>
          <div style={{ padding: 8, backgroundColor: "#fff3cd", borderRadius: 4, fontSize: 12 }}>
            <strong>💰 Attestor Staking:</strong><br/>
            • Attestors stake SGD tokens when committing<br/>
            • <strong>Correct vote</strong> → Get stake back + share of slashed funds<br/>
            • <strong>Wrong vote</strong> → Stake is slashed and redistributed<br/>
            • Stake amount: You choose (within sigmaMin/sigmaMax bounds)
          </div>
          
          <label>
            Attestor wallet index
            <select value={commitAttestorIndex} onChange={(e) => setCommitAttestorIndex(Number(e.target.value))}>
              {donorOptions()}
            </select>
          </label>
          <label>
            Vote choice
            <select value={commitAttestorChoice} onChange={(e) => setCommitAttestorChoice(e.target.value)}>
              <option value="true">Pass (true)</option>
              <option value="false">Fail (false)</option>
            </select>
          </label>
          <label>
            Stake Amount (SGD tokens)
            <input
              type="text"
              value={attestorStake}
              onChange={(e) => setAttestorStake(e.target.value)}
              placeholder="e.g., 1000"
            />
          </label>
          <button onClick={attestorCommit}>
            Commit Attestor Vote (with Stake)
          </button>
          <button onClick={() => attestorReveal(commitAttestorIndex)}>
            Reveal Attestor Vote
          </button>
          <div style={{ fontSize: 13, color: "#444" }}>
            Cached attestor commits:
            <ul>
              {Object.entries(attestorSaltCache).map(([idx, data]) => (
                <li key={idx}>
                  Attestor {idx}: choice={String(data.choice)} stake={data.stake} SGD salt={data.saltHex}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      <section style={{ marginBottom: 16 }}>
        <h3>Results & Settlement</h3>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 8 }}>
          <button onClick={refreshOverall}>Refresh Overall Result</button>
          <button onClick={doSettleAttestors}>Settle Attestors</button>
          <button onClick={doDisburse}>Disburse If Verified</button>
        </div>
        {overallResult ? (
          <div style={{ fontSize: 14 }}>
            <div>Decided: {String(overallResult.decided)}</div>
            <div>Passed: {String(overallResult.passed)}</div>
            <div>Per stream: [{overallResult.perStream?.join(", ")}]</div>
          </div>
        ) : (
          <div style={{ color: "#777" }}>No voting result yet.</div>
        )}
      </section>
        </div>

        <div style={{ flex: 1, borderLeft: '1px solid #eee', paddingLeft: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h3 style={{ margin: 0 }}>Event Log</h3>
            <div><button onClick={() => setEvents([])}>Clear</button></div>
          </div>
          <div style={{ marginTop: 8, maxHeight: '70vh', overflow: 'auto' }}>
            {events.length === 0 ? (
              <div style={{ color: '#666' }}>No events yet. Events (VoterAssigned, Voted, Revealed, Finalized, ModulesSet, PhasesAdvanced, Disbursed, etc.) will appear here.</div>
            ) : (
              events.map((ev) => (
                <div key={ev.id} style={{ borderBottom: '1px solid #f0f0f0', padding: 8 }}>
                  <div style={{ fontSize: 12, color: '#999' }}>{new Date().toLocaleTimeString()}</div>
                  <div style={{ fontWeight: 700 }}>{ev.type}</div>
                  {ev.type === 'VoterAssigned' && (
                    <div>
                      <div>voter: <span style={{ fontFamily: 'monospace', fontSize: 12 }}>{short(ev.voter)}</span></div>
                      <div>stream: {ev.stream}</div>
                      <div style={{ fontSize: 11, color: '#666' }}>tx: {ev.tx}</div>
                    </div>
                  )}
                  {ev.type === 'Voted' && (
                    <div>
                      <div>voter: <span style={{ fontFamily: 'monospace', fontSize: 12 }}>{short(ev.voter)}</span></div>
                      <div>stream: {ev.stream}</div>
                      <div style={{ fontSize: 11, color: '#666' }}>tx: {ev.tx}</div>
                    </div>
                  )}
                  {ev.type === 'Revealed' && (
                    <div>
                      <div>voter: <span style={{ fontFamily: 'monospace', fontSize: 12 }}>{short(ev.voter)}</span></div>
                      <div>stream: {ev.stream}</div>
                      <div>choice: {String(ev.choice)}</div>
                      <div>weight: {ev.weight}</div>
                      <div style={{ fontSize: 11, color: '#666' }}>tx: {ev.tx}</div>
                    </div>
                  )}
                  {ev.type === 'Finalized' && (
                    <div>
                      <div>overallPassed: {String(ev.overallPassed)}</div>
                      <div>streamResults: [{ev.streamResults?.join(', ')}]</div>
                      <div style={{ fontSize: 11, color: '#666' }}>tx: {ev.tx}</div>
                    </div>
                  )}
                  {ev.type === 'DonorPhaseAdvanced' && (
                    <div>
                      <div>newPhase: {ev.newPhase}</div>
                      <div style={{ fontSize: 11, color: '#666' }}>tx: {ev.tx}</div>
                    </div>
                  )}
                  {ev.type === 'ModulesSet' && (
                    <div>
                      <div>eventId: <span style={{ fontFamily: 'monospace', fontSize: 12 }}>{short(ev.eventId)}</span></div>
                      <div>donor: <span style={{ fontFamily: 'monospace', fontSize: 12 }}>{short(ev.donor)}</span></div>
                      <div>attestor: <span style={{ fontFamily: 'monospace', fontSize: 12 }}>{short(ev.attestor)}</span></div>
                      <div>charity: <span style={{ fontFamily: 'monospace', fontSize: 12 }}>{short(ev.charity)}</span></div>
                      <div style={{ fontSize: 11, color: '#666' }}>tx: {ev.tx}</div>
                    </div>
                  )}
                  {ev.type === 'OracleVoterAssigned' && (
                    <div>
                      <div>eventId: <span style={{ fontFamily: 'monospace', fontSize: 12 }}>{short(ev.eventId)}</span></div>
                      <div>voter: <span style={{ fontFamily: 'monospace', fontSize: 12 }}>{short(ev.voter)}</span></div>
                      <div>stream: {ev.stream}</div>
                      <div style={{ fontSize: 11, color: '#666' }}>tx: {ev.tx}</div>
                    </div>
                  )}
                  {ev.type === 'PhasesAdvanced' && (
                    <div>
                      <div>eventId: <span style={{ fontFamily: 'monospace', fontSize: 12 }}>{short(ev.eventId)}</span></div>
                      <div>which: {ev.which}</div>
                      <div style={{ fontSize: 11, color: '#666' }}>tx: {ev.tx}</div>
                    </div>
                  )}
                  {ev.type === 'Disbursed' && (
                    <div>
                      <div>eventId: <span style={{ fontFamily: 'monospace', fontSize: 12 }}>{short(ev.eventId)}</span></div>
                      <div>to: <span style={{ fontFamily: 'monospace', fontSize: 12 }}>{short(ev.to)}</span></div>
                      <div style={{ fontSize: 11, color: '#666' }}>tx: {ev.tx}</div>
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}


