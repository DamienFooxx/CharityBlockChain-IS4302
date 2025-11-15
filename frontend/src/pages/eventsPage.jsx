import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import addresses from "../config/addresses.json";
import CharityEventArtifact from "../abi/CharityEvent.json";
import DonorPledgesArtifact from "../abi/DonorPledges.json";
import SGDCoinArtifact from "../abi/SGDCoin.json";
import CharityRegistryArtifact from "../abi/CharityRegistry.json";
import DonorVotingArtifact from "../abi/DonorVoting.json";
import AttestorVotingArtifact from "../abi/AttestorVoting.json";
import OracleArtifact from "../abi/Oracle.json";
import { getWallets } from "../utils/wallets";

export default function EventsPage() {
  const rpcUrl = "http://127.0.0.1:8545";
  const [status, setStatus] = useState("");

  // Charity context (uses local wallet index 12)
  const [charityWallet, setCharityWallet] = useState(null);
  const [charityAddr, setCharityAddr] = useState(null);
  const [orgId, setOrgId] = useState(0);
  const [beneficiaryTreasury, setBeneficiaryTreasury] = useState(null);
  const [isApproved, setIsApproved] = useState(false);

  // Event data - now supports multiple events with localStorage persistence
  const [eventsList, setEventsList] = useState(() => {
    // Load events from localStorage on init
    try {
      const stored = localStorage.getItem('charityEvents');
      return stored ? JSON.parse(stored) : [];
    } catch (e) {
      console.error('Failed to load events from localStorage:', e);
      return [];
    }
  });
  const [selectedEventNum, setSelectedEventNum] = useState(1); // Which event to view/interact with
  const [eventSummary, setEventSummary] = useState(null);
  const [setupVotingFor, setSetupVotingFor] = useState(null); // Track which event is being set up

  // Create form
  const [goal, setGoal] = useState("100"); // human tokens
  const [durationSecs, setDurationSecs] = useState("3600");
  const [description, setDescription] = useState("Demo Event");

  // Evidence form
  const [evidenceCID, setEvidenceCID] = useState("");
  const [evidenceEventNum, setEvidenceEventNum] = useState(1);

  // Donor pledge form (uses local wallet index 1 by default)
  const [donorIndex, setDonorIndex] = useState(1);
  const [pledgeAmount, setPledgeAmount] = useState("50");
  const [pledgeEventNum, setPledgeEventNum] = useState(1);

  // Event log
  const [events, setEvents] = useState([]);

  useEffect(() => {
    (async () => {
      try {
        const wallets = await getWallets(rpcUrl);
        if (wallets.length < 13) {
          setStatus("Need at least 13 local keys (index 0..12).");
          return;
        }
        const w = wallets[12];
        setCharityWallet(w);
        const addr = await w.getAddress();
        setCharityAddr(addr);
        setStatus("Loaded charity wallet: " + addr);
        await loadCharityContext(addr);
      } catch (e) {
        setStatus("Failed to init: " + (e.message || e));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadCharityContext(walletAddr) {
    try {
      const provider = new ethers.JsonRpcProvider(rpcUrl);
      const reg = new ethers.Contract(addresses.CharityRegistry, CharityRegistryArtifact.abi, provider);
      const oid = await reg.addressToOrgId(walletAddr);
      setOrgId(Number(oid));
      if (Number(oid) === 0) {
        setStatus((s) => (s ? s + " | Charity not registered" : "Charity not registered"));
        return;
      }
      const profile = await reg.getCharity(walletAddr);
      setIsApproved(profile.approved);
      if (!profile.approved) {
        setStatus((s) => (s ? s + " | Charity not approved yet (admin must approve)" : "Charity not approved yet (admin must approve)"));
        return;
      }
      if (!profile.treasury || profile.treasury === ethers.ZeroAddress) {
        setStatus((s) => (s ? s + " | Treasury not assigned/created yet" : "Treasury not assigned/created yet"));
        return;
      }
      setBeneficiaryTreasury(profile.treasury);
    } catch (e) {
      setStatus("Failed to load charity context: " + (e.message || e));
    }
  }

  function genEventId() {
    const seed = `${Date.now()}-${charityAddr}-${description}-${Math.random()}`;
    return ethers.keccak256(ethers.toUtf8Bytes(seed));
  }

  async function deployEvent() {
    if (!charityWallet) return setStatus("Charity wallet not ready");
    if (!isApproved) return setStatus("Charity not approved yet (admin must approve first)");
    if (!beneficiaryTreasury) return setStatus("No beneficiary treasury found (admin must set and create)");
    try {
      setStatus("Deploying CharityEvent...");
      const provider = charityWallet.provider;
      const block = await provider.getBlock("latest");
      const deadline = BigInt(block.timestamp) + BigInt(durationSecs || "3600");
      const goalWei = await doParseUnits(goal);

      const factory = new ethers.ContractFactory(
        CharityEventArtifact.abi,
        CharityEventArtifact.bytecode,
        charityWallet
      );
      const evId = genEventId();
      const ctr = await factory.deploy(
        addresses.Governance,
        addresses.CharityRegistry,
        evId,
        BigInt(orgId),
        beneficiaryTreasury,
        goalWei,
        deadline,
        description || "Event"
      );
      setStatus("Tx sent: " + ctr.deploymentTransaction().hash);
      const deployed = await ctr.waitForDeployment();
      const addr = deployed.target;
      
      // Add to events list and persist to localStorage
      const nextEventNum = eventsList.length + 1;
      const newEvent = { eventNumber: nextEventNum, address: addr, eventId: evId };
      const updatedList = [...eventsList, newEvent];
      setEventsList(updatedList);
      
      // Persist to localStorage
      try {
        localStorage.setItem('charityEvents', JSON.stringify(updatedList));
      } catch (e) {
        console.error('Failed to save events to localStorage:', e);
      }
      
      setSelectedEventNum(nextEventNum);
      
      setStatus(`Event ${nextEventNum} deployed at ${addr}`);
      await refreshSummary(addr);
    } catch (e) {
      setStatus("Deploy failed: " + (e.message || e));
    }
  }

  async function refreshSummary(addressOverride) {
    try {
      const eventToLoad = addressOverride || getSelectedEvent()?.address;
      if (!eventToLoad) {
        setEventSummary(null);
        return;
      }
      const provider = new ethers.JsonRpcProvider(rpcUrl);
      const ev = new ethers.Contract(eventToLoad, CharityEventArtifact.abi, provider);
      const s = await ev.getEventSummary();
      // decode tuple into readable object
      setEventSummary({
        eventId: s[0],
        orgId: s[1],
        phase: s[2], // 0 FUNDING, 1 CLOSED, 2 VERIFICATION, 3 APPROVED, 4 COMPLETED, 5 REJECTED, 6 CANCELLED
        goal: s[3],
        raised: s[4],
        beneficiary: s[5],
        verified: s[6]
      });
    } catch (e) {
      setStatus("Failed to load summary: " + (e.message || e));
    }
  }

  function getSelectedEvent() {
    return eventsList.find(e => e.eventNumber === selectedEventNum);
  }

  function getEventByNumber(num) {
    return eventsList.find(e => e.eventNumber === num);
  }

  async function setupVotingModules(eventNum) {
    const event = getEventByNumber(eventNum);
    if (!event) return setStatus(`Event ${eventNum} not found`);
    if (event.donorVoting && event.attestorVoting) {
      return setStatus(`Voting already set up for Event ${eventNum}`);
    }

    setSetupVotingFor(eventNum);
    setStatus(`Setting up voting modules for Event ${eventNum}...`);

    try {
      // Get oracle wallet (account 19)
      const wallets = await getWallets(rpcUrl);
      const oracleWallet = wallets[19]; // Account 19 has oracle role
      
      // Get provider for nonce management
      const provider = new ethers.JsonRpcProvider(rpcUrl);
      let currentNonce = await provider.getTransactionCount(oracleWallet.address, "latest");
      
      // 1. Deploy DonorVoting with explicit nonce
      setStatus(`Deploying DonorVoting for Event ${eventNum}...`);
      const donorVotingFactory = new ethers.ContractFactory(
        DonorVotingArtifact.abi,
        DonorVotingArtifact.bytecode,
        oracleWallet
      );
      const donorVoting = await donorVotingFactory.deploy(
        addresses.Governance,
        addresses.DonorRegistry,
        addresses.DonorPledges,
        addresses.DonorRanking,
        event.eventId,
        { nonce: currentNonce++ }
      );
      await donorVoting.waitForDeployment();
      const donorVotingAddr = donorVoting.target;
      setStatus(`DonorVoting deployed: ${donorVotingAddr}`);

      // 2. Deploy AttestorVoting with explicit nonce
      setStatus(`Deploying AttestorVoting for Event ${eventNum}...`);
      const attestorVotingFactory = new ethers.ContractFactory(
        AttestorVotingArtifact.abi,
        AttestorVotingArtifact.bytecode,
        oracleWallet
      );
      const attestorVoting = await attestorVotingFactory.deploy(
        addresses.Governance,
        addresses.SGDCoin,
        addresses.AttestorRegistry,
        { nonce: currentNonce++ }
      );
      await attestorVoting.waitForDeployment();
      const attestorVotingAddr = attestorVoting.target;
      setStatus(`AttestorVoting deployed: ${attestorVotingAddr}`);

      // 3. Register with Oracle with explicit nonce
      setStatus(`Registering voting modules with Oracle...`);
      const oracle = new ethers.Contract(addresses.Oracle, OracleArtifact.abi, oracleWallet);
      const tx = await oracle.setModules(
        event.eventId,
        donorVotingAddr,
        attestorVotingAddr,
        event.address,
        { nonce: currentNonce++ }
      );
      setStatus(`Oracle.setModules tx: ${tx.hash}`);
      const receipt = await tx.wait();
      
      // Parse ModulesSet event from Oracle
      const modulesSetEvent = receipt.logs
        .map(log => {
          try {
            return oracle.interface.parseLog(log);
          } catch {
            return null;
          }
        })
        .find(parsed => parsed && parsed.name === 'ModulesSet');
      
      if (modulesSetEvent) {
        const timestamp = new Date().toLocaleTimeString();
        setEvents((prev) => [
          {
            time: timestamp,
            name: 'ModulesSet',
            data: {
              'Event': `#${eventNum}`,
              'eventId': modulesSetEvent.args[0],
              'DonorVoting': modulesSetEvent.args[1],
              'AttestorVoting': modulesSetEvent.args[2],
              'CharityEvent': modulesSetEvent.args[3],
              'tx': tx.hash,
            }
          },
          ...prev,
        ]);
      }
      
      setStatus(`Voting modules registered with Oracle!`);

      // 4. Update event in localStorage
      const updatedEvent = {
        ...event,
        donorVoting: donorVotingAddr,
        attestorVoting: attestorVotingAddr,
        votingSetup: true
      };
      const updatedList = eventsList.map(e => 
        e.eventNumber === eventNum ? updatedEvent : e
      );
      setEventsList(updatedList);
      localStorage.setItem('charityEvents', JSON.stringify(updatedList));
      
      setStatus(`✓ Voting setup complete for Event ${eventNum}`);
      setSetupVotingFor(null);
    } catch (e) {
      setStatus(`Voting setup failed: ${e.message || e}`);
      setSetupVotingFor(null);
    }
  }

  async function closeFunding() {
    const event = getSelectedEvent();
    if (!event) return setStatus(`Event ${selectedEventNum} not deployed yet`);
    try {
      const ev = new ethers.Contract(event.address, CharityEventArtifact.abi, charityWallet);
      const tx = await ev.closeFunding();
      setStatus("closeFunding tx: " + tx.hash);
      await tx.wait();
      await refreshSummary();
    } catch (e) {
      setStatus("closeFunding failed: " + (e.message || e));
    }
  }

  async function submitEvidence() {
    const event = getEventByNumber(evidenceEventNum);
    if (!event) return setStatus(`Event ${evidenceEventNum} not deployed yet`);
    if (!evidenceCID) return setStatus("Provide evidence CID");
    try {
      const ev = new ethers.Contract(event.address, CharityEventArtifact.abi, charityWallet);
      const tx = await ev.submitEvidence(evidenceCID);
      setStatus("submitEvidence tx: " + tx.hash);
      await tx.wait();
      if (evidenceEventNum === selectedEventNum) {
        await refreshSummary();
      }
    } catch (e) {
      setStatus("submitEvidence failed: " + (e.message || e));
    }
  }

  async function donorApproveAndPledge() {
    const event = getEventByNumber(pledgeEventNum);
    if (!event) {
      return setStatus(`Event ${pledgeEventNum} not deployed yet`);
    }
    
    try {
      setStatus("Loading donor wallet...");
      const wallets = await getWallets(rpcUrl);
      
      const donor = wallets[donorIndex];
      if (!donor) {
        return setStatus("No donor wallet at index " + donorIndex);
      }
      
      const donorAddr = await donor.getAddress();
      setStatus("Donor: " + donorAddr);

      // Check if donor is registered and verified
      const provider = new ethers.JsonRpcProvider(rpcUrl);
      const DonorRegistryArtifact = await import("../abi/DonorRegistry.json");
      const donorReg = new ethers.Contract(addresses.DonorRegistry, DonorRegistryArtifact.default.abi, provider);
      
      const isRegistered = await donorReg.isDonorRegistered(donorAddr);
      if (!isRegistered) {
        return setStatus(`Donor ${donorAddr} is not registered. Go to Donor page and register first.`);
      }
      
      const isVerified = await donorReg.isDonorVerified(donorAddr);
      if (!isVerified) {
        return setStatus(`Donor ${donorAddr} is not verified. Admin must verify on Donor page first.`);
      }

      const sgd = new ethers.Contract(addresses.SGDCoin, SGDCoinArtifact.abi, donor);
      const pledges = new ethers.Contract(addresses.DonorPledges, DonorPledgesArtifact.abi, donor);

      const amountWei = await doParseUnits(pledgeAmount);

      // Check balance
      const balance = await sgd.balanceOf(donorAddr);
      if (balance < amountWei) {
        return setStatus(`Insufficient balance. Has ${balance.toString()}, needs ${amountWei.toString()}`);
      }

      // approve DonorPledges to pull
      setStatus("Approving DonorPledges to spend tokens...");
      let tx = await sgd.approve(addresses.DonorPledges, amountWei);
      setStatus("Approve tx sent: " + tx.hash);
      
      await tx.wait();
      setStatus("Approve confirmed, creating pledge...");
      
      // Fetch fresh nonce to avoid nonce conflicts after the approve tx
      const currentNonce = await provider.getTransactionCount(donorAddr, 'latest');
      
      // create pledge with explicit nonce (will lookup CharityEvent via Oracle)
      tx = await pledges.createPledge(event.eventId, amountWei, { nonce: currentNonce });
      setStatus("createPledge tx sent: " + tx.hash);
      
      await tx.wait();
      setStatus(`Pledge to Event ${pledgeEventNum} confirmed!`);
      
      if (pledgeEventNum === selectedEventNum) {
        await refreshSummary();
      }
    } catch (e) {
      setStatus("Pledge failed: " + (e.message || e));
    }
  }

  async function doParseUnits(human) {
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const sgd = new ethers.Contract(addresses.SGDCoin, SGDCoinArtifact.abi, provider);
    const decimals = await sgd.decimals().catch(() => 18);
    const decimalsNum = typeof decimals === "bigint" ? Number(decimals) : decimals;
    return ethers.parseUnits(human.toString(), decimalsNum);
  }

  function fmt(amount) {
    try {
      if (typeof amount === "bigint") return amount.toString();
      return String(amount);
    } catch {
      return String(amount);
    }
  }

  function short(addr) {
    if (!addr) return "";
    return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
  }

  // Event listeners for CharityEvent and DonorPledges
  useEffect(() => {
    const provider = new ethers.JsonRpcProvider(rpcUrl);

    function pushEvent(obj) {
      setEvents((prev) => [obj, ...prev].slice(0, 200));
    }

    const cleanupFunctions = [];

    // Listen to all deployed CharityEvent contracts
    eventsList.forEach((eventItem) => {
      const ev = new ethers.Contract(eventItem.address, CharityEventArtifact.abi, provider);
      
      const onEventCreated = (evId, orgId, fundingGoal, deadline, event) => {
        pushEvent({ id: Date.now() + Math.random(), type: 'EventCreated', eventNum: eventItem.eventNumber, eventId: evId, orgId: Number(orgId), goal: fundingGoal.toString(), deadline: deadline.toString(), tx: event.transactionHash });
      };
      const onPhaseChanged = (evId, oldPhase, newPhase, event) => {
        pushEvent({ id: Date.now() + Math.random(), type: 'PhaseChanged', eventNum: eventItem.eventNumber, eventId: evId, oldPhase: Number(oldPhase), newPhase: Number(newPhase), tx: event.transactionHash });
      };
      const onFundsRaised = (evId, totalRaised, event) => {
        pushEvent({ id: Date.now() + Math.random(), type: 'FundsRaised', eventNum: eventItem.eventNumber, eventId: evId, totalRaised: totalRaised.toString(), tx: event.transactionHash });
      };
      const onEvidenceSubmitted = (evId, evidenceCID, event) => {
        pushEvent({ id: Date.now() + Math.random(), type: 'EvidenceSubmitted', eventNum: eventItem.eventNumber, eventId: evId, evidenceCID, tx: event.transactionHash });
      };
      const onVerifiedSet = (evId, verified, perStream, event) => {
        pushEvent({ id: Date.now() + Math.random(), type: 'VerifiedSet', eventNum: eventItem.eventNumber, eventId: evId, verified, perStream: perStream.map(String), tx: event.transactionHash });
      };

      try { ev.on('EventCreated', onEventCreated); } catch (e) {}
      try { ev.on('PhaseChanged', onPhaseChanged); } catch (e) {}
      try { ev.on('FundsRaised', onFundsRaised); } catch (e) {}
      try { ev.on('EvidenceSubmitted', onEvidenceSubmitted); } catch (e) {}
      try { ev.on('VerifiedSet', onVerifiedSet); } catch (e) {}

      cleanupFunctions.push(() => {
        try { ev.off('EventCreated', onEventCreated); } catch (e) {}
        try { ev.off('PhaseChanged', onPhaseChanged); } catch (e) {}
        try { ev.off('FundsRaised', onFundsRaised); } catch (e) {}
        try { ev.off('EvidenceSubmitted', onEvidenceSubmitted); } catch (e) {}
        try { ev.off('VerifiedSet', onVerifiedSet); } catch (e) {}
      });
    });

    // Listen to DonorPledges events
    if (addresses.DonorPledges) {
      const pledges = new ethers.Contract(addresses.DonorPledges, DonorPledgesArtifact.abi, provider);
      
      const onPledgeCreated = (pledgeId, donor, evId, amount, timestamp, event) => {
        pushEvent({ id: Date.now() + Math.random(), type: 'PledgeCreated', pledgeId: Number(pledgeId), donor, eventId: evId, amount: amount.toString(), timestamp: timestamp.toString(), tx: event.transactionHash });
      };
      const onPledgeWithdrawn = (pledgeId, donor, amount, event) => {
        pushEvent({ id: Date.now() + Math.random(), type: 'PledgeWithdrawn', pledgeId: Number(pledgeId), donor, amount: amount.toString(), tx: event.transactionHash });
      };

      try { pledges.on('PledgeCreated', onPledgeCreated); } catch (e) {}
      try { pledges.on('PledgeWithdrawn', onPledgeWithdrawn); } catch (e) {}

      cleanupFunctions.push(() => {
        try { pledges.off('PledgeCreated', onPledgeCreated); } catch (e) {}
        try { pledges.off('PledgeWithdrawn', onPledgeWithdrawn); } catch (e) {}
      });
    }

    return () => {
      cleanupFunctions.forEach(fn => fn());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventsList]);

  // Auto-refresh summary when selected event changes
  useEffect(() => {
    refreshSummary();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedEventNum]);

  return (
    <div style={{ padding: 20 }}>
      <h2>Events Page</h2>
      <div style={{ marginBottom: 8 }}>{status}</div>

      <div style={{ display: 'flex', gap: 12 }}>
        <div style={{ flex: 2 }}>

      <section style={{ marginBottom: 12 }}>
        <h3>Charity Context</h3>
        <div>Charity (index 12): <code>{charityAddr || "loading..."}</code></div>
        <div>OrgId: {orgId || "n/a"}</div>
        <div>Approved: {isApproved ? "✓ Yes" : "✗ No (admin must approve)"}</div>
        <div>Beneficiary Treasury: <code>{beneficiaryTreasury || "n/a"}</code></div>
        <div style={{ marginTop: 8 }}>
          <button onClick={() => loadCharityContext(charityAddr)}>Refresh Context</button>
        </div>
      </section>

      <section style={{ marginBottom: 12 }}>
        <h3>Create Event</h3>
        <div style={{ display: "grid", gap: 8, maxWidth: 600 }}>
          <input placeholder="Description" value={description} onChange={(e) => setDescription(e.target.value)} />
          <input placeholder="Funding goal (tokens)" value={goal} onChange={(e) => setGoal(e.target.value)} />
          <input placeholder="Duration seconds" value={durationSecs} onChange={(e) => setDurationSecs(e.target.value)} />
          <div>
            <button onClick={deployEvent}>Deploy CharityEvent</button>
          </div>
        </div>
      </section>

      <section style={{ marginBottom: 12 }}>
        <h3>Event Summary for Event {selectedEventNum}</h3>
        <div style={{ marginBottom: 8, display: 'flex', gap: 8, alignItems: 'center' }}>
          <label>Select Event: 
            <input 
              type="number" 
              min="1" 
              value={selectedEventNum} 
              onChange={(e) => setSelectedEventNum(Number(e.target.value))}
              style={{ marginLeft: 8, width: 60 }}
            />
          </label>
          <div style={{ fontSize: 12, color: '#666' }}>
            ({eventsList.length} event{eventsList.length !== 1 ? 's' : ''} stored)
          </div>
          {eventsList.length > 0 && (
            <button 
              onClick={() => {
                if (window.confirm('Clear all stored events? (This will NOT delete events from blockchain, only local cache)')) {
                  setEventsList([]);
                  localStorage.removeItem('charityEvents');
                  setStatus('Local event cache cleared');
                }
              }}
              style={{ fontSize: 11, padding: '2px 6px' }}
            >
              Clear Cache
            </button>
          )}
        </div>
        {getSelectedEvent() ? (
          <>
            <div>Event Address: <code>{getSelectedEvent().address}</code></div>
            <div>EventId (bytes32): <code>{short(getSelectedEvent().eventId)}</code></div>
            {eventSummary ? (
              <div style={{ marginTop: 8 }}>
                <div>phase: {String(eventSummary.phase)}</div>
                <div>goal: {fmt(eventSummary.goal)}</div>
                <div>raised: {fmt(eventSummary.raised)}</div>
                <div>beneficiary: <code>{eventSummary.beneficiary}</code></div>
                <div>verified: {String(eventSummary.verified)}</div>
              </div>
            ) : (
              <div style={{ color: "#666" }}>Loading summary...</div>
            )}
            <div style={{ marginTop: 8, padding: 8, background: '#f9f9f9', borderRadius: 4 }}>
              <div style={{ fontSize: 12, fontWeight: 600 }}>Voting Setup:</div>
              {getSelectedEvent().votingSetup ? (
                <div style={{ fontSize: 12, color: '#2a7f2a' }}>
                  ✓ Voting modules deployed and registered
                  <div>DonorVoting: <code style={{ fontSize: 10 }}>{short(getSelectedEvent().donorVoting)}</code></div>
                  <div>AttestorVoting: <code style={{ fontSize: 10 }}>{short(getSelectedEvent().attestorVoting)}</code></div>
                </div>
              ) : (
                <div>
                  <div style={{ fontSize: 12, color: '#666', marginBottom: 4 }}>No voting modules yet</div>
                  <button 
                    onClick={() => setupVotingModules(selectedEventNum)}
                    disabled={setupVotingFor === selectedEventNum}
                    style={{ fontSize: 12, padding: '4px 8px' }}
                  >
                    {setupVotingFor === selectedEventNum ? 'Setting up...' : 'Setup Voting Modules'}
                  </button>
                </div>
              )}
            </div>
          </>
        ) : (
          <>
            <div>Event Address: <code>nil</code></div>
            <div>EventId (bytes32): <code>nil</code></div>
            <div style={{ color: "#666", marginTop: 8 }}>Event {selectedEventNum} not created yet</div>
          </>
        )}
        <div style={{ marginTop: 8 }}>
          <button onClick={() => refreshSummary()}>Refresh Summary</button>
          <button style={{ marginLeft: 8 }} onClick={closeFunding}>Close Funding (charity)</button>
        </div>
      </section>

      <section style={{ marginBottom: 12 }}>
        <h3>Evidence</h3>
        <div style={{ display: "grid", gap: 8, maxWidth: 600 }}>
          <label>Event Number
            <input type="number" min="1" value={evidenceEventNum} onChange={(e) => setEvidenceEventNum(Number(e.target.value))} />
          </label>
          <label>Evidence CID
            <input placeholder="ipfs://..." value={evidenceCID} onChange={(e) => setEvidenceCID(e.target.value)} />
          </label>
          <button onClick={submitEvidence}>Submit Evidence (charity)</button>
        </div>
      </section>

      <section>
        <h3>Donor Pledge (Demo)</h3>
        <div style={{ display: "grid", gap: 8, maxWidth: 600 }}>
          <label>Event Number to pledge to
            <input type="number" min="1" value={pledgeEventNum} onChange={(e) => setPledgeEventNum(Number(e.target.value))} />
          </label>
          <label>Donor wallet index
            <input type="number" min="1" value={donorIndex} onChange={(e) => setDonorIndex(Number(e.target.value))} />
          </label>
          <label>Amount
            <input value={pledgeAmount} onChange={(e) => setPledgeAmount(e.target.value)} />
          </label>
          <button onClick={donorApproveAndPledge}>Approve + Pledge</button>
        </div>
      </section>
        </div>

        <div style={{ flex: 1, borderLeft: '1px solid #eee', paddingLeft: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h3 style={{ margin: 0 }}>Event Log</h3>
            <div><button onClick={() => setEvents([])}>Clear</button></div>
          </div>
          <div style={{ marginTop: 8, maxHeight: '70vh', overflow: 'auto' }}>
            {events.length === 0 ? (
              <div style={{ color: '#666' }}>No events yet. Events (EventCreated, PhaseChanged, FundsRaised, EvidenceSubmitted, PledgeCreated, ModulesSet, etc.) will appear here.</div>
            ) : (
              events.map((ev) => (
                <div key={ev.id} style={{ borderBottom: '1px solid #f0f0f0', padding: 8 }}>
                  <div style={{ fontSize: 12, color: '#999' }}>{ev.time || new Date().toLocaleTimeString()}</div>
                  <div style={{ fontWeight: 700 }}>{ev.type || ev.name}</div>
                  {ev.type === 'EventCreated' && (
                    <div>
                      <div>Event #{ev.eventNum}</div>
                      <div>eventId: <span style={{ fontFamily: 'monospace', fontSize: 12 }}>{short(ev.eventId)}</span></div>
                      <div>orgId: {ev.orgId}</div>
                      <div>goal: {ev.goal}</div>
                      <div style={{ fontSize: 11, color: '#666' }}>tx: {ev.tx}</div>
                    </div>
                  )}
                  {ev.type === 'PhaseChanged' && (
                    <div>
                      <div>Event #{ev.eventNum}</div>
                      <div>eventId: <span style={{ fontFamily: 'monospace', fontSize: 12 }}>{short(ev.eventId)}</span></div>
                      <div>oldPhase: {ev.oldPhase} → newPhase: {ev.newPhase}</div>
                      <div style={{ fontSize: 11, color: '#666' }}>tx: {ev.tx}</div>
                    </div>
                  )}
                  {ev.type === 'FundsRaised' && (
                    <div>
                      <div>Event #{ev.eventNum}</div>
                      <div>eventId: <span style={{ fontFamily: 'monospace', fontSize: 12 }}>{short(ev.eventId)}</span></div>
                      <div>totalRaised: {ev.totalRaised}</div>
                      <div style={{ fontSize: 11, color: '#666' }}>tx: {ev.tx}</div>
                    </div>
                  )}
                  {ev.type === 'EvidenceSubmitted' && (
                    <div>
                      <div>Event #{ev.eventNum}</div>
                      <div>eventId: <span style={{ fontFamily: 'monospace', fontSize: 12 }}>{short(ev.eventId)}</span></div>
                      <div>evidenceCID: {ev.evidenceCID}</div>
                      <div style={{ fontSize: 11, color: '#666' }}>tx: {ev.tx}</div>
                    </div>
                  )}
                  {ev.type === 'VerifiedSet' && (
                    <div>
                      <div>Event #{ev.eventNum}</div>
                      <div>eventId: <span style={{ fontFamily: 'monospace', fontSize: 12 }}>{short(ev.eventId)}</span></div>
                      <div>verified: {String(ev.verified)}</div>
                      <div>perStream: [{ev.perStream?.join(', ')}]</div>
                      <div style={{ fontSize: 11, color: '#666' }}>tx: {ev.tx}</div>
                    </div>
                  )}
                  {ev.type === 'PledgeCreated' && (
                    <div>
                      <div>pledgeId: {ev.pledgeId}</div>
                      <div>donor: <span style={{ fontFamily: 'monospace', fontSize: 12 }}>{short(ev.donor)}</span></div>
                      <div>eventId: <span style={{ fontFamily: 'monospace', fontSize: 12 }}>{short(ev.eventId)}</span></div>
                      <div>amount: {ev.amount}</div>
                      <div style={{ fontSize: 11, color: '#666' }}>tx: {ev.tx}</div>
                    </div>
                  )}
                  {ev.type === 'PledgeWithdrawn' && (
                    <div>
                      <div>pledgeId: {ev.pledgeId}</div>
                      <div>donor: <span style={{ fontFamily: 'monospace', fontSize: 12 }}>{short(ev.donor)}</span></div>
                      <div>amount: {ev.amount}</div>
                      <div style={{ fontSize: 11, color: '#666' }}>tx: {ev.tx}</div>
                    </div>
                  )}
                  {ev.name === 'ModulesSet' && ev.data && (
                    <div>
                      <div>Event {ev.data.Event}</div>
                      <div>eventId: <span style={{ fontFamily: 'monospace', fontSize: 12 }}>{short(ev.data.eventId)}</span></div>
                      <div>DonorVoting: <span style={{ fontFamily: 'monospace', fontSize: 12 }}>{short(ev.data.DonorVoting)}</span></div>
                      <div>AttestorVoting: <span style={{ fontFamily: 'monospace', fontSize: 12 }}>{short(ev.data.AttestorVoting)}</span></div>
                      <div>CharityEvent: <span style={{ fontFamily: 'monospace', fontSize: 12 }}>{short(ev.data.CharityEvent)}</span></div>
                      <div style={{ fontSize: 11, color: '#666' }}>tx: {ev.data.tx}</div>
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


