import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import addresses from "../config/addresses.json";
import CharityRegistryArtifact from "../abi/CharityRegistry.json";
import { getWallets } from "../utils/wallets";

export default function AdminPage() {
  const [adminAddr, setAdminAddr] = useState(null);
  const [adminWallet, setAdminWallet] = useState(null);
  const [registryList, setRegistryList] = useState([]);
  const [events, setEvents] = useState([]);
  const [status, setStatus] = useState("");
  const rpcUrl = "http://127.0.0.1:8545";

  useEffect(() => {
    loadAdminAccount();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadAdminAccount() {
    setStatus("Loading admin account (index 0)...");
    try {
      const wallets = await getWallets(rpcUrl);
      if (!Array.isArray(wallets) || wallets.length === 0) {
        setStatus('accountPrivateKey.json missing or empty');
        return;
      }
      const w = wallets[0];
      const addr = await w.getAddress();
      setAdminAddr(addr);
      setAdminWallet(w);
      setStatus('Loaded admin wallet: ' + addr);
      await loadRegistrySummary();
    } catch (e) {
      setStatus('Failed to load admin wallet: ' + (e.message || e));
    }
  }

  async function loadRegistrySummary() {
    try {
      const provider = new ethers.JsonRpcProvider(rpcUrl);
      const registry = new ethers.Contract(addresses.CharityRegistry, CharityRegistryArtifact.abi, provider);
      const total = Number(await registry.totalRegistered().catch(() => 0));
      const list = [];
      const max = Math.min(total, 50);
      for (let i = 1; i <= max; i++) {
        try {
          const p = await registry.profiles(i);
          list.push({ orgId: i, name: p.name, registrant: p.registrant, approved: p.approved, treasury: p.treasury });
        } catch (e) {
          // ignore individual fetch errors
        }
      }
      setRegistryList(list);
    } catch (e) {
      setStatus('Failed to load registry: ' + (e.message || e));
    }
  }

  async function approveOrg(orgId) {
    if (!adminWallet) return setStatus('Admin wallet not loaded');
    setStatus('Approving org #' + orgId + '...');
    try {
      const registry = new ethers.Contract(addresses.CharityRegistry, CharityRegistryArtifact.abi, adminWallet);
      const tx = await registry.setApproval(orgId, true);
      setStatus('Tx sent: ' + tx.hash);
      await tx.wait();
      setStatus('Approved org #' + orgId);
      await loadRegistrySummary();
    } catch (e) {
      setStatus('Approve failed: ' + (e.message || e));
    }
  }

  async function setOrgTreasury(orgId, treasuryAddr) {
    if (!adminWallet) return setStatus('Admin wallet not loaded');
    if (!treasuryAddr || treasuryAddr.length === 0) return setStatus('Provide a treasury address');
    setStatus('Assigning treasury for org #' + orgId + '...');
    try {
      const registry = new ethers.Contract(addresses.CharityRegistry, CharityRegistryArtifact.abi, adminWallet);
      const tx = await registry.setTreasury(orgId, treasuryAddr);
      setStatus('Tx sent: ' + tx.hash);
      await tx.wait();
      setStatus('Treasury assigned for org #' + orgId);
      await loadRegistrySummary();
      // After assigning the registry pointer, attempt to initialize the treasury contract
      try {
        // fetch registrant for this orgId
        const profile = await registry.profiles(orgId);
        const registrant = profile.registrant;
        if (registrant && registrant !== ethers.ZeroAddress) {
          setStatus((s) => (s ? s + ' | Initializing treasury...' : 'Initializing treasury...'));
          const treasuryAbi = [{ "inputs": [{ "internalType": "uint256", "name": "orgId", "type": "uint256" },{ "internalType": "address", "name": "owner", "type": "address" }], "name": "createTreasury", "outputs": [], "stateMutability": "nonpayable", "type": "function" },
            { "inputs": [{ "internalType": "uint256", "name": "orgId", "type": "uint256" }], "name": "treasuries", "outputs": [{ "internalType": "uint256", "name": "orgId", "type": "uint256" },{ "internalType": "uint256", "name": "totalBalance", "type": "uint256" },{ "internalType": "uint256", "name": "availableBalance", "type": "uint256" },{ "internalType": "uint256", "name": "lockedBalance", "type": "uint256" },{ "internalType": "address", "name": "owner", "type": "address" },{ "internalType": "bool", "name": "active", "type": "bool" },{ "internalType": "uint256", "name": "lastActivity", "type": "uint256" }], "stateMutability": "view", "type": "function" }];
          const contract = new ethers.Contract(treasuryAddr, treasuryAbi, adminWallet);
          // check whether treasury already exists
          try {
            const existing = await contract.treasuries(BigInt(orgId));
            const owner = existing[4];
            if (owner && owner !== ethers.ZeroAddress) {
              setStatus('Treasury already exists for org ' + orgId + ' (owner: ' + owner + ')');
              return;
            }
          } catch (e) {
            // ignore view error and continue to attempt creation
          }
          const tx2 = await contract.createTreasury(BigInt(orgId), registrant);
          setStatus('createTreasury tx sent: ' + tx2.hash);
          await tx2.wait();
          setStatus('Treasury created for org ' + orgId);
          await loadRegistrySummary();
        }
      } catch (err2) {
        // Non-fatal: report but don't treat as blocking
        setStatus((s) => (s ? s + ' | createTreasury failed: ' + (err2.message || err2) : 'createTreasury failed: ' + (err2.message || err2)));
      }
    } catch (e) {
      setStatus('Set treasury failed: ' + (e.message || e));
    }
  }

  // Event listeners
  useEffect(() => {
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const registry = new ethers.Contract(addresses.CharityRegistry, CharityRegistryArtifact.abi, provider);

    function pushEvent(obj) {
      setEvents((prev) => [obj, ...prev].slice(0, 200));
    }

    const onRegistered = (orgId, name, registrant, event) => {
      pushEvent({ id: Date.now() + Math.random(), type: 'CharityRegistered', orgId: Number(orgId), name, registrant, tx: event.transactionHash });
    };
    const onApproved = (orgId, isApproved, event) => {
      pushEvent({ id: Date.now() + Math.random(), type: 'CharityApproved', orgId: Number(orgId), approved: isApproved, tx: event.transactionHash });
    };
    const onProfileUpdated = (orgId, metaCID, event) => {
      pushEvent({ id: Date.now() + Math.random(), type: 'ProfileUpdated', orgId: Number(orgId), metaCID, tx: event.transactionHash });
    };
    const onTreasuryAssigned = (orgId, treasury, event) => {
      pushEvent({ id: Date.now() + Math.random(), type: 'TreasuryAssigned', orgId: Number(orgId), treasury, tx: event.transactionHash });
    };

    try { registry.on('CharityRegistered', onRegistered); } catch (e) {}
    try { registry.on('CharityApproved', onApproved); } catch (e) {}
    try { registry.on('ProfileUpdated', onProfileUpdated); } catch (e) {}
    try { registry.on('TreasuryAssigned', onTreasuryAssigned); } catch (e) {}

    return () => {
      try { registry.off('CharityRegistered', onRegistered); } catch (e) {}
      try { registry.off('CharityApproved', onApproved); } catch (e) {}
      try { registry.off('ProfileUpdated', onProfileUpdated); } catch (e) {}
      try { registry.off('TreasuryAssigned', onTreasuryAssigned); } catch (e) {}
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div style={{ padding: 20 }}>
      <h2>Admin Page (account index 0)</h2>
      <div style={{ marginBottom: 8 }}>{status}</div>

      <div style={{ display: 'flex', gap: 12 }}>
        <div style={{ flex: 2 }}>
          <section>
            <h3>Charity Registry (first 50)</h3>
            <div style={{ maxHeight: '50vh', overflow: 'auto', border: '1px solid #eee', padding: 8 }}>
              {registryList.length === 0 ? (
                <div style={{ color: '#666' }}>No entries</div>
              ) : (
                registryList.map((r) => (
                  <div key={r.orgId} style={{ padding: 6, borderBottom: '1px solid #f6f6f6', display: 'grid', gridTemplateColumns: '1fr 220px', gap: 8 }}>
                    <div>
                      <div><strong>#{r.orgId}</strong> {r.name || '(no name)'}</div>
                      <div style={{ fontFamily: 'monospace', fontSize: 12 }}>registrant: {r.registrant}</div>
                      <div>approved: {String(r.approved)} treasury: {r.treasury}</div>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      <div>
                        <button onClick={() => approveOrg(r.orgId)} disabled={r.approved}>Approve</button>
                      </div>
                      <div style={{ display: 'flex', gap: 8 }}>
                        <input id={`treasury-${r.orgId}`} placeholder="treasury address" defaultValue={r.treasury || ''} style={{ flex: 1 }} />
                        <button onClick={() => {
                          const el = document.getElementById(`treasury-${r.orgId}`);
                          if (!el) return setStatus('Input missing');
                          const val = el.value.trim();
                          setOrgTreasury(r.orgId, val);
                        }}>Set Treasury</button>
                      </div>
                      <div style={{ display: 'flex', gap: 8 }}>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: 12, color: '#666' }}>OrgId: {r.orgId}</div>
                          <div style={{ fontSize: 12, color: '#666' }}>Owner: <span style={{ fontFamily: 'monospace' }}>{r.registrant}</span></div>
                        </div>
                        <div>
                          {/* Only allow Create Treasury if admin has assigned a treasury contract in the registry */}
                          {r.treasury && r.treasury !== ethers.ZeroAddress ? (
                            <button onClick={async () => {
                              if (!adminWallet) return setStatus('Admin wallet not loaded');
                              try {
                                setStatus('Creating treasury on ' + r.treasury + ' for org ' + r.orgId + '...');
                                const treasuryAbi = [{ "inputs": [{ "internalType": "uint256", "name": "orgId", "type": "uint256" },{ "internalType": "address", "name": "owner", "type": "address" }], "name": "createTreasury", "outputs": [], "stateMutability": "nonpayable", "type": "function" },
                                  { "inputs": [{ "internalType": "uint256", "name": "orgId", "type": "uint256" }], "name": "treasuries", "outputs": [{ "internalType": "uint256", "name": "orgId", "type": "uint256" },{ "internalType": "uint256", "name": "totalBalance", "type": "uint256" },{ "internalType": "uint256", "name": "availableBalance", "type": "uint256" },{ "internalType": "uint256", "name": "lockedBalance", "type": "uint256" },{ "internalType": "address", "name": "owner", "type": "address" },{ "internalType": "bool", "name": "active", "type": "bool" },{ "internalType": "uint256", "name": "lastActivity", "type": "uint256" }], "stateMutability": "view", "type": "function" }];
                                const contract = new ethers.Contract(r.treasury, treasuryAbi, adminWallet);
                                // check whether treasury already exists
                                try {
                                  const existing = await contract.treasuries(BigInt(r.orgId));
                                  const owner = existing[4];
                                  if (owner && owner !== ethers.ZeroAddress) {
                                    setStatus('Treasury already exists for org ' + r.orgId + ' (owner: ' + owner + ')');
                                    return;
                                  }
                                } catch (e) {
                                  // ignore view error and continue to attempt creation
                                }
                                const tx = await contract.createTreasury(BigInt(r.orgId), r.registrant);
                                setStatus('Tx sent: ' + tx.hash);
                                await tx.wait();
                                setStatus('Treasury created for org ' + r.orgId);
                                await loadRegistrySummary();
                              } catch (err) {
                                setStatus('createTreasury failed: ' + (err.message || err));
                              }
                            }}>Create Treasury</button>
                          ) : (
                            <button disabled title="Assign a treasury contract in the registry first">Create Treasury</button>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                ))
              )}
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
              <div style={{ color: '#666' }}>No events yet.</div>
            ) : (
              events.map((ev) => (
                <div key={ev.id} style={{ borderBottom: '1px solid #f0f0f0', padding: 8 }}>
                  <div style={{ fontSize: 12, color: '#999' }}>{new Date().toLocaleTimeString()}</div>
                  <div style={{ fontWeight: 700 }}>{ev.type}</div>
                  {ev.type === 'CharityRegistered' && (
                    <div>
                      <div>orgId: {ev.orgId}</div>
                      <div>name: {ev.name}</div>
                      <div style={{ fontFamily: 'monospace', fontSize: 12 }}>registrant: {ev.registrant}</div>
                      <div style={{ fontSize: 11, color: '#666' }}>tx: {ev.tx}</div>
                    </div>
                  )}
                  {ev.type === 'CharityApproved' && (
                    <div>orgId: {ev.orgId} approved: {String(ev.approved)} tx: {ev.tx}</div>
                  )}
                  {ev.type === 'ProfileUpdated' && (
                    <div>orgId: {ev.orgId} metaCID: {ev.metaCID} tx: {ev.tx}</div>
                  )}
                  {ev.type === 'TreasuryAssigned' && (
                    <div>orgId: {ev.orgId} treasury: {ev.treasury} tx: {ev.tx}</div>
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
