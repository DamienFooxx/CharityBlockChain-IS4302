import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import addresses from "../config/addresses.json";
import CharityRegistryArtifact from "../abi/CharityRegistry.json";

export default function CharityPage() {
  const [charityAddr, setCharityAddr] = useState(null);
  const [orgId, setOrgId] = useState(0);
  const [profile, setProfile] = useState(null);
  const [status, setStatus] = useState("");
  const [registryList, setRegistryList] = useState([]);
  const [events, setEvents] = useState([]);
  const rpcUrl = "http://127.0.0.1:8545";

  // form
  const [name, setName] = useState("");
  const [metaCID, setMetaCID] = useState("");

  useEffect(() => {
    loadCharityAccount();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadCharityAccount() {
    setStatus("Loading charity account (index 12)...");
    try {
      const provider = new ethers.JsonRpcProvider(rpcUrl);
      const accounts = await provider.send("eth_accounts", []);
      if (!accounts || accounts.length <= 12) {
        setStatus("Local node does not expose account index 12. Found " + (accounts ? accounts.length : 0) + " accounts.");
        setCharityAddr(null);
        return;
      }
      const addr = accounts[12];
      setCharityAddr(addr);
      setStatus("Loaded charity address: " + addr);
      await refreshProfile(addr);
      await loadRegistrySummary();
    } catch (e) {
      setStatus("Failed to load charity account: " + (e.message || e));
    }
  }

  async function refreshProfile(wallet) {
    try {
      const provider = new ethers.JsonRpcProvider(rpcUrl);
      const registry = new ethers.Contract(addresses.CharityRegistry, CharityRegistryArtifact.abi, provider);
      const org = await registry.addressToOrgId(wallet);
      setOrgId(Number(org));
      if (Number(org) !== 0) {
        const p = await registry.getCharity(wallet);
        setProfile({ name: p.name, metaCID: p.metaCID, approved: p.approved, treasury: p.treasury, registrant: p.registrant });
      } else {
        setProfile(null);
      }
    } catch (e) {
      setStatus("Failed to read profile: " + (e.message || e));
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
          // ignore
        }
      }
      setRegistryList(list);
    } catch (e) {
      setStatus("Failed to load registry: " + (e.message || e));
    }
  }

  async function registerCharity() {
    setStatus("Registering charity...");
    try {
      const provider = new ethers.JsonRpcProvider(rpcUrl);
      if (!charityAddr) {
        // try to load accounts if charityAddr is missing
        const accounts = await provider.send("eth_accounts", []);
        if (!accounts || accounts.length <= 12) throw new Error("No local account index 12 available to send txs");
      }

      // Try to use the local RPC signer (account index 12). If the local node is not running
      // or doesn't expose unlocked accounts, fall back to MetaMask (BrowserProvider) if available.
      let signer = provider.getSigner(charityAddr || 12);
      let signerOk = true;
      try {
        // this will fail if the signer cannot provide an address / send txs
        await signer.getAddress();
      } catch (err) {
        signerOk = false;
      }

      if (!signerOk) {
        if (typeof window !== "undefined" && window.ethereum) {
          setStatus("Local RPC signer not available — falling back to MetaMask. Please approve the request in MetaMask.");
          const browserProvider = new ethers.BrowserProvider(window.ethereum);
          await browserProvider.send("eth_requestAccounts", []);
          signer = await browserProvider.getSigner();
        } else {
          throw new Error(
            "No signer available: start a local Hardhat node (npx hardhat node) or connect MetaMask in the browser."
          );
        }
      }

      const registry = new ethers.Contract(addresses.CharityRegistry, CharityRegistryArtifact.abi, signer);
      // Contract has two overloads for registerCharity: registerCharity(string,string) for
      // self-registration (name + metaCID) and registerCharity(address,string) for admin-led
      // registration. Use the fully-qualified signature to disambiguate.
      const tx = await registry["registerCharity(string,string)"](name, metaCID);
      setStatus("Tx sent: " + tx.hash);
      await tx.wait();
      setStatus("Registration confirmed");
      await refreshProfile(charityAddr || (await signer.getAddress()));
      await loadRegistrySummary();
    } catch (e) {
      setStatus("Register failed: " + (e.message || e));
    }
  }

  // Event listeners for registry events
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
      <h2>Charity Page (account index 12)</h2>
      <div style={{ marginBottom: 8 }}>{status}</div>

      <div style={{ display: 'flex', gap: 12 }}>
        <div style={{ flex: 2 }}>
          <section style={{ marginBottom: 12 }}>
            <h3>Charity Account</h3>
            <div>Address (index 12): <code>{charityAddr || 'loading...'}</code></div>
            <div>OrgId: {orgId || 'not registered'}</div>
            {profile ? (
              <div style={{ marginTop: 8 }}>
                <div><strong>Name:</strong> {profile.name}</div>
                <div><strong>metaCID:</strong> {profile.metaCID}</div>
                <div><strong>approved:</strong> {String(profile.approved)}</div>
                <div><strong>treasury:</strong> {profile.treasury}</div>
              </div>
            ) : (
              <div style={{ marginTop: 8, color: '#666' }}>Charity not registered yet.</div>
            )}
          </section>

          <section style={{ marginBottom: 12 }}>
            <h3>Create / Register Charity</h3>
            <div style={{ display: 'grid', gap: 8, maxWidth: 600 }}>
              <input placeholder="Charity name" value={name} onChange={(e) => setName(e.target.value)} />
              <input placeholder="metaCID (IPFS hash)" value={metaCID} onChange={(e) => setMetaCID(e.target.value)} />
              <div>
                <button onClick={registerCharity}>Register Charity (from account 12)</button>
                <button style={{ marginLeft: 8 }} onClick={() => refreshProfile(charityAddr)}>Refresh Profile</button>
              </div>
            </div>
          </section>

          <section>
            <h3>Charity Registry (first 50)</h3>
            <div style={{ maxHeight: '50vh', overflow: 'auto', border: '1px solid #eee', padding: 8 }}>
              {registryList.length === 0 ? (
                <div style={{ color: '#666' }}>No entries</div>
              ) : (
                registryList.map((r) => (
                  <div key={r.orgId} style={{ padding: 6, borderBottom: '1px solid #f6f6f6' }}>
                    <div><strong>#{r.orgId}</strong> {r.name || '(no name)'}</div>
                    <div style={{ fontFamily: 'monospace', fontSize: 12 }}>registrant: {r.registrant}</div>
                    <div>approved: {String(r.approved)} treasury: {r.treasury}</div>
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
