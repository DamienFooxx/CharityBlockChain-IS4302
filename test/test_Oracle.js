/* eslint-disable no-undef */
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

describe("Oracle", function () {
  const eventId = ethers.id("EVENT_1");
  const V_SEED = ethers.id("VOTER_SEED");
  const A_SEED = ethers.id("ATTESTOR_SEED");
  const QUORUM_BPS = 7000n; // 70%
  const PASS_MAJORITY_BPS = 7000n; // 70%

  // Deploys the full suite of contracts orchestrated by the Oracle
  async function deployOracleFixture() {
    // --- Get Signers ---
    const [
      owner,
      oracle,
      charityOwner,
      donor1,
      donor2,
      donor3,
      attestor1,
      other,
    ] = await ethers.getSigners();

    // --- Deploy Core Dependencies ---
    const Governance = await ethers.getContractFactory("Governance");
    const governance = await Governance.deploy(
      oracle.address,
      owner.address,
      QUORUM_BPS, // 70% quorum
      PASS_MAJORITY_BPS
    );
    await governance.waitForDeployment();

    const SGDCoin = await ethers.getContractFactory("SGDCoin");
    const sgdCoin = await SGDCoin.deploy();
    await sgdCoin.waitForDeployment();

    const EscrowVault = await ethers.getContractFactory("EscrowVault");
    // Deploy EscrowVault with governance and token addresses (constructor requires both)
    const escrowVault = await EscrowVault.deploy(
      governance.target,
      sgdCoin.target
    );
    await escrowVault.waitForDeployment();

    // --- Register EscrowVault with Governance ---
    await governance
      .connect(owner)
      .setContractAddress("EscrowVault", escrowVault.target);

    // --- Deploy Registries ---
    const DonorRegistry = await ethers.getContractFactory("DonorRegistry");
    const donorRegistry = await DonorRegistry.deploy(governance.target);
    await donorRegistry.waitForDeployment();

    const AttestorRegistry = await ethers.getContractFactory(
      "AttestorRegistry"
    );
    const attestorRegistry = await AttestorRegistry.deploy(governance.target);
    await attestorRegistry.waitForDeployment();

    // 1. Deploy CharityRegistry
    const CharityRegistry = await ethers.getContractFactory("CharityRegistry");
    const charityRegistry = await CharityRegistry.deploy(governance.target);
    await charityRegistry.waitForDeployment();

    // 2. Deploy CharityTreasury
    const CharityTreasury = await ethers.getContractFactory("CharityTreasury");
    const charityTreasury = await CharityTreasury.deploy(
      sgdCoin.target,
      governance.target
    );
    await charityTreasury.waitForDeployment();

    // 3. Setup a Charity and link the Treasury
    const orgId = 1n;
    await charityRegistry
      .connect(charityOwner)
      ["registerCharity(string,string)"]("Test Charity", "cid");
    await charityTreasury
      .connect(owner) // Admin creates treasury
      .createTreasury(orgId, charityOwner.address);
    await charityRegistry
      .connect(owner) // Admin links treasury
      .setTreasury(orgId, charityTreasury.target);

    // --- Deploy Donor Support Contracts ---
    const DonorPledges = await ethers.getContractFactory("DonorPledges");
    const donorPledges = await DonorPledges.deploy(
      governance.target,
      sgdCoin.target
    );
    await donorPledges.waitForDeployment();

    // Authorize DonorPledges in the EscrowVault so depositPledge can be called
    await escrowVault
      .connect(owner)
      .authorizeContract(donorPledges.target, true);

    const DonorRanking = await ethers.getContractFactory("DonorRanking");
    const donorRanking = await DonorRanking.deploy(governance.target);
    await donorRanking.waitForDeployment();

    // --- Deploy Event-Specific Modules ---
    const CharityEvent = await ethers.getContractFactory("CharityEvent");
    const charityEvent = await CharityEvent.connect(charityOwner).deploy(
      governance.target,
      charityRegistry.target,
      eventId,
      orgId,
      charityTreasury.target,
      1000n, // fundingGoal
      (await ethers.provider.getBlock("latest")).timestamp + 86400, // deadline
      "Test Event"
    );
    await charityEvent.waitForDeployment();

    const DonorVoting = await ethers.getContractFactory("DonorVoting");
    const donorVoting = await DonorVoting.deploy(
      governance.target,
      donorRegistry.target,
      donorPledges.target,
      donorRanking.target,
      eventId
    );
    await donorVoting.waitForDeployment();

    const AttestorVoting = await ethers.getContractFactory("AttestorVoting");
    const attestorVoting = await AttestorVoting.deploy(
      governance.target,
      sgdCoin.target,
      attestorRegistry.target
    );
    await attestorVoting.waitForDeployment();

    // --- Deploy the Oracle ---
    const Oracle = await ethers.getContractFactory("Oracle");
    const oracleContract = await Oracle.deploy(
      governance.target,
      V_SEED,
      A_SEED
    );
    await oracleContract.waitForDeployment();

    await governance
      .connect(owner)
      .grantRole(await governance.ORACLE_ROLE(), oracleContract.target);

    // --- Final Setup: Register participants ---
    const donors = [donor1, donor2, donor3];
    const pledges = [1000n, 2000n, 5000n];

    for (let i = 0; i < donors.length; i++) {
      const donor = donors[i];
      const pledgeAmount = pledges[i];
      await donorRegistry.connect(donor).registerDonor(`Donor ${i + 1}`, "cid");
      await sgdCoin.connect(owner).mint(donor.address, pledgeAmount);
      await sgdCoin.connect(donor).approve(donorPledges.target, pledgeAmount);
      await donorPledges.connect(donor).createPledge(eventId, pledgeAmount);
    }

    // Register Attestor1
    await attestorRegistry
      .connect(owner)
      .setAttestorRegistration(attestor1.address, true);
    await sgdCoin.connect(owner).mint(attestor1.address, 1000n);

    // --- Helper functions ---
    const advanceTime = async (seconds) => {
      const now = (await ethers.provider.getBlock("latest")).timestamp;
      await ethers.provider.send("evm_setNextBlockTimestamp", [now + seconds]);
      await ethers.provider.send("evm_mine");
    };

    const getDeadlines = async () => {
      const now = (await ethers.provider.getBlock("latest")).timestamp;
      const commitTime = now + 100;
      const revealTime = now + 200;
      return { commitTime, revealTime };
    };

    // Helper to run a full donor vote
    const runFullDonorVote = async (didPass) => {
      // Note: This helper now uses donor1, donor2, and donor3 from the fixture
      const { commitTime, revealTime } = await getDeadlines();
      await oracleContract
        .connect(oracle)
        .setDeadlines(eventId, commitTime, revealTime, commitTime, revealTime);

      // Assign all 3 donors to 3 different streams
      await oracleContract
        .connect(oracle)
        .assignVoter(eventId, donor1.address, 0);
      await oracleContract
        .connect(oracle)
        .assignVoter(eventId, donor2.address, 1);
      await oracleContract
        .connect(oracle)
        .assignVoter(eventId, donor3.address, 2);

      await oracleContract.connect(oracle).advanceDonorPhase(eventId); // -> Commit

      // Commit for all 3 donors
      const donors = [donor1, donor2, donor3];
      const salts = {};
      for (const donor of donors) {
        const salt = ethers.id(`DONOR_SALT_${donor.address}`);
        salts[donor.address] = salt;
        const commitment = ethers.solidityPackedKeccak256(
          ["bool", "uint256"],
          [didPass, salt]
        );
        await donorVoting.connect(donor).commit(commitment);
      }

      await advanceTime(101);
      await oracleContract.connect(oracle).advanceDonorPhase(eventId); // -> Reveal

      // Reveal for all 3 donors
      for (const donor of donors) {
        await donorVoting.connect(donor).reveal(didPass, salts[donor.address]);
      }

      await advanceTime(101);
      await oracleContract.connect(oracle).advanceDonorPhase(eventId); // -> Finalized

      // Verify outcome
      const [decided, passed] = await donorVoting.overallResult();
      expect(decided).to.be.true;
      expect(passed).to.equal(didPass);
    };

    return {
      oracleContract,
      governance,
      donorVoting,
      attestorVoting,
      charityEvent,
      escrowVault,
      charityRegistry,
      charityTreasury,
      donorRegistry,
      donorPledges,
      donorRanking,
      attestorRegistry,
      sgdCoin,
      owner,
      oracle,
      charityOwner,
      donor1,
      donor2,
      donor3,
      attestor1,
      other,
      advanceTime,
      getDeadlines,
      runFullDonorVote,
    };
  }

  // =================================================================
  // 1. Deployment and Initialization
  // =================================================================
  describe("1. Deployment and Initialization", function () {
    it("1a) should set immutable variables", async () => {
      const { oracleContract, governance } = await loadFixture(
        deployOracleFixture
      );
      expect(await oracleContract.governance()).to.equal(governance.target);
      expect(await oracleContract.ORACLE_ROLE()).to.equal(
        ethers.id("ORACLE_ROLE")
      );
    });

    it("1b) should set initial seeds", async () => {
      const { oracleContract } = await loadFixture(deployOracleFixture);
      expect(await oracleContract.voterAssignmentSeed()).to.equal(V_SEED);
      expect(await oracleContract.attestorAssignmentSeed()).to.equal(A_SEED);
    });
  });

  // =================================================================
  // 2. Setup and Configuration (Oracle Only)
  // =================================================================
  describe("2. Setup and Configuration", function () {
    it("2a) onlyOracle modifier should reject non-oracle calls", async () => {
      const { oracleContract, other } = await loadFixture(deployOracleFixture);
      const revertMsg = "OracleAstraea: not oracle";
      await expect(
        oracleContract
          .connect(other)
          .setModules(eventId, other.address, other.address, other.address)
      ).to.be.revertedWith(revertMsg);
      await expect(
        oracleContract.connect(other).setSeeds(V_SEED, A_SEED)
      ).to.be.revertedWith(revertMsg);
    });

    it("2b) setModules: allows oracle to link modules", async () => {
      const {
        oracleContract,
        oracle,
        donorVoting,
        attestorVoting,
        charityEvent,
      } = await loadFixture(deployOracleFixture);

      const evId = ethers.id("NEW_EVENT");

      await expect(
        oracleContract
          .connect(oracle)
          .setModules(
            evId,
            donorVoting.target,
            attestorVoting.target,
            charityEvent.target
          )
      )
        .to.emit(oracleContract, "ModulesSet")
        .withArgs(
          evId,
          donorVoting.target,
          attestorVoting.target,
          charityEvent.target
        );

      const modules = await oracleContract.modules(evId);
      expect(modules.donor).to.equal(donorVoting.target);
      expect(modules.attestor).to.equal(attestorVoting.target);
      expect(modules.charity).to.equal(charityEvent.target);
    });

    it("2c) eventExists modifier: reverts if modules are not set", async () => {
      const { oracleContract, oracle, donor1 } = await loadFixture(
        deployOracleFixture
      );
      const badEventId = ethers.id("BAD_EVENT");
      const revertMsg = "OracleAstraea: donor module not set";
      await expect(
        oracleContract
          .connect(oracle)
          .assignVoter(badEventId, donor1.address, 0)
      ).to.be.revertedWith(revertMsg);
    });
  });

  // =================================================================
  // 3. Assignment and Phase Management
  // =================================================================
  describe("3. Assignment and Phase Management", function () {
    // Fixture with modules pre-set
    async function fixtureWithModules() {
      const fixture = await loadFixture(deployOracleFixture);
      const {
        oracleContract,
        oracle,
        donorVoting,
        attestorVoting,
        charityEvent,
      } = fixture;
      await oracleContract
        .connect(oracle)
        .setModules(
          eventId,
          donorVoting.target,
          attestorVoting.target,
          charityEvent.target
        );
      return fixture;
    }

    it("3a) assignVoter: correctly calls DonorVoting module", async () => {
      const { oracleContract, oracle, donor1, donorVoting } = await loadFixture(
        fixtureWithModules
      );

      await oracleContract
        .connect(oracle)
        .assignVoter(eventId, donor1.address, 0);

      expect(await donorVoting.isAssigned(donor1.address)).to.be.true;
      expect(await donorVoting.assignedStream(donor1.address)).to.equal(0);
    });

    it("3b) assignAttestor: correctly calls AttestorVoting module", async () => {
      const { oracleContract, oracle, attestor1, attestorVoting } =
        await loadFixture(fixtureWithModules);

      await oracleContract
        .connect(oracle)
        .assignAttestor(eventId, attestor1.address, 1);

      expect(await attestorVoting.isAssigned(attestor1.address)).to.be.true;
      expect(await attestorVoting.assignedStream(attestor1.address)).to.equal(
        1
      );
    });

    it("3c) assignVoterDeterministic: assigns correctly", async () => {
      const { oracleContract, oracle, donor1, donorVoting } = await loadFixture(
        fixtureWithModules
      );

      // hash(seed, eventId, donor1) % 3
      const expectedStream =
        BigInt(
          ethers.solidityPackedKeccak256(
            ["bytes32", "bytes32", "address"],
            [V_SEED, eventId, donor1.address]
          )
        ) % 3n;

      await oracleContract
        .connect(oracle)
        .assignVoterDeterministic(eventId, donor1.address);

      expect(await donorVoting.isAssigned(donor1.address)).to.be.true;
      expect(await donorVoting.assignedStream(donor1.address)).to.equal(
        expectedStream
      );
    });

    it("3d) advanceBothPhases: advances both modules", async () => {
      const {
        oracleContract,
        oracle,
        donorVoting,
        attestorVoting,
        getDeadlines,
      } = await loadFixture(fixtureWithModules);

      // Set deadlines first
      const { commitTime, revealTime } = await getDeadlines();
      await oracleContract
        .connect(oracle)
        .setDeadlines(eventId, commitTime, revealTime, commitTime, revealTime);

      expect(await donorVoting.phase()).to.equal(0); // Pending
      expect(await attestorVoting.phase()).to.equal(0); // Pending

      await oracleContract.connect(oracle).advanceBothPhases(eventId);

      expect(await donorVoting.phase()).to.equal(1); // Commit
      expect(await attestorVoting.phase()).to.equal(1); // Commit
    });
  });

  // =================================================================
  // 4. Settlement and Disbursement (E2E)
  // =================================================================
  describe("4. Settlement and Disbursement (E2E)", function () {
    // Fixture with modules pre-set
    async function fixtureWithModules() {
      const fixture = await loadFixture(deployOracleFixture);
      const {
        oracleContract,
        oracle,
        donorVoting,
        attestorVoting,
        charityEvent,
      } = fixture;
      await oracleContract
        .connect(oracle)
        .setModules(
          eventId,
          donorVoting.target,
          attestorVoting.target,
          charityEvent.target
        );
      return fixture;
    }

    it("4a) disburseIfVerified: SUCCESS path", async () => {
      const fixture = await loadFixture(fixtureWithModules);
      const {
        oracleContract,
        oracle,
        charityEvent,
        escrowVault,
        charityTreasury,
        sgdCoin,
        runFullDonorVote,
        advanceTime,
        charityOwner, 
      } = fixture;
      // 1. Run donor vote to PASS (true)
      await runFullDonorVote(true);

      // 2. --- FIX: Advance CharityEvent to VERIFICATION phase ---
      await charityEvent.connect(charityOwner).closeFunding(); // Phase: FUNDING -> CLOSED
      await charityEvent.connect(charityOwner).submitEvidence("ipfs://cid"); // Phase: CLOSED -> VERIFICATION

      // 3. Advance AttestorVoting to Finalized (since it wasn't used)
      await oracleContract.connect(oracle).advanceAttestorPhase(eventId); // -> Commit
      await advanceTime(101);
      await oracleContract.connect(oracle).advanceAttestorPhase(eventId); // -> Reveal
      await advanceTime(101);
      await oracleContract.connect(oracle).advanceAttestorPhase(eventId); // -> Finalized

      // 4. Call settleAttestors
      await oracleContract.connect(oracle).settleAttestors(eventId);

      // 5. Call disburse
      // This will now call setVerified() on the CharityEvent, which is in the correct VERIFICATION phase
      await expect(oracleContract.connect(oracle).disburseIfVerified(eventId))
        .to.emit(oracleContract, "Disbursed")
        .withArgs(eventId, charityTreasury.target);

      // 6. Check effects
      expect(await charityEvent.verified()).to.be.true;
      expect(await charityEvent.phase()).to.equal(4); // 3 = EventPhase.COMPLETED for event finish and fund disbursemnet
      expect(await escrowVault.released(eventId)).to.be.true;
      expect(await escrowVault.releaseRecipient(eventId)).to.equal(
        charityTreasury.target
      );

      // 7. Verify CharityTreasury received tokens and recorded balances
      // Sum of pledges from fixture = 1000 + 2000 + 5000 = 8000
      const expectedTotal = 8000n;
      const orgIdFromEvent = await charityEvent.orgId();
      const treasuryRecord = await charityTreasury.treasuries(orgIdFromEvent);
      expect(treasuryRecord.totalBalance).to.equal(expectedTotal);
      expect(treasuryRecord.availableBalance).to.equal(expectedTotal);
      // Token balance at treasury address also equals expectedTotal
      const tokenBal = await sgdCoin.balanceOf(charityTreasury.target);
      expect(tokenBal).to.equal(expectedTotal);
    });

    it("4b) disburseIfVerified: FAIL path (reverts)", async () => {
      const fixture = await loadFixture(fixtureWithModules);
      const {
        oracleContract,
        oracle,
        charityEvent,
        escrowVault,
        runFullDonorVote,
        advanceTime,
      } = fixture;

      // 1. Run donor vote to FAIL (false)
      await runFullDonorVote(false);

      // 2. Advance AttestorVoting to Finalized (since it wasn't used)
      await oracleContract.connect(oracle).advanceAttestorPhase(eventId); // -> Commit
      await advanceTime(101);
      await oracleContract.connect(oracle).advanceAttestorPhase(eventId); // -> Reveal
      await advanceTime(101);
      await oracleContract.connect(oracle).advanceAttestorPhase(eventId); // -> Finalized

      // 3. Call settleAttestors
      await oracleContract.connect(oracle).settleAttestors(eventId);

      // 4. Call disburse - should REVERT
      await expect(
        oracleContract.connect(oracle).disburseIfVerified(eventId)
      ).to.be.revertedWith("OracleAstraea: not verified");

      // 5. Check effects
      expect(await charityEvent.verified()).to.be.false;
      expect(await escrowVault.released(eventId)).to.be.false;
    });

    it("4c) disburseIfVerified: reverts if not finalized", async () => {
      const { oracleContract, oracle } = await loadFixture(fixtureWithModules);
      // Don't run the vote
      await expect(
        oracleContract.connect(oracle).disburseIfVerified(eventId)
      ).to.be.revertedWith("OracleAstraea: donor not decided");
    });
  });

  // =================================================================
  // 5. Retry Logic
  // =================================================================
  describe("5. Retry Logic", function () {
    // Fixture with modules pre-set
    async function fixtureWithFailedVote() {
      const fixture = await loadFixture(deployOracleFixture);
      const {
        oracleContract,
        oracle,
        donorVoting,
        attestorVoting,
        charityEvent,
        runFullDonorVote,
      } = fixture;
      await oracleContract
        .connect(oracle)
        .setModules(
          eventId,
          donorVoting.target,
          attestorVoting.target,
          charityEvent.target
        );

      // 1. Run donor vote to FAIL (false)
      await runFullDonorVote(false);
      return fixture;
    }

    it("5a) canStartRetry: returns true after a failed vote", async () => {
      const { oracleContract } = await loadFixture(fixtureWithFailedVote);
      expect(await oracleContract.canStartRetry(eventId)).to.be.true;
    });

    it("5b) startRetry: successfully starts a new round", async () => {
      const {
        oracleContract,
        oracle,
        getDeadlines,
        donorRegistry,
        donorPledges,
        donorRanking,
        attestorRegistry,
        sgdCoin,
      } = await loadFixture(fixtureWithFailedVote);

      const oldModules = await oracleContract.modules(eventId);
      const oldSeed = await oracleContract.voterAssignmentSeed();

      // Deploy NEW modules for the retry
      const newDonorVoting = await (
        await ethers.getContractFactory("DonorVoting")
      ).deploy(
        oracleContract.governance(),
        donorRegistry.target,
        donorPledges.target,
        donorRanking.target,
        eventId
      );
      const newAttestorVoting = await (
        await ethers.getContractFactory("AttestorVoting")
      ).deploy(
        oracleContract.governance(),
        sgdCoin.target,
        attestorRegistry.target
      );

      const { commitTime, revealTime } = await getDeadlines();

      await expect(
        oracleContract
          .connect(oracle)
          .startRetry(
            eventId,
            newDonorVoting.target,
            newAttestorVoting.target,
            commitTime,
            revealTime,
            commitTime,
            revealTime
          )
      ).to.emit(oracleContract, "RetryStarted");

      // Check effects
      const newModules = await oracleContract.modules(eventId);
      expect(newModules.donor).to.equal(newDonorVoting.target);
      expect(newModules.attestor).to.equal(newAttestorVoting.target);
      expect(newModules.donor).to.not.equal(oldModules.donor);

      expect(await oracleContract.currentRound(eventId)).to.equal(1);
      expect(await oracleContract.voterAssignmentSeed()).to.not.equal(oldSeed);
      expect(await newDonorVoting.commitDeadline()).to.equal(commitTime);
    });
  });
});
