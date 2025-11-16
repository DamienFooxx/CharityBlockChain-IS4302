import React, { useState, useEffect } from "react";
import { ethers } from "ethers";
import addresses from "../config/addresses.json";
import CharityEventArtifact from "../abi/CharityEvent.json";
import EscrowVaultArtifact from "../abi/EscrowVault.json";
import DonorVotingArtifact from "../abi/DonorVoting.json";
import AttestorVotingArtifact from "../abi/AttestorVoting.json";
import OracleArtifact from "../abi/Oracle.json";
import CharityTreasuryArtifact from "../abi/CharityTreasury.json";
import SGDCoinArtifact from "../abi/SGDCoin.json";
import GovernanceArtifact from "../abi/Governance.json";
import { getWallets } from "../utils/wallets";

function short(addr) {
  if (!addr) return "";
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export default function ResultsPage() {
  const rpcUrl = "http://127.0.0.1:8545";
  const provider = new ethers.JsonRpcProvider(rpcUrl);

  const [status, setStatus] = useState("");
  const [wallets, setWallets] = useState([]);
  const [oracleWallet, setOracleWallet] = useState(null);

  // Event context
  const [eventAddress, setEventAddress] = useState("");
  const [eventId, setEventId] = useState("");
  const [eventData, setEventData] = useState(null);
  const [donorVotingAddr, setDonorVotingAddr] = useState("");
  const [attestorVotingAddr, setAttestorVotingAddr] = useState("");

  // Results data
  const [donorResults, setDonorResults] = useState([]);
  const [donorQuorum, setDonorQuorum] = useState(null);
  const [attestorResults, setAttestorResults] = useState([]);
  const [streamComparison, setStreamComparison] = useState([]);
  const [treasuryBalance, setTreasuryBalance] = useState("0");
  const [logs, setLogs] = useState([]);

  useEffect(() => {
    (async () => {
      try {
        const loaded = await getWallets(rpcUrl);
        setWallets(loaded);
        setOracleWallet(loaded[19]); // Account 19 is oracle
        setStatus("Loaded wallets");
      } catch (e) {
        setStatus("Failed to load wallets: " + (e.message || e));
      }
    })();
  }, []);

  async function loadEventContext() {
    if (!eventAddress) return setStatus("Enter event address first");
    
    addLog("=== LOADING EVENT CONTEXT ===");
    try {
      const eventContract = new ethers.Contract(eventAddress, CharityEventArtifact.abi, provider);
      
      // Use getEventSummary() which returns all data
      const summary = await eventContract.getEventSummary();
      const evId = summary[0];           // eventIdValue
      const orgId = summary[1];          // organizationId
      const phase = summary[2];          // currentPhase
      const goal = summary[3];           // goal
      const raised = summary[4];         // raised
      const beneficiary = summary[5];    // beneficiaryAddr
      const verified = summary[6];       // isVerified
      const deadline = summary[7];       // deadline
      
      setEventId(evId);
      setEventData({
        phase: Number(phase),
        goal: ethers.formatUnits(goal, 18),
        raised: ethers.formatUnits(raised, 18),
        beneficiary,
        verified,
        deadline: Number(deadline),
      });
      
      addLog(`Event ID: ${evId}`);
      addLog(`Organization ID: ${Number(orgId)}`);
      addLog(`Phase: ${Number(phase)} ${getPhaseLabel(Number(phase))}`);
      addLog(`Goal: ${ethers.formatUnits(goal, 18)} SGD`);
      addLog(`Raised: ${ethers.formatUnits(raised, 18)} SGD`);
      addLog(`Beneficiary: ${short(beneficiary)}`);
      addLog(`Verified: ${verified}`);
      addLog(`Funding Deadline: ${new Date(Number(deadline) * 1000).toLocaleString()}`);
      
      // Get voting module addresses from Oracle
      const oracle = new ethers.Contract(addresses.Oracle, OracleArtifact.abi, provider);
      const modules = await oracle.modules(evId);
      setDonorVotingAddr(modules.donor);
      setAttestorVotingAddr(modules.attestor);
      
      addLog(`DonorVoting: ${short(modules.donor)}`);
      addLog(`AttestorVoting: ${short(modules.attestor)}`);
      
      setStatus("✓ Event context loaded");
      
      // Auto-load treasury balance
      await loadTreasuryBalance();
    } catch (e) {
      addLog(`ERROR: ${e.message}`);
      setStatus("Failed to load event: " + (e.message || e));
    }
  }

  function getPhaseLabel(phase) {
    switch(phase) {
      case 0: return "(FUNDING)";
      case 1: return "(CLOSED - Funding Complete)";
      case 2: return "(VOTING - Evidence Submitted)";
      case 3: return "(VERIFIED - Voting Passed)";
      case 4: return "(COMPLETED)";
      case 5: return "(CANCELLED)";
      default: return "";
    }
  }

  async function analyzeDonorVoting() {
    if (!donorVotingAddr || !eventId) {
      return setStatus("Load event context first");
    }
    
    addLog("\n=== ANALYZING DONOR VOTING ===");
    try {
      const donorVoting = new ethers.Contract(donorVotingAddr, DonorVotingArtifact.abi, provider);
      const escrow = new ethers.Contract(addresses.EscrowVault, EscrowVaultArtifact.abi, provider);
      const governance = new ethers.Contract(addresses.Governance, GovernanceArtifact.abi, provider);
      
      // Get quorum and majority thresholds
      const quorumBps = await governance.globalQuorumBps();
      const passMajorityBps = await governance.globalPassMajorityBps();
      addLog(`Quorum requirement: ${Number(quorumBps) / 100}%`);
      addLog(`Pass majority requirement: ${Number(passMajorityBps) / 100}%`);
      
      // Get all pledges for this event
      const filter = escrow.filters.PledgeDeposited(null, eventId);
      const events = await escrow.queryFilter(filter);
      
      const donorMap = new Map();
      
      for (const event of events) {
        const pledgeId = event.args.pledgeId;
        const donor = event.args.donor;
        const amount = event.args.amount;
        const isActive = await escrow.pledgeActive(pledgeId);
        
        if (isActive) {
          if (!donorMap.has(donor)) {
            donorMap.set(donor, { amount: 0n, pledges: [] });
          }
          const data = donorMap.get(donor);
          data.amount += amount;
          data.pledges.push(pledgeId);
        }
      }
      
      addLog(`Found ${donorMap.size} donors with active pledges`);
      
      // Get voting data for each donor
      const results = [];
      let totalWeight = 0;
      const streamTotals = [0, 0, 0];
      const streamWeights = [0, 0, 0];
      
      for (const [donor, data] of donorMap.entries()) {
        const isAssigned = await donorVoting.isAssigned(donor);
        
        if (isAssigned) {
          const stream = await donorVoting.assignedStream(donor);
          const revealed = await donorVoting.revealed(donor);
          
          // Calculate weight (same formula as contract)
          const pledgeAmount = data.amount;
          const sqrtAmount = sqrt(pledgeAmount);
          const weight = sqrtAmount * 100n / 100n; // weightMultiplier = 100
          
          let choice = null;
          if (revealed) {
            // We can't directly read the choice, but we can see if they revealed
            choice = "Revealed";
          }
          
          results.push({
            donor: short(donor),
            amount: ethers.formatUnits(pledgeAmount, 18),
            weight: weight.toString(),
            stream: Number(stream),
            revealed,
            choice,
          });
          
          totalWeight += Number(weight);
          streamTotals[Number(stream)]++;
          streamWeights[Number(stream)] += Number(weight);
        }
      }
      
      addLog(`Total donors assigned: ${results.length}`);
      addLog(`Total voting weight: ${totalWeight}`);
      
      // Get per-stream results
      const overallResult = await donorVoting.overallResult();
      addLog(`Overall decided: ${overallResult[0]}`);
      addLog(`Overall passed: ${overallResult[1]}`);
      addLog(`Stream results: [${overallResult[2].map(String).join(", ")}]`);
      
      // Calculate quorum per stream
      const quorumData = [];
      for (let s = 0; s < 3; s++) {
        const totalPossible = await donorVoting.totalPossibleWeight(s);
        const tally = await donorVoting.tallies(s);
        const participated = tally.totalWeight;
        
        const participationPct = totalPossible > 0n 
          ? (Number(participated) * 100 / Number(totalPossible)).toFixed(2)
          : "0.00";
        
        const passPct = participated > 0n
          ? (Number(tally.pass) * 100 / Number(participated)).toFixed(2)
          : "0.00";
        
        const quorumMet = Number(participationPct) >= (Number(quorumBps) / 100);
        const passMet = Number(passPct) >= (Number(passMajorityBps) / 100);
        
        quorumData.push({
          stream: s,
          totalPossible: totalPossible.toString(),
          participated: participated.toString(),
          participationPct,
          passVotes: tally.pass.toString(),
          failVotes: tally.fail.toString(),
          passPct,
          quorumMet,
          passMet,
          passed: overallResult[2][s],
        });
        
        addLog(`\nStream ${s}:`);
        addLog(`  Participation: ${participationPct}% (${quorumMet ? "✓" : "✗"} Quorum)`);
        addLog(`  Pass votes: ${passPct}% (${passMet ? "✓" : "✗"} Majority)`);
        addLog(`  Result: ${overallResult[2][s] ? "PASSED" : "FAILED"}`);
      }
      
      setDonorResults(results);
      setDonorQuorum(quorumData);
      setStatus("✓ Donor voting analyzed");
    } catch (e) {
      addLog(`ERROR: ${e.message}`);
      setStatus("Failed to analyze donor voting: " + (e.message || e));
    }
  }

  async function analyzeAttestorVoting() {
    if (!attestorVotingAddr || !donorVotingAddr) {
      return setStatus("Load event context and analyze donor voting first");
    }
    
    addLog("\n=== ANALYZING ATTESTOR VOTING ===");
    try {
      const attestorVoting = new ethers.Contract(attestorVotingAddr, AttestorVotingArtifact.abi, provider);
      const donorVoting = new ethers.Contract(donorVotingAddr, DonorVotingArtifact.abi, provider);
      
      // Get attestor phase
      const phase = await attestorVoting.phase();
      addLog(`Attestor phase: ${Number(phase)} (0=Pending, 1=Commit, 2=Reveal, 3=Finalized)`);
      
      // Get overall results
      const attestorOverall = await attestorVoting.overallResult();
      const donorOverall = await donorVoting.overallResult();
      
      addLog(`Attestor overall: ${attestorOverall[1] ? "PASSED" : "FAILED"}`);
      addLog(`Donor overall: ${donorOverall[1] ? "PASSED" : "FAILED"}`);
      
      // Compare per stream
      const comparison = [];
      for (let s = 0; s < 3; s++) {
        const attestorTally = await attestorVoting.tallies(s);
        const attestorPassed = await attestorVoting.attestorStreamPassed(s);
        const donorResult = await donorVoting.streamResult(s);
        const settlement = await attestorVoting.settlements(s);
        
        comparison.push({
          stream: s,
          attestorPass: attestorTally.passStake.toString(),
          attestorFail: attestorTally.failStake.toString(),
          attestorResult: attestorPassed ? "PASS" : "FAIL",
          donorResult: donorResult[1] ? "PASS" : "FAIL",
          settled: settlement.settled,
          canDisburse: attestorPassed && donorResult[1], // Both passed
        });
        
        addLog(`\nStream ${s}:`);
        addLog(`  Attestor voted: ${attestorPassed ? "PASS" : "FAIL"}`);
        addLog(`  Donor voted: ${donorResult[1] ? "PASS" : "FAIL"}`);
        addLog(`  Match: ${attestorPassed === donorResult[1] ? "✓" : "✗"}`);
        addLog(`  Settled: ${settlement.settled ? "Yes" : "No"}`);
      }
      
      setStreamComparison(comparison);
      setStatus("✓ Attestor voting analyzed");
    } catch (e) {
      addLog(`ERROR: ${e.message}`);
      setStatus("Failed to analyze attestor voting: " + (e.message || e));
    }
  }

  async function settleAttestors() {
    if (!oracleWallet || !eventId) {
      return setStatus("Need oracle wallet and event ID");
    }
    
    addLog("\n=== SETTLING ATTESTORS ===");
    try {
      const oracle = new ethers.Contract(addresses.Oracle, OracleArtifact.abi, oracleWallet);
      
      addLog("Calling oracle.settleAttestors()...");
      const tx = await oracle.settleAttestors(eventId);
      addLog(`Transaction: ${tx.hash}`);
      
      setStatus("Waiting for settlement...");
      await tx.wait();
      
      addLog("✓ Attestors settled successfully");
      setStatus("✓ Attestors settled");
      
      // Re-analyze to show updated settlement status
      await analyzeAttestorVoting();
    } catch (e) {
      addLog(`ERROR: ${e.message}`);
      setStatus("Failed to settle attestors: " + (e.reason || e.message || e));
    }
  }

  async function loadTreasuryBalance() {
    if (!eventData) return;
    
    try {
      const treasury = new ethers.Contract(addresses.CharityTreasury, CharityTreasuryArtifact.abi, provider);
      const sgd = new ethers.Contract(addresses.SGDCoin, SGDCoinArtifact.abi, provider);
      
      const balance = await sgd.balanceOf(addresses.CharityTreasury);
      const formatted = ethers.formatUnits(balance, 18);
      setTreasuryBalance(formatted);
      
      addLog(`\nCharity Treasury Balance: ${formatted} SGD`);
    } catch (e) {
      console.error("Failed to load treasury balance:", e);
    }
  }

  async function disburseToCharity() {
    if (!oracleWallet || !eventId) {
      return setStatus("Need oracle wallet and event ID");
    }
    
    addLog("\n=== DISBURSING TO CHARITY ===");
    try {
      const oracle = new ethers.Contract(addresses.Oracle, OracleArtifact.abi, oracleWallet);
      
      addLog("Calling oracle.disburseIfVerified()...");
      const tx = await oracle.disburseIfVerified(eventId);
      addLog(`Transaction: ${tx.hash}`);
      
      setStatus("Waiting for disbursement...");
      const receipt = await tx.wait();
      
      // Parse Disbursed event
      const disbursedEvent = receipt.logs.find(log => {
        try {
          const parsed = oracle.interface.parseLog(log);
          return parsed.name === "Disbursed";
        } catch {
          return false;
        }
      });
      
      if (disbursedEvent) {
        const parsed = oracle.interface.parseLog(disbursedEvent);
        addLog(`✓ Disbursed to: ${short(parsed.args.to)}`);
        addLog(`Event: Transfer from EscrowVault → CharityTreasury`);
      }
      
      addLog("✓ Disbursement completed");
      setStatus("✓ Funds disbursed to charity");
      
      // Refresh treasury balance
      await loadTreasuryBalance();
    } catch (e) {
      addLog(`ERROR: ${e.message}`);
      setStatus("Failed to disburse: " + (e.reason || e.message || e));
    }
  }

  function addLog(message) {
    setLogs(prev => [...prev, { time: new Date().toLocaleTimeString(), message }]);
  }

  // Helper function to calculate square root (matching Solidity)
  function sqrt(x) {
    if (x === 0n) return 0n;
    let z = (x + 1n) / 2n;
    let y = x;
    while (z < y) {
      y = z;
      z = (x / z + z) / 2n;
    }
    return y;
  }

  return (
    <div style={{ padding: 20, maxWidth: 1400, margin: "0 auto" }}>
      <h2>📊 Results & Settlement</h2>
      <div style={{ marginBottom: 16, color: "#666" }}>{status}</div>

      {/* Load Event Context */}
      <section style={{ marginBottom: 24, padding: 16, border: "2px solid #007bff", borderRadius: 8, backgroundColor: "#e7f3ff" }}>
        <h3>🔍 Load Event Context</h3>
        <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 12 }}>
          <input
            type="text"
            placeholder="Event Contract Address"
            value={eventAddress}
            onChange={(e) => setEventAddress(e.target.value)}
            style={{ flex: 1, padding: 8, fontSize: 14, fontFamily: "monospace" }}
          />
          <button onClick={loadEventContext} style={buttonStyle}>
            Load Event Summary
          </button>
        </div>
        
        {eventData && (
          <div style={{ backgroundColor: "white", padding: 12, borderRadius: 4, fontSize: 13 }}>
            <div><strong>Event ID:</strong> <code>{eventId}</code></div>
            <div><strong>Phase:</strong> {eventData.phase} {getPhaseLabel(eventData.phase)}</div>
            <div><strong>Goal:</strong> {eventData.goal} SGD</div>
            <div><strong>Raised:</strong> {eventData.raised} SGD</div>
            <div><strong>Beneficiary:</strong> <code>{short(eventData.beneficiary)}</code></div>
            <div><strong>Verified:</strong> {eventData.verified ? "✓ Yes" : "✗ No"}</div>
          </div>
        )}
      </section>

      {/* Donor Voting Results */}
      {eventId && (
        <section style={{ marginBottom: 24, padding: 16, border: "2px solid #28a745", borderRadius: 8, backgroundColor: "#d4edda" }}>
          <h3>🗳️ Donor Voting Results</h3>
          <button onClick={analyzeDonorVoting} style={{ ...buttonStyle, backgroundColor: "#28a745" }}>
            Analyze Donor Voting
          </button>
          
          {donorQuorum && (
            <div style={{ marginTop: 16 }}>
              <h4>Per-Stream Quorum Analysis</h4>
              {donorQuorum.map((q) => (
                <div key={q.stream} style={{ backgroundColor: "white", padding: 12, marginBottom: 8, borderRadius: 4, border: `2px solid ${q.passed ? "#28a745" : "#dc3545"}` }}>
                  <div style={{ fontWeight: "bold", marginBottom: 8 }}>Stream {q.stream}: {q.passed ? "✓ PASSED" : "✗ FAILED"}</div>
                  <div style={{ fontSize: 12 }}>
                    <div>Participation: {q.participationPct}% {q.quorumMet ? "✓" : "✗"} (Quorum met)</div>
                    <div>Pass votes: {q.passPct}% {q.passMet ? "✓" : "✗"} (Majority met)</div>
                    <div>Total possible weight: {q.totalPossible}</div>
                    <div>Participated weight: {q.participated}</div>
                    <div>Pass: {q.passVotes} | Fail: {q.failVotes}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
          
          {donorResults.length > 0 && (
            <div style={{ marginTop: 16 }}>
              <h4>Individual Donor Votes ({donorResults.length} donors)</h4>
              <div style={{ maxHeight: 300, overflowY: "auto", backgroundColor: "white", padding: 8, borderRadius: 4 }}>
                {donorResults.map((d, idx) => (
                  <div key={idx} style={{ padding: 6, borderBottom: "1px solid #ddd", fontSize: 12 }}>
                    <strong>{d.donor}</strong> | Donated: {parseFloat(d.amount).toFixed(2)} SGD | Weight: {d.weight} | Stream: {d.stream} | {d.revealed ? "✓ Revealed" : "Not revealed"}
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>
      )}

      {/* Attestor vs Donor Comparison */}
      {eventId && (
        <section style={{ marginBottom: 24, padding: 16, border: "2px solid #ffc107", borderRadius: 8, backgroundColor: "#fff3cd" }}>
          <h3>⚖️ Attestor vs Donor Comparison</h3>
          <button onClick={analyzeAttestorVoting} style={{ ...buttonStyle, backgroundColor: "#ffc107", color: "#000" }}>
            Analyze Attestor Voting
          </button>
          
          {streamComparison.length > 0 && (
            <div style={{ marginTop: 16 }}>
              {streamComparison.map((s) => (
                <div key={s.stream} style={{ backgroundColor: "white", padding: 12, marginBottom: 8, borderRadius: 4, border: "1px solid #ddd" }}>
                  <div style={{ fontWeight: "bold", marginBottom: 8 }}>Stream {s.stream}</div>
                  <div style={{ fontSize: 13 }}>
                    <div>Attestor voted: <strong style={{ color: s.attestorResult === "PASS" ? "#28a745" : "#dc3545" }}>{s.attestorResult}</strong> (Pass stake: {s.attestorPass}, Fail stake: {s.attestorFail})</div>
                    <div>Donor voted: <strong style={{ color: s.donorResult === "PASS" ? "#28a745" : "#dc3545" }}>{s.donorResult}</strong></div>
                    <div>Match: {s.attestorResult === s.donorResult ? "✓ Attestors match donors" : "✗ Mismatch"}</div>
                    <div>Settled: {s.settled ? "✓ Yes" : "✗ No (need to settle)"}</div>
                    <div>Can disburse: {s.canDisburse ? "✓ Yes (both passed)" : "✗ No"}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {/* Settlement & Disbursement */}
      {eventId && (
        <section style={{ marginBottom: 24, padding: 16, border: "2px solid #6f42c1", borderRadius: 8, backgroundColor: "#e7d6f5" }}>
          <h3>💰 Settlement & Disbursement</h3>
          
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 18, fontWeight: "bold", marginBottom: 8 }}>
              Charity Treasury Balance: {parseFloat(treasuryBalance).toFixed(2)} SGD
            </div>
            <button onClick={loadTreasuryBalance} style={{ ...buttonStyle, backgroundColor: "#6c757d", fontSize: 12 }}>
              Refresh Balance
            </button>
          </div>
          
          <div style={{ display: "flex", gap: 12 }}>
            <button onClick={settleAttestors} style={{ ...buttonStyle, backgroundColor: "#6f42c1" }}>
              Settle Attestors
            </button>
            <button onClick={disburseToCharity} style={{ ...buttonStyle, backgroundColor: "#28a745" }}>
              Disburse to Charity (If Verified)
            </button>
          </div>
        </section>
      )}

      {/* Event Log */}
      <section style={{ padding: 16, border: "1px solid #ddd", borderRadius: 8, backgroundColor: "#f8f9fa" }}>
        <h3>📋 Event Log</h3>
        <div style={{ maxHeight: 400, overflowY: "auto", backgroundColor: "white", padding: 12, borderRadius: 4, fontFamily: "monospace", fontSize: 12 }}>
          {logs.length === 0 ? (
            <div style={{ color: "#999" }}>No events yet...</div>
          ) : (
            logs.map((log, idx) => (
              <div key={idx} style={{ marginBottom: 4 }}>
                <span style={{ color: "#666" }}>[{log.time}]</span> {log.message}
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  );
}

const buttonStyle = {
  padding: "10px 20px",
  backgroundColor: "#007bff",
  color: "white",
  border: "none",
  borderRadius: 4,
  cursor: "pointer",
  fontSize: 14,
  fontWeight: "bold",
};
