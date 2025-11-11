/* eslint-disable no-undef */
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

describe("AttestorVoting", function () {
  const RAY = 10n ** 27n;
  const NUM_STREAMS = 3;
  const eventId = ethers.id("EVENT_1"); // Use a consistent eventId

  // Deploys the full suite of contracts needed for integration testing
  async function deployFullSystemFixture() {
    // --- Get Signers ---
    const [owner, oracle, attestor1, attestor2, donor1, donor2, other] =
      await ethers.getSigners();

    // --- Deploy Core Dependencies ---
    const Governance = await ethers.getContractFactory("Governance");
    const governance = await Governance.deploy(
      oracle.address,
      owner.address,
      7000n, // 70% quorum
      7000n // 70% pass
    );
    await governance.waitForDeployment();

    const SGDCoin = await ethers.getContractFactory("SGDCoin");
    const sgdCoin = await SGDCoin.deploy();
    await sgdCoin.waitForDeployment();

    // --- Deploy DonorVoting Dependencies ---
    const DonorRegistry = await ethers.getContractFactory("DonorRegistry");
    const donorRegistry = await DonorRegistry.deploy(governance.target);
    await donorRegistry.waitForDeployment();

    const DonorPledges = await ethers.getContractFactory("DonorPledges");
    const donorPledges = await DonorPledges.deploy(
      governance.target,
      sgdCoin.target,
      donorRegistry.target
    );
    await donorPledges.waitForDeployment();

    const EscrowVault = await ethers.getContractFactory("EscrowVault");
    const escrow = await EscrowVault.deploy(governance.target, sgdCoin.target);
    await escrow.waitForDeployment();
    await governance
      .connect(owner)
      .setContractAddress("EscrowVault", escrow.target);
    await escrow.connect(owner).authorizeContract(donorPledges.target, true);

    const DonorRanking = await ethers.getContractFactory("DonorRanking");
    const donorRanking = await DonorRanking.deploy(governance.target);
    await donorRanking.waitForDeployment();

    const AttestorRegistry = await ethers.getContractFactory(
      "AttestorRegistry"
    );
    const attestorRegistry = await AttestorRegistry.deploy(governance.target);
    await attestorRegistry.waitForDeployment();

    // --- Deploy Main Contracts ---
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

    // --- Fund Attestors, Donors, and Contract ---
    await sgdCoin.connect(owner).mint(attestor1.address, 10000n);
    await sgdCoin.connect(owner).mint(attestor2.address, 10000n);
    await sgdCoin.connect(owner).mint(donor1.address, 10000n);
    await sgdCoin.connect(owner).mint(donor2.address, 10000n);
    await sgdCoin.connect(owner).mint(attestorVoting.target, 1000000n); // Fund for rewards

    // Register Attestors
    await attestorRegistry
      .connect(owner)
      .setAttestorRegistration(attestor1.address, true);
    await attestorRegistry
      .connect(owner)
      .setAttestorRegistration(attestor2.address, true);

    // --- Setup Donors (Register & Pledge) ---
    const donorPledgesList = [
      { donor: donor1, pledge: 500n },
      { donor: donor2, pledge: 1500n },
    ];
    for (const { donor, pledge } of donorPledgesList) {
      await donorRegistry.connect(donor).registerDonor("Donor", "cid");
      // verify donor
      await donorRegistry.connect(owner).setVerification(donor.address, true);
      await sgdCoin.connect(donor).approve(donorPledges.target, pledge);
      await donorPledges.connect(donor).createPledge(eventId, pledge);
    }

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

    return {
      attestorVoting,
      donorVoting, // Return the real DonorVoting contract
      attestorRegistry,
      governance,
      sgdCoin,
      donorPledges,
      donorRanking,
      donorRegistry,
      owner,
      oracle,
      attestor1,
      attestor2,
      donor1,
      donor2,
      other,
      advanceTime,
      getDeadlines,
    };
  }

  // =================================================================
  // 1. Deployment and Initialization
  // =================================================================
  describe("1. Deployment and Initialization", function () {
    it("1a) should set correct immutable variables", async () => {
      const { attestorVoting, governance, sgdCoin } = await loadFixture(
        deployFullSystemFixture
      );
      expect(await attestorVoting.governance()).to.equal(governance.target);
      expect(await attestorVoting.stakeToken()).to.equal(sgdCoin.target);
    });

    it("1b) should initialize in Pending phase", async () => {
      const { attestorVoting } = await loadFixture(deployFullSystemFixture);
      expect(await attestorVoting.phase()).to.equal(0n); // 0 = Phase.Pending
    });

    it("1c) should set constants correctly", async () => {
      const { attestorVoting } = await loadFixture(deployFullSystemFixture);
      expect(await attestorVoting.NUM_STREAMS()).to.equal(NUM_STREAMS);
      expect(await attestorVoting.RAY()).to.equal(RAY);
    });

    it("1d) should default tau to 1", async () => {
      const { attestorVoting } = await loadFixture(deployFullSystemFixture);
      expect(await attestorVoting.tau()).to.equal(1n);
    });
  });

  // =================================================================
  // 2. Oracle Setup (Pending Phase)
  // =================================================================
  describe("2. Oracle Setup (Pending Phase)", function () {
    it("2a) onlyOracle modifiers should reject non-oracle calls", async () => {
      const {
        attestorVoting,
        other,
        eligibilityRoot,
        getDeadlines,
        donorVoting,
      } = await loadFixture(deployFullSystemFixture); // Corrected
      const { commitTime, revealTime } = await getDeadlines();

      const revertMsg = "AV: Not oracle";
      await expect(
        attestorVoting.connect(other).setSigmaBounds(0, 0)
      ).to.be.revertedWith(revertMsg);
      await expect(attestorVoting.connect(other).setTau(1)).to.be.revertedWith(
        revertMsg
      );
      await expect(
        attestorVoting.connect(other).fundPools(0, 0)
      ).to.be.revertedWith(revertMsg);
      await expect(
        attestorVoting.connect(other).recordAttestorAssignment(other.address, 0)
      ).to.be.revertedWith(revertMsg);
      await expect(
        attestorVoting.connect(other).adjustDeadline(commitTime, revealTime)
      ).to.be.revertedWith(revertMsg);
      await expect(
        attestorVoting.connect(other).advancePhase()
      ).to.be.revertedWith(revertMsg);
      await expect(
        attestorVoting.connect(other).setChallengeWindow(0)
      ).to.be.revertedWith(revertMsg);
      await expect(
        attestorVoting.connect(other).settleStream(0, donorVoting.target)
      ).to.be.revertedWith(revertMsg);
    });

    it("2b) setSigmaBounds: should set min/max stake", async () => {
      const { attestorVoting, oracle } = await loadFixture(
        deployFullSystemFixture
      ); // Corrected
      await attestorVoting.connect(oracle).setSigmaBounds(100n, 1000n);
      expect(await attestorVoting.sigmaMin()).to.equal(100n);
      expect(await attestorVoting.sigmaMax()).to.equal(1000n);
    });

    it("2c) setSigmaBounds: reverts if max < min (and max > 0)", async () => {
      const { attestorVoting, oracle } = await loadFixture(
        deployFullSystemFixture
      ); // Corrected
      await expect(
        attestorVoting.connect(oracle).setSigmaBounds(1001n, 1000n)
      ).to.be.revertedWith("AV: Max < Min");
    });

    it("2d) setTau: should set reward divisor", async () => {
      const { attestorVoting, oracle } = await loadFixture(
        deployFullSystemFixture
      ); // Corrected
      await attestorVoting.connect(oracle).setTau(10n);
      expect(await attestorVoting.tau()).to.equal(10n);
    });

    it("2e) setTau: reverts if tau is 0", async () => {
      const { attestorVoting, oracle } = await loadFixture(
        deployFullSystemFixture
      ); // Corrected
      await expect(
        attestorVoting.connect(oracle).setTau(0n)
      ).to.be.revertedWith("AV: Tau must be > 0");
    });

    it("2f) fundPools: should update RT and RF accounting", async () => {
      const { attestorVoting, oracle } = await loadFixture(
        deployFullSystemFixture
      ); // Corrected
      await attestorVoting.connect(oracle).fundPools(10000n, 5000n);
      expect(await attestorVoting.RT()).to.equal(10000n);
      expect(await attestorVoting.RF()).to.equal(5000n);
      await attestorVoting.connect(oracle).fundPools(100n, 50n);
      expect(await attestorVoting.RT()).to.equal(10100n);
      expect(await attestorVoting.RF()).to.equal(5050n);
    });

    it("2g) recordAttestorAssignment: should assign attestor to stream", async () => {
      const { attestorVoting, oracle, attestor1 } = await loadFixture(
        deployFullSystemFixture
      ); // Corrected
      await attestorVoting
        .connect(oracle)
        .recordAttestorAssignment(attestor1.address, 1);
      expect(await attestorVoting.isAssigned(attestor1.address)).to.be.true;
      expect(await attestorVoting.assignedStream(attestor1.address)).to.equal(
        1
      );
    });

    it("2h) recordAttestorAssignment: reverts if already assigned", async () => {
      const { attestorVoting, oracle, attestor1 } = await loadFixture(
        deployFullSystemFixture
      ); // Corrected
      await attestorVoting
        .connect(oracle)
        .recordAttestorAssignment(attestor1.address, 1);
      await expect(
        attestorVoting
          .connect(oracle)
          .recordAttestorAssignment(attestor1.address, 2)
      ).to.be.revertedWith("AV: Already assigned");
    });

    it("2i) recordAttestorAssignment: reverts for invalid stream", async () => {
      const { attestorVoting, oracle, attestor1 } = await loadFixture(
        deployFullSystemFixture
      ); // Corrected
      await expect(
        attestorVoting
          .connect(oracle)
          .recordAttestorAssignment(attestor1.address, NUM_STREAMS)
      ).to.be.revertedWith("AV: Invalid stream");
    });
  });

  // =================================================================
  // 3. Phase Advancement
  // =================================================================
  describe("3. Phase Advancement", function () {
    let fixture;
    beforeEach(async () => {
      fixture = await loadFixture(deployFullSystemFixture); // Corrected
    });

    it("3a) advancePhase: reverts Pending -> Commit if deadlines not set", async () => {
      const { attestorVoting, oracle } = fixture;
      await expect(
        attestorVoting.connect(oracle).advancePhase()
      ).to.be.revertedWith("AV: Deadlines not set");
    });

    it("3b) advancePhase: moves Pending -> Commit", async () => {
      const { attestorVoting, oracle, getDeadlines } = fixture;
      const { commitTime, revealTime } = await getDeadlines();
      await attestorVoting
        .connect(oracle)
        .adjustDeadline(commitTime, revealTime);
      await attestorVoting.connect(oracle).advancePhase();
      expect(await attestorVoting.phase()).to.equal(1n); // Commit
    });

    it("3c) advancePhase: reverts Commit -> Reveal if commit time not passed", async () => {
      const { attestorVoting, oracle, getDeadlines } = fixture;
      const { commitTime, revealTime } = await getDeadlines();
      await attestorVoting
        .connect(oracle)
        .adjustDeadline(commitTime, revealTime);
      await attestorVoting.connect(oracle).advancePhase(); // -> Commit
      await expect(
        attestorVoting.connect(oracle).advancePhase()
      ).to.be.revertedWith("AV: Commit open");
    });

    it("3d) advancePhase: moves Commit -> Reveal", async () => {
      const { attestorVoting, oracle, getDeadlines, advanceTime } = fixture;
      const { commitTime, revealTime } = await getDeadlines();
      await attestorVoting
        .connect(oracle)
        .adjustDeadline(commitTime, revealTime);
      await attestorVoting.connect(oracle).advancePhase(); // -> Commit
      await advanceTime(101); // Pass commit deadline
      await attestorVoting.connect(oracle).advancePhase(); // -> Reveal
      expect(await attestorVoting.phase()).to.equal(2n);
    });

    it("3e) advancePhase: reverts Reveal -> Finalized if reveal time not passed", async () => {
      const { attestorVoting, oracle, getDeadlines, advanceTime } = fixture;
      const { commitTime, revealTime } = await getDeadlines();
      await attestorVoting
        .connect(oracle)
        .adjustDeadline(commitTime, revealTime);
      await attestorVoting.connect(oracle).advancePhase(); // -> Commit
      await advanceTime(101); // Pass commit deadline
      await attestorVoting.connect(oracle).advancePhase(); // -> Reveal
      await expect(
        attestorVoting.connect(oracle).advancePhase()
      ).to.be.revertedWith("AV: Reveal open");
    });

    it("3f) advancePhase: moves Reveal -> Finalized", async () => {
      const { attestorVoting, oracle, getDeadlines, advanceTime } = fixture;
      const { commitTime, revealTime } = await getDeadlines();
      await attestorVoting
        .connect(oracle)
        .adjustDeadline(commitTime, revealTime);
      await attestorVoting.connect(oracle).advancePhase(); // -> Commit
      await advanceTime(101); // Pass commit
      await attestorVoting.connect(oracle).advancePhase(); // -> Reveal
      await advanceTime(101); // Pass reveal
      await expect(attestorVoting.connect(oracle).advancePhase())
        .to.emit(attestorVoting, "Finalized")
        .and.to.emit(attestorVoting, "PhaseAdvanced")
        .withArgs(3n);
      expect(await attestorVoting.phase()).to.equal(3n); // Finalized
    });

    it("3g) advancePhase: reverts if already Finalized", async () => {
      const { attestorVoting, oracle, getDeadlines, advanceTime } = fixture;
      const { commitTime, revealTime } = await getDeadlines();
      await attestorVoting
        .connect(oracle)
        .adjustDeadline(commitTime, revealTime);
      await attestorVoting.connect(oracle).advancePhase(); // -> Commit
      await advanceTime(101); // Pass commit
      await attestorVoting.connect(oracle).advancePhase(); // -> Reveal
      await advanceTime(101); // Pass reveal
      await attestorVoting.connect(oracle).advancePhase(); // -> Finalized
      await expect(
        attestorVoting.connect(oracle).advancePhase()
      ).to.be.revertedWith("AV: Already finalized");
    });
  });

  // =================================================================
  // 4. Commit Phase (Attestor)
  // =================================================================
  describe("4. Commit Phase (Attestor)", function () {
    let fixture;
    const stakeAmount = 500n;
    const salt = ethers.id("MY_SALT");
    const commitment = ethers.solidityPackedKeccak256(
      ["bool", "uint256"],
      [true, salt]
    );

    // Setup: Move to Commit phase
    beforeEach(async () => {
      fixture = await loadFixture(deployFullSystemFixture); // Corrected
      const { attestorVoting, oracle, attestor1, sgdCoin, getDeadlines } =
        fixture;

      // 1. Set params
      await attestorVoting.connect(oracle).setSigmaBounds(100n, 1000n);
      const { commitTime, revealTime } = await getDeadlines();
      await attestorVoting
        .connect(oracle)
        .adjustDeadline(commitTime, revealTime);
      // 2. Assign attestor
      await attestorVoting
        .connect(oracle)
        .recordAttestorAssignment(attestor1.address, 0);
      // 3. Advance to Commit
      await attestorVoting.connect(oracle).advancePhase();
      // 4. Attestor approves stake transfer
      await sgdCoin
        .connect(attestor1)
        .approve(attestorVoting.target, stakeAmount);
    });

    it("4a) commit: allows valid commit", async () => {
      const { attestorVoting, attestor1, sgdCoin } = fixture;

      const balanceBefore = await sgdCoin.balanceOf(attestor1.address);
      const contractBalanceBefore = await sgdCoin.balanceOf(
        attestorVoting.target
      );

      await expect(
        attestorVoting.connect(attestor1).commit(commitment, stakeAmount)
      )
        .to.emit(attestorVoting, "Committed")
        .withArgs(attestor1.address, 0, stakeAmount, commitment);

      expect(await attestorVoting.commitments(attestor1.address)).to.equal(
        commitment
      );
      expect(await attestorVoting.stakes(attestor1.address)).to.equal(
        stakeAmount
      );
      expect(await sgdCoin.balanceOf(attestor1.address)).to.equal(
        balanceBefore - stakeAmount
      );
      expect(await sgdCoin.balanceOf(attestorVoting.target)).to.equal(
        contractBalanceBefore + stakeAmount
      );
    });

    it("4b) commit: reverts if not in Commit phase", async () => {
      const { attestorVoting, attestor1, oracle, advanceTime } = fixture;
      await advanceTime(101);
      await attestorVoting.connect(oracle).advancePhase(); // -> Reveal
      await expect(
        attestorVoting.connect(attestor1).commit(commitment, stakeAmount)
      ).to.be.revertedWith("AV: Invalid phase");
    });

    it("4c) commit: reverts if not assigned", async () => {
      const { attestorVoting, other } = fixture;
      await expect(
        attestorVoting.connect(other).commit(commitment, stakeAmount) // Now attestor1 is defined
      ).to.be.revertedWith("AV: Not assigned");
    });

    it("4d) commit: reverts if already committed", async () => {
      const { attestorVoting, attestor1 } = fixture;
      await attestorVoting.connect(attestor1).commit(commitment, stakeAmount);
      await expect(
        attestorVoting.connect(attestor1).commit(commitment, stakeAmount)
      ).to.be.revertedWith("AV: Already committed");
    });

    it("4e) commit: reverts if stake < min", async () => {
      const { attestorVoting, attestor1 } = fixture;
      await expect(
        attestorVoting.connect(attestor1).commit(commitment, 99n)
      ).to.be.revertedWith("AV: Stake < min");
    });

    it("4f) commit: reverts if stake > max", async () => {
      const { attestorVoting, attestor1 } = fixture;
      await expect(
        attestorVoting.connect(attestor1).commit(commitment, 1001n)
      ).to.be.revertedWith("AV: Stake > max");
    });

    it("4g) commit: reverts if ineligible (not registered)", async () => {
      const { attestorVoting, oracle, other, sgdCoin } = fixture; // 'other' is not in registry

      // 1. Assign 'other' so they pass the first check
      await attestorVoting
        .connect(oracle)
        .recordAttestorAssignment(other.address, 0);

      // 2. Fund and approve
      await sgdCoin.connect(fixture.owner).mint(other.address, stakeAmount);
      await sgdCoin.connect(other).approve(attestorVoting.target, stakeAmount);

      // 3. Commit should fail on the "Not eligible" check
      await expect(
        attestorVoting.connect(other).commit(commitment, stakeAmount)
      ).to.be.revertedWith("AV: Not eligible");
    });

    it("4h) commit: reverts if transferFrom fails (no allowance)", async () => {
      const { attestorVoting, attestor2, oracle, sgdCoin } = fixture;
      // Setup attestor2 (but forget approval)
      await attestorVoting
        .connect(oracle)
        .recordAttestorAssignment(attestor2.address, 1);

      // Need to fund attestor2 first (already done in fixture)
      // await sgdCoin.connect(fixture.owner).mint(attestor2.address, stakeAmount); // Not needed

      await expect(
        attestorVoting.connect(attestor2).commit(commitment, stakeAmount)
      ).to.be.reverted; // Reverted without reason string = ERC20 insufficient allowance
    });
  });

  // =================================================================
  // 5. Reveal Phase (Attestor)
  // =================================================================
  describe("5. Reveal Phase (Attestor)", function () {
    let fixture;
    const stakeAmount = 500n;
    const salt = ethers.id("MY_SALT");
    const choice = true;
    const commitment = ethers.solidityPackedKeccak256(
      ["bool", "uint256"],
      [choice, salt]
    );

    // Setup: Move to Reveal phase with a committed attestor
    beforeEach(async () => {
      fixture = await loadFixture(deployFullSystemFixture); // Corrected
      const {
        attestorVoting,
        oracle,
        attestor1,
        sgdCoin,
        getDeadlines,
        advanceTime,
      } = fixture;

      // 1. Set params
      await attestorVoting.connect(oracle).setSigmaBounds(100n, 1000n);
      const { commitTime, revealTime } = await getDeadlines();
      await attestorVoting
        .connect(oracle)
        .adjustDeadline(commitTime, revealTime);
      // 2. Assign attestor to stream 0
      await attestorVoting
        .connect(oracle)
        .recordAttestorAssignment(attestor1.address, 0);
      // 3. Advance to Commit
      await attestorVoting.connect(oracle).advancePhase();
      // 4. Attestor approves and commits
      await sgdCoin
        .connect(attestor1)
        .approve(attestorVoting.target, stakeAmount);
      await attestorVoting.connect(attestor1).commit(commitment, stakeAmount);
      // 5. Advance to Reveal
      await advanceTime(101);
      await attestorVoting.connect(oracle).advancePhase();
    });

    it("5a) reveal: allows valid reveal for 'pass' vote", async () => {
      const { attestorVoting, attestor1 } = fixture;

      await expect(attestorVoting.connect(attestor1).reveal(choice, salt))
        .to.emit(attestorVoting, "Revealed")
        .withArgs(attestor1.address, 0, choice, stakeAmount);

      expect(await attestorVoting.revealed(attestor1.address)).to.be.true;
      expect(await attestorVoting.revealedChoice(attestor1.address)).to.equal(
        choice
      );

      const tally = await attestorVoting.tallies(0);
      expect(tally.passStake).to.equal(stakeAmount);
      expect(tally.failStake).to.equal(0n);
    });

    it("5b) reveal: reverts on invalid reveal (wrong salt)", async () => {
      const { attestorVoting, attestor1 } = fixture;
      const badSalt = ethers.id("BAD_SALT");
      await expect(
        attestorVoting.connect(attestor1).reveal(choice, badSalt)
      ).to.be.revertedWith("AV: Invalid reveal");
    });

    it("5c) reveal: reverts on invalid reveal (wrong choice)", async () => {
      const { attestorVoting, attestor1 } = fixture;
      await expect(
        attestorVoting.connect(attestor1).reveal(!choice, salt)
      ).to.be.revertedWith("AV: Invalid reveal");
    });

    it("5d) reveal: reverts if no commit exists", async () => {
      const { attestorVoting, attestor2 } = fixture; // attestor2 did not commit
      await expect(
        attestorVoting.connect(attestor2).reveal(choice, salt)
      ).to.be.revertedWith("AV: No commit");
    });

    it("5e) reveal: reverts if already revealed", async () => {
      const { attestorVoting, attestor1 } = fixture;
      await attestorVoting.connect(attestor1).reveal(choice, salt);
      await expect(
        attestorVoting.connect(attestor1).reveal(choice, salt)
      ).to.be.revertedWith("AV: Already revealed");
    });
  });
  // =================================================================
  // 6. Settlement and Claiming (Full Lifecycle)
  // =================================================================
  describe("6. Settlement and Claiming (Full Lifecycle)", function () {
    let fixture;
    const stake1 = 1000n; // Attestor 1
    const stake2 = 3000n; // Attestor 2
    const att1Salt = ethers.id("SALT_A1");
    const att2Salt = ethers.id("SALT_A2");
    const att1Choice = true; // a1 votes "Pass"
    const att2Choice = false; // a2 votes "Fail"
    const att1Commit = ethers.solidityPackedKeccak256(
      ["bool", "uint256"],
      [att1Choice, att1Salt]
    );
    const att2Commit = ethers.solidityPackedKeccak256(
      ["bool", "uint256"],
      [att2Choice, att2Salt]
    );

    const poolRT = 50000n;
    const poolRF = 20000n;
    const tau = 10n; // Divisor

    // Helper function to run the DonorVoting part
    async function runDonorVote(choice) {
      const { donorVoting, oracle, donor1, donor2, getDeadlines, advanceTime } =
        fixture;

      const { commitTime, revealTime } = await getDeadlines();
      await donorVoting.connect(oracle).adjustDeadline(commitTime, revealTime);

      // Assign donors to stream 0
      await donorVoting.connect(oracle).assignVoter(donor1.address, 0);
      await donorVoting.connect(oracle).assignVoter(donor2.address, 0);
      await donorVoting.connect(oracle).advancePhase(); // -> Commit

      // Donors commit
      const d1Salt = ethers.id("SALT_D1");
      const d2Salt = ethers.id("SALT_D2");
      // donor1 has 500 weight, donor2 has 1500 weight
      // To make it Pass (true), donor2 must vote true.
      // To make it Fail (false), donor2 must vote false.
      const d1Choice = true; // Doesn't matter
      const d2Choice = choice; // Decisive vote

      const d1Commit = ethers.solidityPackedKeccak256(
        ["bool", "uint256"],
        [d1Choice, d1Salt]
      );
      const d2Commit = ethers.solidityPackedKeccak256(
        ["bool", "uint256"],
        [d2Choice, d2Salt]
      );

      await donorVoting.connect(donor1).commit(d1Commit);
      await donorVoting.connect(donor2).commit(d2Commit);
      await advanceTime(101);
      await donorVoting.connect(oracle).advancePhase(); // -> Reveal

      // Donors reveal
      await donorVoting.connect(donor1).reveal(d1Choice, d1Salt);
      await donorVoting.connect(donor2).reveal(d2Choice, d2Salt);
      await advanceTime(101);
      await donorVoting.connect(oracle).advancePhase(); // -> Finalized

      // Check that the vote was finalized as expected
      const [decided, passed] = await donorVoting.streamResult(0);
      expect(decided).to.be.true;
      expect(passed).to.equal(choice);
    }

    // Setup: Full attestor vote (commit/reveal)
    beforeEach(async () => {
      fixture = await loadFixture(deployFullSystemFixture); // Corrected
      const {
        attestorVoting,
        oracle,
        attestor1,
        attestor2,
        sgdCoin,
        getDeadlines,
        advanceTime,
      } = fixture;

      // 1. Set AttestorVoting params
      await attestorVoting.connect(oracle).setSigmaBounds(100n, 5000n);
      const { commitTime, revealTime } = await getDeadlines();
      await attestorVoting
        .connect(oracle)
        .adjustDeadline(commitTime, revealTime);
      await attestorVoting.connect(oracle).fundPools(poolRT, poolRF);
      await attestorVoting.connect(oracle).setTau(tau);
      await attestorVoting.connect(oracle).setChallengeWindow(1000n);

      // 2. Assign attestors (both to stream 0)
      await attestorVoting
        .connect(oracle)
        .recordAttestorAssignment(attestor1.address, 0);
      await attestorVoting
        .connect(oracle)
        .recordAttestorAssignment(attestor2.address, 0);

      // 3. Advance AttestorVoting to Commit
      await attestorVoting.connect(oracle).advancePhase();

      // 4. Attestors approve and commit
      await sgdCoin.connect(attestor1).approve(attestorVoting.target, stake1);
      await sgdCoin.connect(attestor2).approve(attestorVoting.target, stake2);
      await attestorVoting.connect(attestor1).commit(att1Commit, stake1);
      await attestorVoting.connect(attestor2).commit(att2Commit, stake2);

      // 5. Advance AttestorVoting to Reveal
      await advanceTime(101);
      await attestorVoting.connect(oracle).advancePhase();

      // 6. Attestors reveal
      await attestorVoting.connect(attestor1).reveal(att1Choice, att1Salt);
      await attestorVoting.connect(attestor2).reveal(att2Choice, att2Salt);

      // 7. Advance AttestorVoting to Finalized
      await advanceTime(101);
      await attestorVoting.connect(oracle).advancePhase();
    });

    it("6a) settleStream & claim: correctly pays winner (Donors Pass)", async () => {
      const {
        attestorVoting,
        donorVoting,
        oracle,
        attestor1,
        attestor2,
        sgdCoin,
        advanceTime,
      } = fixture;

      // 1. Run Donor Vote to PASS (true)
      await runDonorVote(true);

      // 2. Settle Attestor Vote
      await attestorVoting.connect(oracle).settleStream(0, donorVoting.target);
      const settlement = await attestorVoting.settlements(0);

      // a1 (Pass) is winner, a2 (Fail) is loser
      expect(settlement.winnersStake).to.equal(stake1); // 1000
      expect(settlement.losersStake).to.equal(stake2); // 3000

      // 3. Calculate expected rewards
      // poolSlice = RT / tau = 50000 / 10 = 5000
      const poolSlice = poolRT / tau;
      // totalReward = poolSlice + losersStake = 5000 + 3000 = 8000
      const totalReward = poolSlice + stake2;
      // rewardPerStakeRay = (totalReward * RAY) / winnersStake = (8000 * 1e27) / 1000 = 8 * 1e27
      const expectedRay = (totalReward * RAY) / stake1;
      expect(settlement.rewardPerStakeRay).to.equal(expectedRay);

      // 4. Advance past challenge window
      await advanceTime(1001);

      // 5. Test Winner Claim (attestor1)
      const a1_reward = (stake1 * expectedRay) / RAY;
      const a1_expectedPayout = stake1 + a1_reward; // 1000 + 8000 = 9000
      const a1_balBefore = await sgdCoin.balanceOf(attestor1.address);
      await attestorVoting.connect(attestor1).claim();
      const a1_balAfter = await sgdCoin.balanceOf(attestor1.address);
      expect(a1_balAfter - a1_balBefore).to.equal(a1_expectedPayout);

      // 6. Test Loser Claim (attestor2)
      const a2_expectedPayout = 0n; // Slashed
      const a2_balBefore = await sgdCoin.balanceOf(attestor2.address);
      await attestorVoting.connect(attestor2).claim();
      const a2_balAfter = await sgdCoin.balanceOf(attestor2.address);
      expect(a2_balAfter - a2_balBefore).to.equal(a2_expectedPayout);
    });

    it("6b) settleStream & claim: correctly pays winner (Donors Fail)", async () => {
      const {
        attestorVoting,
        donorVoting,
        oracle,
        attestor1,
        attestor2,
        sgdCoin,
        advanceTime,
      } = fixture;

      // 1. Run Donor Vote to FAIL (false)
      await runDonorVote(false);

      // 2. Settle Attestor Vote
      await attestorVoting.connect(oracle).settleStream(0, donorVoting.target);
      const settlement = await attestorVoting.settlements(0);

      // a2 (Fail) is winner, a1 (Pass) is loser
      expect(settlement.winnersStake).to.equal(stake2); // 3000
      expect(settlement.losersStake).to.equal(stake1); // 1000

      // 3. Calculate expected rewards
      // poolSlice = RF / tau = 20000 / 10 = 2000
      const poolSlice = poolRF / tau;
      // totalReward = poolSlice + losersStake = 2000 + 1000 = 3000
      const totalReward = poolSlice + stake1;
      // rewardPerStakeRay = (totalReward * RAY) / winnersStake = (3000 * 1e27) / 3000 = 1 * 1e27
      const expectedRay = (totalReward * RAY) / stake2;
      expect(settlement.rewardPerStakeRay).to.equal(expectedRay);

      // 4. Advance past challenge window
      await advanceTime(1001);

      // 5. Test Loser Claim (attestor1)
      const a1_expectedPayout = 0n; // Slashed
      const a1_balBefore = await sgdCoin.balanceOf(attestor1.address);
      await attestorVoting.connect(attestor1).claim();
      const a1_balAfter = await sgdCoin.balanceOf(attestor1.address);
      expect(a1_balAfter - a1_balBefore).to.equal(a1_expectedPayout);

      // 6. Test Winner Claim (attestor2)
      const a2_reward = (stake2 * expectedRay) / RAY;
      const a2_expectedPayout = stake2 + a2_reward; // 3000 + 3000 = 6000
      const a2_balBefore = await sgdCoin.balanceOf(attestor2.address);
      await attestorVoting.connect(attestor2).claim();
      const a2_balAfter = await sgdCoin.balanceOf(attestor2.address);
      expect(a2_balAfter - a2_balBefore).to.equal(a2_expectedPayout);
    });

    it("6c) claim: reverts if challenge window is active", async () => {
      const { attestorVoting, donorVoting, oracle, attestor1 } = fixture;
      await runDonorVote(true); // Run vote to PASS
      await attestorVoting.connect(oracle).settleStream(0, donorVoting.target);

      // Challenge window is 1000s
      await expect(
        attestorVoting.connect(attestor1).claim()
      ).to.be.revertedWith("AV: Challenge window active");
    });
  });
});
