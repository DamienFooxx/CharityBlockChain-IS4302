import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import addresses from "../config/addresses.json";
import CharityRegistryArtifact from "../abi/CharityRegistry.json";
import CharityTreasuryArtifact from "../abi/CharityTreasury.json";
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
      const treasury = new ethers.Contract(addresses.CharityTreasury, CharityTreasuryArtifact.abi, provider);
      
      const total = Number(await registry.totalRegistered().catch(() => 0));
      const list = [];
      const max = Math.min(total, 50);
      for (let i = 1; i <= max; i++) {
        try {
          const p = await registry.profiles(i);
          // Check if treasury account exists in CharityTreasury contract
          let treasuryExists = false;
          let treasuryOwner = null;
          try {
            const t = await treasury.treasuries(i);
            treasuryOwner = t.owner;
            treasuryExists = treasuryOwner && treasuryOwner !== ethers.ZeroAddress;
          } catch (e) {
            // ignore
          }
          list.push({ 
            orgId: i, 
            name: p.name, 
            registrant: p.registrant, 
            approved: p.approved, 
            treasury: p.treasury,
            treasuryExists,
            treasuryOwner
          });
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
    setStatus('Assigning treasury contract pointer for org #' + orgId + '...');
    try {
      const registry = new ethers.Contract(addresses.CharityRegistry, CharityRegistryArtifact.abi, adminWallet);
      const tx = await registry.setTreasury(orgId, treasuryAddr);
      setStatus('Tx sent: ' + tx.hash);
      await tx.wait();
      setStatus('Treasury contract pointer assigned for org #' + orgId);
      await loadRegistrySummary();
    } catch (e) {
      setStatus('Set treasury failed: ' + (e.message || e));
    }
  }

  async function createTreasuryAccount(orgId, registrant) {
    if (!adminWallet) return setStatus('Admin wallet not loaded');
    if (!registrant || registrant === ethers.ZeroAddress) return setStatus('Invalid registrant address');
    
    setStatus('Creating treasury account for org #' + orgId + '...');
    try {
      const treasury = new ethers.Contract(addresses.CharityTreasury, CharityTreasuryArtifact.abi, adminWallet);
      
      // Check if treasury already exists
      try {
        const existing = await treasury.treasuries(BigInt(orgId));
        const owner = existing.owner;
        if (owner && owner !== ethers.ZeroAddress) {
          setStatus('Treasury account already exists for org ' + orgId + ' (owner: ' + owner + ')');
          return;
        }
      } catch (e) {
        // Continue if view call fails
      }
      
      const tx = await treasury.createTreasury(BigInt(orgId), registrant);
      setStatus('createTreasury tx sent: ' + tx.hash);
      await tx.wait();
      setStatus('Treasury account created for org ' + orgId + ' with owner ' + registrant);
      await loadRegistrySummary();
    } catch (e) {
      setStatus('createTreasury failed: ' + (e.message || e));
    }
  }

  async function useDeployedTreasury(orgId) {
    // Automatically set the treasury pointer to the deployed CharityTreasury contract
    setOrgTreasury(orgId, addresses.CharityTreasury);
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
                      <div style={{ fontSize: 12 }}>
                        <span>approved: {String(r.approved)}</span>
                        {' | '}
                        <span>treasury ptr: {r.treasury === ethers.ZeroAddress || !r.treasury ? 'not set' : '✓'}</span>
                        {' | '}
                        <span>treasury account: {r.treasuryExists ? '✓ created' : 'not created'}</span>
                      </div>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      <div>
                        <button onClick={() => approveOrg(r.orgId)} disabled={r.approved}>
                          {r.approved ? '✓ Approved' : 'Approve Charity'}
                        </button>
                      </div>
                      <div style={{ display: 'flex', gap: 4 }}>
                        <button 
                          onClick={() => useDeployedTreasury(r.orgId)}
                          disabled={r.treasury === addresses.CharityTreasury}
                          style={{ flex: 1 }}
                          title="Set treasury pointer to deployed CharityTreasury contract"
                        >
                          {r.treasury === addresses.CharityTreasury ? '✓ Pointer Set' : 'Set Treasury Pointer'}
                        </button>
                      </div>
                      <div style={{ display: 'flex', gap: 4 }}>
                        <button 
                          onClick={() => createTreasuryAccount(r.orgId, r.registrant)}
                          disabled={r.treasuryExists || r.treasury !== addresses.CharityTreasury}
                          style={{ flex: 1 }}
                          title={
                            r.treasuryExists 
                              ? 'Treasury account already created' 
                              : r.treasury !== addresses.CharityTreasury 
                                ? 'Set treasury pointer first' 
                                : 'Create treasury account in CharityTreasury contract'
                          }
                        >
                          {r.treasuryExists ? '✓ Account Created' : 'Create Treasury Account'}
                        </button>
                      </div>
                      <div style={{ fontSize: 11, color: '#666', padding: '4px 0' }}>
                        <div>OrgId: {r.orgId}</div>
                        <div>Owner: {r.registrant?.slice(0, 10)}...{r.registrant?.slice(-8)}</div>
                        {r.treasuryExists && r.treasuryOwner && (
                          <div>Treasury Owner: {r.treasuryOwner?.slice(0, 10)}...{r.treasuryOwner?.slice(-8)}</div>
                        )}
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
