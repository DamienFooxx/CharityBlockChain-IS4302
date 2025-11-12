import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import addresses from "../config/addresses.json";
import CharityEventArtifact from "../abi/CharityEvent.json";
import DonorPledgesArtifact from "../abi/DonorPledges.json";
import SGDCoinArtifact from "../abi/SGDCoin.json";
import CharityRegistryArtifact from "../abi/CharityRegistry.json";
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

  // Event data
  const [eventAddress, setEventAddress] = useState(null);
  const [eventId, setEventId] = useState(null);
  const [eventSummary, setEventSummary] = useState(null);

  // Create form
  const [goal, setGoal] = useState("100"); // human tokens
  const [durationSecs, setDurationSecs] = useState("3600");
  const [description, setDescription] = useState("Demo Event");

  // Evidence form
  const [evidenceCID, setEvidenceCID] = useState("");

  // Donor pledge form (uses local wallet index 1 by default)
  const [donorIndex, setDonorIndex] = useState(1);
  const [pledgeAmount, setPledgeAmount] = useState("50");

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
      setEventAddress(addr);
      setEventId(evId);
      setStatus("Event deployed at " + addr);
      await refreshSummary(addr);
    } catch (e) {
      setStatus("Deploy failed: " + (e.message || e));
    }
  }

  async function refreshSummary(addressOverride) {
    try {
      const provider = new ethers.JsonRpcProvider(rpcUrl);
      const ev = new ethers.Contract(addressOverride || eventAddress, CharityEventArtifact.abi, provider);
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

  async function closeFunding() {
    if (!eventAddress) return setStatus("Deploy an event first");
    try {
      const ev = new ethers.Contract(eventAddress, CharityEventArtifact.abi, charityWallet);
      const tx = await ev.closeFunding();
      setStatus("closeFunding tx: " + tx.hash);
      await tx.wait();
      await refreshSummary();
    } catch (e) {
      setStatus("closeFunding failed: " + (e.message || e));
    }
  }

  async function submitEvidence() {
    if (!eventAddress) return setStatus("Deploy an event first");
    if (!evidenceCID) return setStatus("Provide evidence CID");
    try {
      const ev = new ethers.Contract(eventAddress, CharityEventArtifact.abi, charityWallet);
      const tx = await ev.submitEvidence(evidenceCID);
      setStatus("submitEvidence tx: " + tx.hash);
      await tx.wait();
      await refreshSummary();
    } catch (e) {
      setStatus("submitEvidence failed: " + (e.message || e));
    }
  }

  async function donorApproveAndPledge() {
    if (!eventId) return setStatus("Deploy an event first (need eventId)");
    try {
      const wallets = await getWallets(rpcUrl);
      const donor = wallets[donorIndex];
      if (!donor) return setStatus("No donor wallet at index " + donorIndex);
      const sgd = new ethers.Contract(addresses.SGDCoin, SGDCoinArtifact.abi, donor);
      const pledges = new ethers.Contract(addresses.DonorPledges, DonorPledgesArtifact.abi, donor);

      const amountWei = await doParseUnits(pledgeAmount);
      // approve DonorPledges to pull
      let tx = await sgd.approve(addresses.DonorPledges, amountWei);
      setStatus("approve tx: " + tx.hash);
      await tx.wait();
      // create pledge
      tx = await pledges.createPledge(eventId, amountWei);
      setStatus("createPledge tx: " + tx.hash);
      await tx.wait();
      setStatus("Pledge confirmed");
      await refreshSummary();
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

    // Listen to CharityEvent events (if eventAddress is set)
    if (eventAddress) {
      const ev = new ethers.Contract(eventAddress, CharityEventArtifact.abi, provider);
      
      const onEventCreated = (evId, orgId, fundingGoal, deadline, event) => {
        pushEvent({ id: Date.now() + Math.random(), type: 'EventCreated', eventId: evId, orgId: Number(orgId), goal: fundingGoal.toString(), deadline: deadline.toString(), tx: event.transactionHash });
      };
      const onPhaseChanged = (evId, oldPhase, newPhase, event) => {
        pushEvent({ id: Date.now() + Math.random(), type: 'PhaseChanged', eventId: evId, oldPhase: Number(oldPhase), newPhase: Number(newPhase), tx: event.transactionHash });
      };
      const onFundsRaised = (evId, totalRaised, event) => {
        pushEvent({ id: Date.now() + Math.random(), type: 'FundsRaised', eventId: evId, totalRaised: totalRaised.toString(), tx: event.transactionHash });
      };
      const onEvidenceSubmitted = (evId, evidenceCID, event) => {
        pushEvent({ id: Date.now() + Math.random(), type: 'EvidenceSubmitted', eventId: evId, evidenceCID, tx: event.transactionHash });
      };
      const onVerifiedSet = (evId, verified, perStream, event) => {
        pushEvent({ id: Date.now() + Math.random(), type: 'VerifiedSet', eventId: evId, verified, perStream: perStream.map(String), tx: event.transactionHash });
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
    }

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
  }, [eventAddress]);

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
        <h3>Event Summary</h3>
        <div>Event Address: <code>{eventAddress || "n/a"}</code></div>
        <div>EventId (bytes32): <code>{eventId || "n/a"}</code></div>
        {eventSummary ? (
          <div style={{ marginTop: 8 }}>
            <div>phase: {String(eventSummary.phase)}</div>
            <div>goal: {fmt(eventSummary.goal)}</div>
            <div>raised: {fmt(eventSummary.raised)}</div>
            <div>beneficiary: <code>{eventSummary.beneficiary}</code></div>
            <div>verified: {String(eventSummary.verified)}</div>
          </div>
        ) : (
          <div style={{ color: "#666" }}>No summary yet</div>
        )}
        <div style={{ marginTop: 8 }}>
          <button onClick={() => refreshSummary()}>Refresh Summary</button>
          <button style={{ marginLeft: 8 }} onClick={closeFunding}>Close Funding (charity)</button>
        </div>
      </section>

      <section style={{ marginBottom: 12 }}>
        <h3>Evidence</h3>
        <div style={{ display: "flex", gap: 8, maxWidth: 600 }}>
          <input placeholder="Evidence CID (ipfs://...)" value={evidenceCID} onChange={(e) => setEvidenceCID(e.target.value)} />
          <button onClick={submitEvidence}>Submit Evidence (charity)</button>
        </div>
      </section>

      <section>
        <h3>Donor Pledge (Demo)</h3>
        <div style={{ display: "grid", gap: 8, maxWidth: 600 }}>
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
              <div style={{ color: '#666' }}>No events yet. Events (EventCreated, PhaseChanged, FundsRaised, EvidenceSubmitted, PledgeCreated, etc.) will appear here.</div>
            ) : (
              events.map((ev) => (
                <div key={ev.id} style={{ borderBottom: '1px solid #f0f0f0', padding: 8 }}>
                  <div style={{ fontSize: 12, color: '#999' }}>{new Date().toLocaleTimeString()}</div>
                  <div style={{ fontWeight: 700 }}>{ev.type}</div>
                  {ev.type === 'EventCreated' && (
                    <div>
                      <div>eventId: <span style={{ fontFamily: 'monospace', fontSize: 12 }}>{short(ev.eventId)}</span></div>
                      <div>orgId: {ev.orgId}</div>
                      <div>goal: {ev.goal}</div>
                      <div style={{ fontSize: 11, color: '#666' }}>tx: {ev.tx}</div>
                    </div>
                  )}
                  {ev.type === 'PhaseChanged' && (
                    <div>
                      <div>eventId: <span style={{ fontFamily: 'monospace', fontSize: 12 }}>{short(ev.eventId)}</span></div>
                      <div>oldPhase: {ev.oldPhase} → newPhase: {ev.newPhase}</div>
                      <div style={{ fontSize: 11, color: '#666' }}>tx: {ev.tx}</div>
                    </div>
                  )}
                  {ev.type === 'FundsRaised' && (
                    <div>
                      <div>eventId: <span style={{ fontFamily: 'monospace', fontSize: 12 }}>{short(ev.eventId)}</span></div>
                      <div>totalRaised: {ev.totalRaised}</div>
                      <div style={{ fontSize: 11, color: '#666' }}>tx: {ev.tx}</div>
                    </div>
                  )}
                  {ev.type === 'EvidenceSubmitted' && (
                    <div>
                      <div>eventId: <span style={{ fontFamily: 'monospace', fontSize: 12 }}>{short(ev.eventId)}</span></div>
                      <div>evidenceCID: {ev.evidenceCID}</div>
                      <div style={{ fontSize: 11, color: '#666' }}>tx: {ev.tx}</div>
                    </div>
                  )}
                  {ev.type === 'VerifiedSet' && (
                    <div>
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
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}


