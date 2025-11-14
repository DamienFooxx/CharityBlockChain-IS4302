// Deployment script for the CharityBlockChain system
// Deploys core contracts, registers addresses in Governance, and performs basic authorization wiring.
// Usage: npx hardhat run --network <network> scripts/deploy.js

const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log("Deploying contracts with account:", deployer.address);

  const GasEstimator = (tx) => tx.wait().then(() => {});

  // 1) Deploy Governance (initialOracle and initialPauser default to deployer)
  const Governance = await hre.ethers.getContractFactory("Governance");
  const initialQuorum = 5000; // 50% in bps
  const initialPassMajority = 5000; // 50% in bps
  const governance = await Governance.deploy(
    deployer.address,
    deployer.address,
    initialQuorum,
    initialPassMajority
  );
  await governance.waitForDeployment();
  console.log("Governance deployed:", governance.target);

  // 2) Deploy SGDCoin
  const SGDCoin = await hre.ethers.getContractFactory("SGDCoin");
  const sgd = await SGDCoin.deploy();
  await sgd.waitForDeployment();
  console.log("SGDCoin deployed:", sgd.target);

  // 3) Deploy Registries (CharityRegistry, DonorRegistry, AttestorRegistry)
  const CharityRegistry = await hre.ethers.getContractFactory(
    "CharityRegistry"
  );
  const charityRegistry = await CharityRegistry.deploy(governance.target);
  await charityRegistry.waitForDeployment();
  console.log("CharityRegistry deployed:", charityRegistry.target);

  const DonorRegistry = await hre.ethers.getContractFactory("DonorRegistry");
  const donorRegistry = await DonorRegistry.deploy(governance.target);
  await donorRegistry.waitForDeployment();
  console.log("DonorRegistry deployed:", donorRegistry.target);

  const AttestorRegistry = await hre.ethers.getContractFactory(
    "AttestorRegistry"
  );
  const attestorRegistry = await AttestorRegistry.deploy(governance.target);
  await attestorRegistry.waitForDeployment();
  console.log("AttestorRegistry deployed:", attestorRegistry.target);

  // 4) Deploy Reputation/Ranking and other system helpers
  const DonorRanking = await hre.ethers.getContractFactory("DonorRanking");
  const donorRanking = await DonorRanking.deploy(governance.target);
  await donorRanking.waitForDeployment();
  console.log("DonorRanking deployed:", donorRanking.target);

  const CharityReputation = await hre.ethers.getContractFactory(
    "CharityReputation"
  );
  const charityReputation = await CharityReputation.deploy(governance.target);
  await charityReputation.waitForDeployment();
  console.log("CharityReputation deployed:", charityReputation.target);

  // 5) Deploy EscrowVault and DonorPledges (both need governance + token)
  const EscrowVault = await hre.ethers.getContractFactory("EscrowVault");
  const escrow = await EscrowVault.deploy(governance.target, sgd.target);
  await escrow.waitForDeployment();
  console.log("EscrowVault deployed:", escrow.target);

  const DonorPledges = await hre.ethers.getContractFactory("DonorPledges");
  const donorPledges = await DonorPledges.deploy(governance.target, sgd.target, donorRegistry.target);
  await donorPledges.waitForDeployment();
  console.log("DonorPledges deployed:", donorPledges.target);

  // 6) Deploy CharityTreasury (stablecoin, governance)
  const CharityTreasury = await hre.ethers.getContractFactory(
    "CharityTreasury"
  );
  const charityTreasury = await CharityTreasury.deploy(
    sgd.target,
    governance.target
  );
  await charityTreasury.waitForDeployment();
  console.log("CharityTreasury deployed:", charityTreasury.target);

  // 7) Deploy EvidenceVault (no args)
  const EvidenceVault = await hre.ethers.getContractFactory("EvidenceVault");
  const evidenceVault = await EvidenceVault.deploy();
  await evidenceVault.waitForDeployment();
  console.log("EvidenceVault deployed:", evidenceVault.target);

  // 8) Deploy core voting modules that are not strictly per-event
  const AttestorVoting = await hre.ethers.getContractFactory("AttestorVoting");
  const attestorVoting = await AttestorVoting.deploy(
    governance.target,
    sgd.target,
    attestorRegistry.target
  );
  await attestorVoting.waitForDeployment();
  console.log("AttestorVoting deployed:", attestorVoting.target);

  // 9) Deploy a sample DonorVoting instance (note: DonorVoting is per-event; we deploy a sample template)
  const DonorVoting = await hre.ethers.getContractFactory("DonorVoting");
  // Create a sample eventId
  const sampleEventId = hre.ethers.keccak256(
    hre.ethers.toUtf8Bytes("sample-event-1")
  );
  const donorVoting = await DonorVoting.deploy(
    governance.target,
    donorRegistry.target,
    donorPledges.target,
    donorRanking.target,
    sampleEventId
  );
  await donorVoting.waitForDeployment();
  console.log("Sample DonorVoting deployed:", donorVoting.target);

  // 10) Deploy Oracle (needs governance + seeds)
  const Oracle = await hre.ethers.getContractFactory("Oracle");
  // Use pseudorandom seeds (deterministic per deployment)
  const voterSeed = hre.ethers.keccak256(
    hre.ethers.toUtf8Bytes("voter-seed-" + Date.now() + deployer.address)
  );
  const attestorSeed = hre.ethers.keccak256(
    hre.ethers.toUtf8Bytes("attestor-seed-" + Date.now() + deployer.address)
  );
  const oracle = await Oracle.deploy(
    governance.target,
    voterSeed,
    attestorSeed
  );
  await oracle.waitForDeployment();
  console.log("Oracle deployed:", oracle.target);

  // 11) Wire addresses into Governance registry (so modules can look them up)
  const setAddr = async (name, addr) => {
    const tx = await governance.setContractAddress(name, addr);
    await tx.wait();
    console.log(`Registered ${name} => ${addr}`);
  };

  await setAddr("SGDCoin", sgd.target);
  await setAddr("EscrowVault", escrow.target);
  await setAddr("DonorPledges", donorPledges.target);
  await setAddr("DonorRegistry", donorRegistry.target);
  await setAddr("DonorRanking", donorRanking.target);
  await setAddr("AttestorRegistry", attestorRegistry.target);
  await setAddr("AttestorVoting", attestorVoting.target);
  await setAddr("CharityRegistry", charityRegistry.target);
  await setAddr("CharityReputation", charityReputation.target);
  await setAddr("CharityTreasury", charityTreasury.target);
  await setAddr("EvidenceVault", evidenceVault.target);
  await setAddr("Oracle", oracle.target);
  await setAddr("DonorVotingSample", donorVoting.target);

  // 12) Authorize DonorPledges and DonorVoting in EscrowVault, and authorize voting modules in DonorPledges where needed
  let tx = await escrow.authorizeContract(donorPledges.target, true);
  await tx.wait();
  console.log("Escrow: authorized DonorPledges");

  tx = await escrow.authorizeContract(oracle.target, true);
  await tx.wait();
  console.log("Escrow: authorized Oracle");

  tx = await donorPledges.authorizeContract(donorVoting.target, true);
  await tx.wait();
  console.log("DonorPledges: authorized DonorVoting (sample)");

  tx = await donorPledges.authorizeContract(attestorVoting.target, true);
  await tx.wait();
  console.log("DonorPledges: authorized AttestorVoting");

  // 13) Output summary
  console.log("\nDeployment summary:");
  console.log("Governance:", governance.target);
  console.log("SGDCoin:", sgd.target);
  console.log("EscrowVault:", escrow.target);
  console.log("DonorPledges:", donorPledges.target);
  console.log("DonorRegistry:", donorRegistry.target);
  console.log("DonorRanking:", donorRanking.target);
  console.log("AttestorRegistry:", attestorRegistry.target);
  console.log("AttestorVoting:", attestorVoting.target);
  console.log("EvidenceVault:", evidenceVault.target);
  console.log("CharityRegistry:", charityRegistry.target);
  console.log("CharityReputation:", charityReputation.target);
  console.log("CharityTreasury:", charityTreasury.target);
  console.log("Oracle:", oracle.target);
  console.log("Sample DonorVoting:", donorVoting.target);
  console.log(
    "\nTo change any initial parameters edit scripts/deploy.js and re-run the script."
  );

  // 14) Write frontend addresses JSON for easy import in the UI
  try {
    const fs = require("fs");
    const path = require("path");
    const out = {
      Governance: governance.target,
      SGDCoin: sgd.target,
      EscrowVault: escrow.target,
      DonorPledges: donorPledges.target,
      DonorRegistry: donorRegistry.target,
      DonorRanking: donorRanking.target,
      AttestorRegistry: attestorRegistry.target,
      AttestorVoting: attestorVoting.target,
      EvidenceVault: evidenceVault.target,
      CharityRegistry: charityRegistry.target,
      CharityReputation: charityReputation.target,
      CharityTreasury: charityTreasury.target,
      Oracle: oracle.target,
      DonorVotingSample: donorVoting.target,
    };

    // each new blockchain node => new instance of blockchain address when deployed => update in addresses.json to frontend

    const frontendPath = path.join(
      __dirname,
      "..",
      "frontend",
      "src",
      "config"
    );
    if (!fs.existsSync(frontendPath)) {
      fs.mkdirSync(frontendPath, { recursive: true });
    }

    const outFile = path.join(frontendPath, "addresses.json");
    fs.writeFileSync(outFile, JSON.stringify(out, null, 2), {
      encoding: "utf8",
    });
    console.log("Wrote frontend addresses to", outFile);
  } catch (e) {
    console.warn("Failed to write frontend addresses.json:", e.message || e);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
