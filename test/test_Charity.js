/* eslint-disable no-undef */
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");

describe("Charity contracts integration", function () {
  const QUORUM_BPS = 7000n;
  const PASS_MAJORITY_BPS = 7000n;

  // Comprehensive fixture that sets up all contracts
  async function deployCharityFixture() {
    const [
      deployer,
      oracle,
      pauser,
      charityOwner,
      charityOwner2,
      beneficiary,
      user1,
      user2,
    ] = await ethers.getSigners();

    // Governance
    const Governance = await ethers.getContractFactory("Governance");
    const governance = await Governance.deploy(
      await oracle.getAddress(),
      await pauser.getAddress(),
      QUORUM_BPS,
      PASS_MAJORITY_BPS
    );
    await governance.waitForDeployment();

    // SGD token
    const SGDCoin = await ethers.getContractFactory("SGDCoin");
    const sgd = await SGDCoin.deploy();
    await sgd.waitForDeployment();

    // Core contracts
    const CharityRegistry = await ethers.getContractFactory("CharityRegistry");
    const registry = await CharityRegistry.deploy(await governance.getAddress());
    await registry.waitForDeployment();

    const CharityReputation = await ethers.getContractFactory("CharityReputation");
    const reputation = await CharityReputation.deploy(await governance.getAddress());
    await reputation.waitForDeployment();

    const CharityTreasury = await ethers.getContractFactory("CharityTreasury");
    const treasury = await CharityTreasury.deploy(
      await sgd.getAddress(),
      await governance.getAddress()
    );
    await treasury.waitForDeployment();

    // Helper function for time manipulation
    const advanceTime = async (seconds) => {
      await time.increase(seconds);
    };

    // Helper to create an event
    const createEvent = async (owner, orgId, goal, deadlineOffset) => {
      const CharityEvent = await ethers.getContractFactory("CharityEvent");
      const evId = ethers.keccak256(
        ethers.toUtf8Bytes(`event-${orgId}-${Date.now()}`)
      );
      const deadline = (await time.latest()) + deadlineOffset;
      const eventCtr = await CharityEvent.connect(owner).deploy(
        await governance.getAddress(),
        await registry.getAddress(),
        evId,
        orgId,
        await beneficiary.getAddress(),
        goal,
        deadline,
        `Event ${orgId}`
      );
      await eventCtr.waitForDeployment();
      return eventCtr;
    };

    return {
      governance,
      sgd,
      registry,
      reputation,
      treasury,
      deployer,
      oracle,
      pauser,
      charityOwner,
      charityOwner2,
      beneficiary,
      user1,
      user2,
      advanceTime,
      createEvent,
    };
  }

  // =================================================================
  // 1. CharityRegistry Tests
  // =================================================================
  describe("1. CharityRegistry", function () {
    it("1a) should register charity with valid inputs and emit event", async () => {
      const { registry, charityOwner } = await loadFixture(deployCharityFixture);
      
      await expect(
        registry.connect(charityOwner).registerCharity("Charity A", "QmMeta")
      )
        .to.emit(registry, "CharityRegistered")
        .withArgs(1n, "Charity A", await charityOwner.getAddress());

      const orgId = await registry.addressToOrgId(await charityOwner.getAddress());
      expect(orgId).to.equal(1n);
      
      const profile = await registry.profiles(orgId);
      expect(profile.name).to.equal("Charity A");
      expect(profile.metaCID).to.equal("QmMeta");
      expect(profile.approved).to.equal(false);
      expect(profile.registrant).to.equal(await charityOwner.getAddress());
    });

    it("1b) should reject empty name or metaCID", async () => {
      const { registry, charityOwner } = await loadFixture(deployCharityFixture);
      
      await expect(
        registry.connect(charityOwner).registerCharity("", "QmMeta")
      ).to.be.revertedWith("Name cannot be empty");
      
      await expect(
        registry.connect(charityOwner).registerCharity("Charity A", "")
      ).to.be.revertedWith("MetaCID cannot be empty");
    });

    it("1c) should prevent duplicate registration", async () => {
      const { registry, charityOwner } = await loadFixture(deployCharityFixture);
      
      await registry.connect(charityOwner).registerCharity("Charity A", "QmMeta");
      
      await expect(
        registry.connect(charityOwner).registerCharity("Charity B", "QmMeta2")
      ).to.be.revertedWith("Address already registered");
    });

    it("1d) should allow multiple charities with different owners", async () => {
      const { registry, charityOwner, charityOwner2 } = await loadFixture(deployCharityFixture);
      
      await registry.connect(charityOwner).registerCharity("Charity A", "QmMeta1");
      await registry.connect(charityOwner2).registerCharity("Charity B", "QmMeta2");
      
      const orgId1 = await registry.addressToOrgId(await charityOwner.getAddress());
      const orgId2 = await registry.addressToOrgId(await charityOwner2.getAddress());
      
      expect(orgId1).to.equal(1n);
      expect(orgId2).to.equal(2n);
      
      const [registered] = await registry.getStats();
      expect(registered).to.equal(2n);
    });

    it("1e) should enforce onlyAdmin for setApproval", async () => {
      const { registry, charityOwner, deployer, user1 } = await loadFixture(deployCharityFixture);
      
      await registry.connect(charityOwner).registerCharity("Charity A", "QmMeta");
      const orgId = await registry.addressToOrgId(await charityOwner.getAddress());
      
      await expect(
        registry.connect(user1).setApproval(orgId, true)
      ).to.be.revertedWith("Registry: Caller is not admin");
      
      await registry.connect(deployer).setApproval(orgId, true);
      const profile = await registry.profiles(orgId);
      expect(profile.approved).to.equal(true);
    });

    it("1f) should update approval counts correctly", async () => {
      const { registry, charityOwner, charityOwner2, deployer } = await loadFixture(deployCharityFixture);
      
      await registry.connect(charityOwner).registerCharity("Charity A", "QmMeta1");
      await registry.connect(charityOwner2).registerCharity("Charity B", "QmMeta2");
      
      let [, approvedCount] = await registry.getStats();
      expect(approvedCount).to.equal(0n);
      
      const orgId1 = await registry.addressToOrgId(await charityOwner.getAddress());
      await registry.connect(deployer).setApproval(orgId1, true);
      
      [, approvedCount] = await registry.getStats();
      expect(approvedCount).to.equal(1n);
      
      await registry.connect(deployer).setApproval(orgId1, false);
      [, approvedCount] = await registry.getStats();
      expect(approvedCount).to.equal(0n);
    });

    it("1g) should enforce onlyAdmin for setTreasury", async () => {
      const { registry, treasury, charityOwner, deployer, user1 } = await loadFixture(deployCharityFixture);
      
      await registry.connect(charityOwner).registerCharity("Charity A", "QmMeta");
      const orgId = await registry.addressToOrgId(await charityOwner.getAddress());
      
      await expect(
        registry.connect(user1).setTreasury(orgId, await treasury.getAddress())
      ).to.be.revertedWith("Registry: Caller is not admin");
      
      await expect(
        registry.connect(deployer).setTreasury(orgId, ethers.ZeroAddress)
      ).to.be.revertedWith("Invalid treasury address");
      
      await registry.connect(deployer).setTreasury(orgId, await treasury.getAddress());
      const profile = await registry.profiles(orgId);
      expect(profile.treasury).to.equal(await treasury.getAddress());
    });

    it("1h) should allow owner to update profile metadata", async () => {
      const { registry, charityOwner, deployer } = await loadFixture(deployCharityFixture);
      
      await registry.connect(charityOwner).registerCharity("Charity A", "QmMeta1");
      const orgId = await registry.addressToOrgId(await charityOwner.getAddress());
      
      await expect(
        registry.connect(charityOwner).updateProfile(orgId, "")
      ).to.be.revertedWith("MetaCID cannot be empty");
      
      await registry.connect(charityOwner).updateProfile(orgId, "QmMeta2");
      const profile = await registry.profiles(orgId);
      expect(profile.metaCID).to.equal("QmMeta2");
      
      // Admin can also update
      await registry.connect(deployer).updateProfile(orgId, "QmMeta3");
      const profile2 = await registry.profiles(orgId);
      expect(profile2.metaCID).to.equal("QmMeta3");
    });

    it("1i) should reject unauthorized profile updates", async () => {
      const { registry, charityOwner, charityOwner2, user1 } = await loadFixture(deployCharityFixture);
      
      await registry.connect(charityOwner).registerCharity("Charity A", "QmMeta1");
      const orgId = await registry.addressToOrgId(await charityOwner.getAddress());
      
      await expect(
        registry.connect(charityOwner2).updateProfile(orgId, "QmMeta2")
      ).to.be.revertedWith("Not authorized");
      
      await expect(
        registry.connect(user1).updateProfile(orgId, "QmMeta2")
      ).to.be.revertedWith("Not authorized");
    });

    it("1j) should handle pause/unpause correctly", async () => {
      const { registry, governance, charityOwner, pauser, deployer } = await loadFixture(deployCharityFixture);
      
      await registry.connect(charityOwner).registerCharity("Charity A", "QmMeta");
      const orgId = await registry.addressToOrgId(await charityOwner.getAddress());
      
      // Pause system
      await governance.connect(pauser).pause();
      
      await expect(
        registry.connect(charityOwner).registerCharity("Charity B", "QmMeta2")
      ).to.be.revertedWith("Registry: System is paused");
      
      await expect(
        registry.connect(charityOwner).updateProfile(orgId, "QmNew")
      ).to.be.revertedWith("Registry: System is paused");
      
      await expect(
        registry.connect(deployer).setApproval(orgId, true)
      ).to.be.revertedWith("Registry: System is paused");
      
      // Unpause
      await governance.connect(deployer).unpause();
      
      await registry.connect(charityOwner).updateProfile(orgId, "QmNew");
      const profile = await registry.profiles(orgId);
      expect(profile.metaCID).to.equal("QmNew");
    });

    it("1k) should reject operations on non-existent charity", async () => {
      const { registry, treasury, deployer } = await loadFixture(deployCharityFixture);
      
      await expect(
        registry.connect(deployer).setApproval(999n, true)
      ).to.be.revertedWith("Charity not found");
      
      await expect(
        registry.connect(deployer).setTreasury(999n, await treasury.getAddress())
      ).to.be.revertedWith("Charity not found");
      
      await expect(
        registry.getProfile(999n)
      ).to.be.revertedWith("Charity not found");
    });
  });

  // =================================================================
  // 2. CharityReputation Tests
  // =================================================================
  describe("2. CharityReputation", function () {
    it("2a) should initialize reputation with default score", async () => {
      const { registry, reputation, charityOwner, deployer } = await loadFixture(deployCharityFixture);
      
      await registry.connect(charityOwner).registerCharity("Charity A", "QmMeta");
      const orgId = await registry.addressToOrgId(await charityOwner.getAddress());
      
      await reputation.connect(deployer).initializeReputation(orgId);
      
      expect(await reputation.scoreOf(orgId)).to.equal(500n);
      
      const data = await reputation.getReputationData(orgId);
      expect(data.score).to.equal(500n);
      expect(data.totalEvents).to.equal(0n);
      expect(data.successfulEvents).to.equal(0n);
      expect(data.failedEvents).to.equal(0n);
    });

    it("2b) should reject duplicate initialization", async () => {
      const { registry, reputation, charityOwner, deployer } = await loadFixture(deployCharityFixture);
      
      await registry.connect(charityOwner).registerCharity("Charity A", "QmMeta");
      const orgId = await registry.addressToOrgId(await charityOwner.getAddress());
      
      await reputation.connect(deployer).initializeReputation(orgId);
      
      await expect(
        reputation.connect(deployer).initializeReputation(orgId)
      ).to.be.revertedWith("Reputation already initialized");
    });

    it("2c) should enforce onlyAdmin for initialization", async () => {
      const { registry, reputation, charityOwner, user1 } = await loadFixture(deployCharityFixture);
      
      await registry.connect(charityOwner).registerCharity("Charity A", "QmMeta");
      const orgId = await registry.addressToOrgId(await charityOwner.getAddress());
      
      await expect(
        reputation.connect(user1).initializeReputation(orgId)
      ).to.be.revertedWith("Not admin");
    });

    it("2d) should reject operations on non-initialized org", async () => {
      const { registry, reputation, charityOwner, oracle } = await loadFixture(deployCharityFixture);
      
      await registry.connect(charityOwner).registerCharity("Charity A", "QmMeta");
      const orgId = await registry.addressToOrgId(await charityOwner.getAddress());
      
      await expect(
        reputation.connect(oracle).updateOnEventOutcome(orgId, 1n, true)
      ).to.be.revertedWith("Reputation not initialized");
      
      await expect(
        reputation.connect(oracle).recordVote(orgId, true)
      ).to.be.revertedWith("Reputation not initialized");
    });

    it("2e) should update score on successful event outcome", async () => {
      const { registry, reputation, charityOwner, deployer, oracle } = await loadFixture(deployCharityFixture);
      
      await registry.connect(charityOwner).registerCharity("Charity A", "QmMeta");
      const orgId = await registry.addressToOrgId(await charityOwner.getAddress());
      await reputation.connect(deployer).initializeReputation(orgId);
      
      await reputation.connect(oracle).updateOnEventOutcome(orgId, 1n, true);
      
      expect(await reputation.scoreOf(orgId)).to.equal(510n);
      const data = await reputation.getReputationData(orgId);
      expect(data.totalEvents).to.equal(1n);
      expect(data.successfulEvents).to.equal(1n);
      expect(data.failedEvents).to.equal(0n);
    });

    it("2f) should decrease score on failed event outcome", async () => {
      const { registry, reputation, charityOwner, deployer, oracle } = await loadFixture(deployCharityFixture);
      
      await registry.connect(charityOwner).registerCharity("Charity A", "QmMeta");
      const orgId = await registry.addressToOrgId(await charityOwner.getAddress());
      await reputation.connect(deployer).initializeReputation(orgId);
      
      await reputation.connect(oracle).updateOnEventOutcome(orgId, 1n, false);
      
      expect(await reputation.scoreOf(orgId)).to.equal(480n);
      const data = await reputation.getReputationData(orgId);
      expect(data.totalEvents).to.equal(1n);
      expect(data.successfulEvents).to.equal(0n);
      expect(data.failedEvents).to.equal(1n);
    });

    it("2g) should prevent duplicate event outcome recording", async () => {
      const { registry, reputation, charityOwner, deployer, oracle } = await loadFixture(deployCharityFixture);
      
      await registry.connect(charityOwner).registerCharity("Charity A", "QmMeta");
      const orgId = await registry.addressToOrgId(await charityOwner.getAddress());
      await reputation.connect(deployer).initializeReputation(orgId);
      
      await reputation.connect(oracle).updateOnEventOutcome(orgId, 99n, true);
      
      await expect(
        reputation.connect(oracle).updateOnEventOutcome(orgId, 99n, false)
      ).to.be.revertedWith("Event already recorded");
    });

    it("2h) should enforce onlyOracle for outcome updates", async () => {
      const { registry, reputation, charityOwner, deployer, user1 } = await loadFixture(deployCharityFixture);
      
      await registry.connect(charityOwner).registerCharity("Charity A", "QmMeta");
      const orgId = await registry.addressToOrgId(await charityOwner.getAddress());
      await reputation.connect(deployer).initializeReputation(orgId);
      
      await expect(
        reputation.connect(user1).updateOnEventOutcome(orgId, 1n, true)
      ).to.be.revertedWith("Not oracle");
    });

    it("2i) should cap score at MAX_SCORE", async () => {
      const { registry, reputation, charityOwner, deployer, oracle } = await loadFixture(deployCharityFixture);
      
      await registry.connect(charityOwner).registerCharity("Charity A", "QmMeta");
      const orgId = await registry.addressToOrgId(await charityOwner.getAddress());
      await reputation.connect(deployer).initializeReputation(orgId);
      
      // Add many successful events to push toward max
      for (let i = 1; i <= 60; i++) {
        await reputation.connect(oracle).updateOnEventOutcome(orgId, BigInt(i), true);
      }
      
      const score = await reputation.scoreOf(orgId);
      expect(score).to.equal(1000n); // MAX_SCORE
      
      // One more shouldn't exceed max
      await reputation.connect(oracle).updateOnEventOutcome(orgId, 61n, true);
      expect(await reputation.scoreOf(orgId)).to.equal(1000n);
    });

    it("2j) should cap score at MIN_SCORE", async () => {
      const { registry, reputation, charityOwner, deployer, oracle } = await loadFixture(deployCharityFixture);
      
      await registry.connect(charityOwner).registerCharity("Charity A", "QmMeta");
      const orgId = await registry.addressToOrgId(await charityOwner.getAddress());
      await reputation.connect(deployer).initializeReputation(orgId);
      
      // Add many failed events to push toward min
      for (let i = 1; i <= 30; i++) {
        await reputation.connect(oracle).updateOnEventOutcome(orgId, BigInt(i), false);
      }
      
      const score = await reputation.scoreOf(orgId);
      expect(score).to.equal(0n); // MIN_SCORE
      
      // One more shouldn't go below min
      await reputation.connect(oracle).updateOnEventOutcome(orgId, 31n, false);
      expect(await reputation.scoreOf(orgId)).to.equal(0n);
    });

    it("2k) should record votes and adjust score based on ratio", async () => {
      const { registry, reputation, charityOwner, deployer, oracle } = await loadFixture(deployCharityFixture);
      
      await registry.connect(charityOwner).registerCharity("Charity A", "QmMeta");
      const orgId = await registry.addressToOrgId(await charityOwner.getAddress());
      await reputation.connect(deployer).initializeReputation(orgId);
      
      // Add 8 positive votes out of 10 total (80%+ ratio)
      for (let i = 0; i < 8; i++) {
        await reputation.connect(oracle).recordVote(orgId, true);
      }
      for (let i = 0; i < 2; i++) {
        await reputation.connect(oracle).recordVote(orgId, false);
      }
      
      const data = await reputation.getReputationData(orgId);
      expect(data.positiveVotes).to.equal(8n);
      expect(data.negativeVotes).to.equal(2n);
      
      // Should have increased score due to high positive ratio
      const score = await reputation.scoreOf(orgId);
      expect(score).to.be.greaterThan(500n);
    });

    it("2l) should update on finalize correctly", async () => {
      const { registry, reputation, charityOwner, deployer, oracle } = await loadFixture(deployCharityFixture);
      
      await registry.connect(charityOwner).registerCharity("Charity A", "QmMeta");
      const orgId = await registry.addressToOrgId(await charityOwner.getAddress());
      await reputation.connect(deployer).initializeReputation(orgId);
      
      const initialScore = await reputation.scoreOf(orgId);
      
      await reputation.connect(oracle).updateOnFinalize(orgId, true);
      expect(await reputation.scoreOf(orgId)).to.equal(initialScore + 15n);
      
      // Reset and test false
      await reputation.connect(deployer).initializeReputation(orgId + 100n);
      await reputation.connect(oracle).updateOnFinalize(orgId + 100n, false);
      expect(await reputation.scoreOf(orgId + 100n)).to.equal(500n - 25n);
    });

    it("2m) should return correct reputation tier", async () => {
      const { registry, reputation, charityOwner, charityOwner2, deployer, oracle } = await loadFixture(deployCharityFixture);
      
      await registry.connect(charityOwner).registerCharity("Charity A", "QmMeta");
      const orgId = await registry.addressToOrgId(await charityOwner.getAddress());
      await reputation.connect(deployer).initializeReputation(orgId);
      
      // Test tier 1 (poor)
      for (let i = 1; i <= 26; i++) {
        await reputation.connect(oracle).updateOnEventOutcome(orgId, BigInt(i), false);
      }
      expect(await reputation.getReputationTier(orgId)).to.equal(1n);
      
      // Test tier 5 (excellent) - use different charity owner
      await registry.connect(charityOwner2).registerCharity("Charity B", "QmMeta2");
      const orgId2 = await registry.addressToOrgId(await charityOwner2.getAddress());
      await reputation.connect(deployer).initializeReputation(orgId2);
      for (let i = 1; i <= 50; i++) {
        await reputation.connect(oracle).updateOnEventOutcome(orgId2, BigInt(i), true);
      }
      expect(await reputation.getReputationTier(orgId2)).to.equal(5n);
    });

    it("2n) should calculate success rate correctly", async () => {
      const { registry, reputation, charityOwner, deployer, oracle } = await loadFixture(deployCharityFixture);
      
      await registry.connect(charityOwner).registerCharity("Charity A", "QmMeta");
      const orgId = await registry.addressToOrgId(await charityOwner.getAddress());
      await reputation.connect(deployer).initializeReputation(orgId);
      
      // 7 successes, 3 failures = 70% success rate
      for (let i = 1; i <= 7; i++) {
        await reputation.connect(oracle).updateOnEventOutcome(orgId, BigInt(i), true);
      }
      for (let i = 8; i <= 10; i++) {
        await reputation.connect(oracle).updateOnEventOutcome(orgId, BigInt(i), false);
      }
      
      expect(await reputation.getSuccessRate(orgId)).to.equal(70n);
    });

    it("2o) should handle zero votes correctly", async () => {
      const { registry, reputation, charityOwner, deployer } = await loadFixture(deployCharityFixture);
      
      await registry.connect(charityOwner).registerCharity("Charity A", "QmMeta");
      const orgId = await registry.addressToOrgId(await charityOwner.getAddress());
      await reputation.connect(deployer).initializeReputation(orgId);
      
      expect(await reputation.getVoteRatio(orgId)).to.equal(0n);
      expect(await reputation.getSuccessRate(orgId)).to.equal(0n);
    });
  });

  // =================================================================
  // 3. CharityTreasury Tests
  // =================================================================
  describe("3. CharityTreasury", function () {
    async function setupTreasuryFixture() {
      const fixture = await loadFixture(deployCharityFixture);
      const { registry, treasury, charityOwner, deployer } = fixture;
      
      await registry.connect(charityOwner).registerCharity("Charity A", "QmMeta");
      const orgId = await registry.addressToOrgId(await charityOwner.getAddress());
      await registry.connect(deployer).setApproval(orgId, true);
      await registry.connect(deployer).setTreasury(orgId, await treasury.getAddress());
      await treasury.connect(deployer).createTreasury(orgId, await charityOwner.getAddress());
      
      return { ...fixture, orgId };
    }

    it("3a) should create treasury with correct initial state", async () => {
      const { treasury, charityOwner, deployer } = await loadFixture(deployCharityFixture);
      
      await expect(
        treasury.connect(deployer).createTreasury(1n, await charityOwner.getAddress())
      )
        .to.emit(treasury, "TreasuryCreated")
        .withArgs(1n, await charityOwner.getAddress());
      
      const data = await treasury.treasuries(1n);
      expect(data.orgId).to.equal(1n);
      expect(data.totalBalance).to.equal(0n);
      expect(data.availableBalance).to.equal(0n);
      expect(data.lockedBalance).to.equal(0n);
      expect(data.owner).to.equal(await charityOwner.getAddress());
      expect(data.active).to.equal(true);
    });

    it("3b) should reject invalid treasury creation", async () => {
      const { treasury, deployer, charityOwner } = await loadFixture(deployCharityFixture);
      
      await expect(
        treasury.connect(deployer).createTreasury(0n, await charityOwner.getAddress())
      ).to.be.revertedWith("Invalid org ID");
      
      await expect(
        treasury.connect(deployer).createTreasury(1n, ethers.ZeroAddress)
      ).to.be.revertedWith("Invalid owner address");
      
      await treasury.connect(deployer).createTreasury(1n, await charityOwner.getAddress());
      
      await expect(
        treasury.connect(deployer).createTreasury(1n, await charityOwner.getAddress())
      ).to.be.revertedWith("Treasury already exists");
    });

    it("3c) should enforce onlyAdmin for treasury creation", async () => {
      const { treasury, charityOwner, user1 } = await loadFixture(deployCharityFixture);
      
      await expect(
        treasury.connect(user1).createTreasury(1n, await charityOwner.getAddress())
      ).to.be.revertedWith("Not admin");
    });

    it("3d) should receive release from oracle and update balances", async () => {
      const { treasury, sgd, oracle, deployer, orgId } = await loadFixture(setupTreasuryFixture);
      
      await sgd.connect(deployer).mint(await oracle.getAddress(), ethers.parseEther("100"));
      await sgd.connect(oracle).approve(await treasury.getAddress(), ethers.parseEther("100"));
      
      await expect(
        treasury.connect(oracle).receiveRelease(orgId, 1n, ethers.parseEther("100"))
      )
        .to.emit(treasury, "FundsReceived")
        .withArgs(orgId, ethers.parseEther("100"), 1n);
      
      const [total, available, locked] = await treasury.balanceOf(orgId);
      expect(total).to.equal(ethers.parseEther("100"));
      expect(available).to.equal(ethers.parseEther("100"));
      expect(locked).to.equal(0n);
    });

    it("3e) should reject receiveRelease from non-oracle", async () => {
      const { treasury, user1, orgId } = await loadFixture(setupTreasuryFixture);
      
      await expect(
        treasury.connect(user1).receiveRelease(orgId, 1n, 100n)
      ).to.be.revertedWith("Not oracle");
    });

    it("3f) should reject receiveRelease with invalid inputs", async () => {
      const { treasury, sgd, oracle, deployer, orgId } = await loadFixture(setupTreasuryFixture);
      
      await sgd.connect(deployer).mint(await oracle.getAddress(), 1000n);
      await sgd.connect(oracle).approve(await treasury.getAddress(), 1000n);
      
      await expect(
        treasury.connect(oracle).receiveRelease(orgId, 1n, 0n)
      ).to.be.revertedWith("Amount must be positive");
      
      await treasury.connect(oracle).receiveRelease(orgId, 1n, 500n);
      
      await expect(
        treasury.connect(oracle).receiveRelease(orgId, 1n, 100n)
      ).to.be.revertedWith("Event already released");
    });

    it("3g) should reject receiveRelease on inactive treasury", async () => {
      const { treasury, sgd, oracle, deployer, orgId } = await loadFixture(setupTreasuryFixture);
      
      await treasury.connect(deployer).deactivateTreasury(orgId);
      
      await sgd.connect(deployer).mint(await oracle.getAddress(), 1000n);
      await sgd.connect(oracle).approve(await treasury.getAddress(), 1000n);
      
      await expect(
        treasury.connect(oracle).receiveRelease(orgId, 2n, 100n)
      ).to.be.revertedWith("Treasury not active");
    });

    it("3h) should allow owner to withdraw funds", async () => {
      const { treasury, sgd, oracle, deployer, charityOwner, beneficiary, orgId } = await loadFixture(setupTreasuryFixture);
      
      await sgd.connect(deployer).mint(await oracle.getAddress(), ethers.parseEther("100"));
      await sgd.connect(oracle).approve(await treasury.getAddress(), ethers.parseEther("100"));
      await treasury.connect(oracle).receiveRelease(orgId, 1n, ethers.parseEther("100"));
      
      await expect(
        treasury.connect(charityOwner).withdraw(await beneficiary.getAddress(), ethers.parseEther("30"))
      )
        .to.emit(treasury, "FundsWithdrawn")
        .withArgs(orgId, await beneficiary.getAddress(), ethers.parseEther("30"));
      
      const [total, available] = await treasury.balanceOf(orgId);
      expect(total).to.equal(ethers.parseEther("70"));
      expect(available).to.equal(ethers.parseEther("70"));
      expect(await sgd.balanceOf(await beneficiary.getAddress())).to.equal(ethers.parseEther("30"));
    });

    it("3i) should reject withdrawal with invalid inputs", async () => {
      const { treasury, sgd, oracle, deployer, charityOwner, beneficiary, orgId } = await loadFixture(setupTreasuryFixture);
      
      await sgd.connect(deployer).mint(await oracle.getAddress(), ethers.parseEther("100"));
      await sgd.connect(oracle).approve(await treasury.getAddress(), ethers.parseEther("100"));
      await treasury.connect(oracle).receiveRelease(orgId, 1n, ethers.parseEther("100"));
      
      await expect(
        treasury.connect(charityOwner).withdraw(ethers.ZeroAddress, ethers.parseEther("10"))
      ).to.be.revertedWith("Invalid recipient address");
      
      await expect(
        treasury.connect(charityOwner).withdraw(await beneficiary.getAddress(), 0n)
      ).to.be.revertedWith("Amount must be positive");
      
      await expect(
        treasury.connect(charityOwner).withdraw(await beneficiary.getAddress(), ethers.parseEther("200"))
      ).to.be.revertedWith("Insufficient available balance");
    });

    it("3j) should reject withdrawal from non-owner", async () => {
      const { treasury, sgd, oracle, deployer, user1, beneficiary, orgId } = await loadFixture(setupTreasuryFixture);
      
      await sgd.connect(deployer).mint(await oracle.getAddress(), ethers.parseEther("100"));
      await sgd.connect(oracle).approve(await treasury.getAddress(), ethers.parseEther("100"));
      await treasury.connect(oracle).receiveRelease(orgId, 1n, ethers.parseEther("100"));
      
      await expect(
        treasury.connect(user1).withdraw(await beneficiary.getAddress(), ethers.parseEther("10"))
      ).to.be.revertedWith("Treasury not found");
    });

    it("3k) should handle requestDisbursement correctly", async () => {
      const { treasury, sgd, oracle, deployer, charityOwner, orgId } = await loadFixture(setupTreasuryFixture);
      
      await sgd.connect(deployer).mint(await oracle.getAddress(), ethers.parseEther("100"));
      await sgd.connect(oracle).approve(await treasury.getAddress(), ethers.parseEther("100"));
      await treasury.connect(oracle).receiveRelease(orgId, 1n, ethers.parseEther("100"));
      
      await expect(
        treasury.connect(charityOwner).requestDisbursement(99n, ethers.parseEther("50"))
      )
        .to.emit(treasury, "DisbursementRequested")
        .withArgs(orgId, 99n, ethers.parseEther("50"));
      
      const [, available, locked] = await treasury.balanceOf(orgId);
      expect(available).to.equal(ethers.parseEther("50"));
      expect(locked).to.equal(ethers.parseEther("50"));
    });

    it("3l) should handle releaseEventFunds correctly", async () => {
      const { treasury, sgd, oracle, deployer, charityOwner, orgId } = await loadFixture(setupTreasuryFixture);
      
      await sgd.connect(deployer).mint(await oracle.getAddress(), ethers.parseEther("100"));
      await sgd.connect(oracle).approve(await treasury.getAddress(), ethers.parseEther("100"));
      await treasury.connect(oracle).receiveRelease(orgId, 1n, ethers.parseEther("100"));
      await treasury.connect(charityOwner).requestDisbursement(1n, ethers.parseEther("100"));
      
      await treasury.connect(oracle).releaseEventFunds(orgId, 1n, true);
      
      const [, available, locked] = await treasury.balanceOf(orgId);
      expect(available).to.equal(ethers.parseEther("100"));
      expect(locked).to.equal(0n);
    });

    it("3m) should deactivate treasury correctly", async () => {
      const { treasury, deployer, orgId } = await loadFixture(setupTreasuryFixture);
      
      await expect(
        treasury.connect(deployer).deactivateTreasury(orgId)
      )
        .to.emit(treasury, "TreasuryDeactivated")
        .withArgs(orgId);
      
      const data = await treasury.treasuries(orgId);
      expect(data.active).to.equal(false);
    });
  });

  // =================================================================
  // 4. CharityEvent Tests
  // =================================================================
  describe("4. CharityEvent", function () {
    async function setupEventFixture() {
      const fixture = await loadFixture(deployCharityFixture);
      const { registry, createEvent, charityOwner } = fixture;
      
      await registry.connect(charityOwner).registerCharity("Charity A", "QmMeta");
      const orgId = await registry.addressToOrgId(await charityOwner.getAddress());
      const eventCtr = await createEvent(charityOwner, orgId, ethers.parseEther("100"), 3600);
      
      return { ...fixture, orgId, eventCtr };
    }

    it("4a) should deploy event with correct initial state", async () => {
      const { createEvent, registry, charityOwner, beneficiary } = await loadFixture(deployCharityFixture);
      
      await registry.connect(charityOwner).registerCharity("Charity A", "QmMeta");
      const orgId = await registry.addressToOrgId(await charityOwner.getAddress());
      const eventCtr = await createEvent(charityOwner, orgId, ethers.parseEther("100"), 3600);
      
      const summary = await eventCtr.getEventSummary();
      expect(summary[2]).to.equal(0n); // FUNDING phase
      expect(summary[3]).to.equal(ethers.parseEther("100")); // goal
      expect(summary[4]).to.equal(0n); // raised
      expect(summary[5]).to.equal(await beneficiary.getAddress());
    });

    it("4b) should reject invalid event creation", async () => {
      const { registry, governance, charityOwner } = await loadFixture(deployCharityFixture);
      
      const CharityEvent = await ethers.getContractFactory("CharityEvent");
      
      await expect(
        CharityEvent.connect(charityOwner).deploy(
          await governance.getAddress(),
          await registry.getAddress(),
          ethers.ZeroHash,
          1n,
          await (await ethers.getSigners())[5].getAddress(),
          ethers.parseEther("100"),
          (await time.latest()) + 3600,
          "Test"
        )
      ).to.be.revertedWith("Invalid event ID");
      
      await expect(
        CharityEvent.connect(charityOwner).deploy(
          await governance.getAddress(),
          await registry.getAddress(),
          ethers.keccak256(ethers.toUtf8Bytes("test")),
          0n,
          await (await ethers.getSigners())[5].getAddress(),
          ethers.parseEther("100"),
          (await time.latest()) + 3600,
          "Test"
        )
      ).to.be.revertedWith("Invalid org ID");
      
      await expect(
        CharityEvent.connect(charityOwner).deploy(
          await governance.getAddress(),
          await registry.getAddress(),
          ethers.keccak256(ethers.toUtf8Bytes("test")),
          1n,
          ethers.ZeroAddress,
          ethers.parseEther("100"),
          (await time.latest()) + 3600,
          "Test"
        )
      ).to.be.revertedWith("Invalid beneficiary");
      
      await expect(
        CharityEvent.connect(charityOwner).deploy(
          await governance.getAddress(),
          await registry.getAddress(),
          ethers.keccak256(ethers.toUtf8Bytes("test")),
          1n,
          await (await ethers.getSigners())[5].getAddress(),
          0n,
          (await time.latest()) + 3600,
          "Test"
        )
      ).to.be.revertedWith("Invalid funding goal");
      
      await expect(
        CharityEvent.connect(charityOwner).deploy(
          await governance.getAddress(),
          await registry.getAddress(),
          ethers.keccak256(ethers.toUtf8Bytes("test")),
          1n,
          await (await ethers.getSigners())[5].getAddress(),
          ethers.parseEther("100"),
          (await time.latest()) - 100,
          "Test"
        )
      ).to.be.revertedWith("Invalid deadline");
    });

    it("4c) should update raised amount and auto-close when goal reached", async () => {
      const { eventCtr, deployer } = await loadFixture(setupEventFixture);
      
      await expect(
        eventCtr.connect(deployer).updateRaised(ethers.parseEther("50"))
      )
        .to.emit(eventCtr, "FundsRaised")
        .withArgs(await eventCtr.eventId(), ethers.parseEther("50"));
      
      let summary = await eventCtr.getEventSummary();
      expect(summary[4]).to.equal(ethers.parseEther("50"));
      expect(summary[2]).to.equal(0n); // Still FUNDING
      
      await eventCtr.connect(deployer).updateRaised(ethers.parseEther("50"));
      
      summary = await eventCtr.getEventSummary();
      expect(summary[4]).to.equal(ethers.parseEther("100"));
      expect(summary[2]).to.equal(1n); // CLOSED (auto-closed)
    });

    it("4d) should reject updateRaised when not in FUNDING phase", async () => {
      const { eventCtr, charityOwner, deployer } = await loadFixture(setupEventFixture);
      
      await eventCtr.connect(charityOwner).closeFunding();
      
      await expect(
        eventCtr.connect(deployer).updateRaised(ethers.parseEther("10"))
      ).to.be.revertedWith("Wrong phase");
    });

    it("4e) should allow owner to close funding", async () => {
      const { eventCtr, charityOwner } = await loadFixture(setupEventFixture);
      
      await expect(
        eventCtr.connect(charityOwner).closeFunding()
      )
        .to.emit(eventCtr, "PhaseChanged");
      
      const summary = await eventCtr.getEventSummary();
      expect(summary[2]).to.equal(1n); // CLOSED
    });

    it("4f) should reject closeFunding from non-owner", async () => {
      const { eventCtr, user1 } = await loadFixture(setupEventFixture);
      
      await expect(
        eventCtr.connect(user1).closeFunding()
      ).to.be.revertedWith("Not charity owner");
    });

    it("4g) should allow owner to submit evidence in CLOSED phase", async () => {
      const { eventCtr, charityOwner } = await loadFixture(setupEventFixture);
      
      await eventCtr.connect(charityOwner).closeFunding();
      
      await expect(
        eventCtr.connect(charityOwner).submitEvidence("QmEvidence")
      )
        .to.emit(eventCtr, "EvidenceSubmitted")
        .withArgs(await eventCtr.eventId(), "QmEvidence");
      
      const summary = await eventCtr.getEventSummary();
      expect(summary[2]).to.equal(2n); // VERIFICATION
    });

    it("4h) should reject submitEvidence with invalid inputs", async () => {
      const { eventCtr, charityOwner, user1 } = await loadFixture(setupEventFixture);
      
      await eventCtr.connect(charityOwner).closeFunding();
      
      await expect(
        eventCtr.connect(user1).submitEvidence("QmEvidence")
      ).to.be.revertedWith("Not charity owner");
      
      await expect(
        eventCtr.connect(charityOwner).submitEvidence("")
      ).to.be.revertedWith("Invalid evidence CID");
    });

    it("4i) should reject submitEvidence in wrong phase", async () => {
      const { eventCtr, charityOwner } = await loadFixture(setupEventFixture);
      
      await expect(
        eventCtr.connect(charityOwner).submitEvidence("QmEvidence")
      ).to.be.revertedWith("Wrong phase");
    });

    it("4j) should allow oracle to set verification status", async () => {
      const { eventCtr, charityOwner, oracle } = await loadFixture(setupEventFixture);
      
      await eventCtr.connect(charityOwner).closeFunding();
      await eventCtr.connect(charityOwner).submitEvidence("QmEvidence");
      
      await expect(
        eventCtr.connect(oracle).setVerified(true, [true, true, true])
      )
        .to.emit(eventCtr, "VerifiedSet")
        .withArgs(await eventCtr.eventId(), true, [true, true, true]);
      
      const summary = await eventCtr.getEventSummary();
      expect(summary[2]).to.equal(3n); // APPROVED
      expect(summary[6]).to.equal(true); // verified (index 6, not 5)
    });

    it("4k) should transition to REJECTED on false verification", async () => {
      const { eventCtr, charityOwner, oracle } = await loadFixture(setupEventFixture);
      
      await eventCtr.connect(charityOwner).closeFunding();
      await eventCtr.connect(charityOwner).submitEvidence("QmEvidence");
      
      await eventCtr.connect(oracle).setVerified(false, [false, false, false]);
      
      const summary = await eventCtr.getEventSummary();
      expect(summary[2]).to.equal(4n); // REJECTED
      expect(summary[6]).to.equal(false); // verified (index 6, not 5)
    });

    it("4l) should reject setVerified from non-oracle", async () => {
      const { eventCtr, charityOwner, user1 } = await loadFixture(setupEventFixture);
      
      await eventCtr.connect(charityOwner).closeFunding();
      await eventCtr.connect(charityOwner).submitEvidence("QmEvidence");
      
      await expect(
        eventCtr.connect(user1).setVerified(true, [true, true, true])
      ).to.be.revertedWith("Not oracle");
    });

    it("4m) should allow retry request after rejection", async () => {
      const { eventCtr, charityOwner, oracle } = await loadFixture(setupEventFixture);
      
      await eventCtr.connect(charityOwner).closeFunding();
      await eventCtr.connect(charityOwner).submitEvidence("QmEvidence1");
      await eventCtr.connect(oracle).setVerified(false, [false, false, false]);
      
      await expect(
        eventCtr.connect(charityOwner).requestRetry("QmEvidence2")
      )
        .to.emit(eventCtr, "RetryRequested")
        .withArgs(await eventCtr.eventId(), "QmEvidence2");
      
      const summary = await eventCtr.getEventSummary();
      expect(summary[2]).to.equal(2n); // Back to VERIFICATION
      expect(await eventCtr.retryCount()).to.equal(1n);
    });

    it("4n) should enforce retry limit", async () => {
      const { eventCtr, charityOwner, oracle } = await loadFixture(setupEventFixture);
      
      await eventCtr.connect(charityOwner).closeFunding();
      
      // First submission
      await eventCtr.connect(charityOwner).submitEvidence("QmEvidence0");
      
      // Do 3 retries (each: reject -> requestRetry moves to VERIFICATION with new evidence)
      for (let i = 0; i < 3; i++) {
        // Verify as false
        await eventCtr.connect(oracle).setVerified(false, [false, false, false]);
        // Request retry (updates evidence and moves back to VERIFICATION)
        await eventCtr.connect(charityOwner).requestRetry(`QmEvidence${i + 1}`);
        expect(await eventCtr.retryCount()).to.equal(BigInt(i + 1));
      }
      
      // After 3 retries, verify false one more time
      await eventCtr.connect(oracle).setVerified(false, [false, false, false]);
      
      // Now try 4th retry - should fail (max is 3)
      await expect(
        eventCtr.connect(charityOwner).requestRetry("QmEvidence4")
      ).to.be.revertedWith("Max retries reached");
    });

    it("4o) should reject retry request in wrong phase", async () => {
      const { eventCtr, charityOwner } = await loadFixture(setupEventFixture);
      
      await expect(
        eventCtr.connect(charityOwner).requestRetry("QmEvidence")
      ).to.be.revertedWith("Wrong phase");
    });

    it("4p) should allow admin to cancel event", async () => {
      const { eventCtr, deployer } = await loadFixture(setupEventFixture);
      
      await expect(
        eventCtr.connect(deployer).cancel()
      ).to.emit(eventCtr, "Cancelled");
      
      const summary = await eventCtr.getEventSummary();
      expect(summary[2]).to.equal(5n); // CANCELLED
    });

    it("4q) should check goal reached correctly", async () => {
      const { eventCtr, deployer } = await loadFixture(setupEventFixture);
      
      expect(await eventCtr.goalReached()).to.equal(false);
      
      await eventCtr.connect(deployer).updateRaised(ethers.parseEther("100"));
      
      expect(await eventCtr.goalReached()).to.equal(true);
    });

    it("4r) should check deadline passed correctly", async () => {
      const { eventCtr, advanceTime } = await loadFixture(setupEventFixture);
      
      expect(await eventCtr.fundingDeadlinePassed()).to.equal(false);
      
      const deadline = await eventCtr.fundingDeadline();
      const currentTime = BigInt(await time.latest());
      const timeToAdvance = Number(deadline - currentTime + 1n);
      await advanceTime(timeToAdvance);
      
      expect(await eventCtr.fundingDeadlinePassed()).to.equal(true);
    });

    it("4s) should handle pause correctly", async () => {
      const { eventCtr, pauser, deployer } = await loadFixture(setupEventFixture);
      
      // Pause the CharityEvent contract itself (not just governance)
      await eventCtr.connect(pauser).pause();
      
      // OpenZeppelin Pausable uses custom error EnforcedPause, so just check for revert
      await expect(
        eventCtr.connect(deployer).updateRaised(ethers.parseEther("10"))
      ).to.be.reverted;
      
      // Unpause
      await eventCtr.connect(deployer).unpause();
      
      await eventCtr.connect(deployer).updateRaised(ethers.parseEther("10"));
      const summary = await eventCtr.getEventSummary();
      expect(summary[4]).to.equal(ethers.parseEther("10"));
    });
  });

  // =================================================================
  // 5. Integration Tests
  // =================================================================
  describe("5. Integration Tests", function () {
    it("5a) full flow: register -> approve -> create treasury -> fund -> verify -> release", async () => {
      const { registry, treasury, reputation, sgd, createEvent, deployer, oracle, charityOwner, beneficiary } = await loadFixture(deployCharityFixture);
      
      // Register charity
      await registry.connect(charityOwner).registerCharity("Charity A", "QmMeta");
      const orgId = await registry.addressToOrgId(await charityOwner.getAddress());
      
      // Approve and set treasury
      await registry.connect(deployer).setApproval(orgId, true);
      await registry.connect(deployer).setTreasury(orgId, await treasury.getAddress());
      
      // Initialize reputation
      await reputation.connect(deployer).initializeReputation(orgId);
      
      // Create treasury
      await treasury.connect(deployer).createTreasury(orgId, await charityOwner.getAddress());
      
      // Create event
      const eventCtr = await createEvent(charityOwner, orgId, ethers.parseEther("100"), 3600);
      
      // Fund event
      await eventCtr.connect(deployer).updateRaised(ethers.parseEther("100"));
      expect((await eventCtr.getEventSummary())[2]).to.equal(1n); // CLOSED
      
      // Submit evidence
      await eventCtr.connect(charityOwner).submitEvidence("QmEvidence");
      expect((await eventCtr.getEventSummary())[2]).to.equal(2n); // VERIFICATION
      
      // Verify
      await eventCtr.connect(oracle).setVerified(true, [true, true, true]);
      expect((await eventCtr.getEventSummary())[2]).to.equal(3n); // APPROVED
      
      // Release funds
      await sgd.connect(deployer).mint(await oracle.getAddress(), ethers.parseEther("100"));
      await sgd.connect(oracle).approve(await treasury.getAddress(), ethers.parseEther("100"));
      await treasury.connect(oracle).receiveRelease(orgId, await eventCtr.eventId(), ethers.parseEther("100"));
      
      // Update reputation
      await reputation.connect(oracle).updateOnEventOutcome(orgId, await eventCtr.eventId(), true);
      await reputation.connect(oracle).updateOnFinalize(orgId, true);
      
      expect(await reputation.scoreOf(orgId)).to.equal(525n); // 500 + 10 + 15
      
      // Withdraw
      await treasury.connect(charityOwner).withdraw(await beneficiary.getAddress(), ethers.parseEther("50"));
      expect(await sgd.balanceOf(await beneficiary.getAddress())).to.equal(ethers.parseEther("50"));
    });

    it("5b) multiple events for same charity", async () => {
      const { registry, treasury, reputation, createEvent, deployer, oracle, charityOwner } = await loadFixture(deployCharityFixture);
      
      await registry.connect(charityOwner).registerCharity("Charity A", "QmMeta");
      const orgId = await registry.addressToOrgId(await charityOwner.getAddress());
      await registry.connect(deployer).setApproval(orgId, true);
      await registry.connect(deployer).setTreasury(orgId, await treasury.getAddress());
      await reputation.connect(deployer).initializeReputation(orgId);
      await treasury.connect(deployer).createTreasury(orgId, await charityOwner.getAddress());
      
      // Create and verify multiple events
      for (let i = 1; i <= 3; i++) {
        const eventCtr = await createEvent(charityOwner, orgId, ethers.parseEther("100"), 3600);
        await eventCtr.connect(charityOwner).closeFunding();
        await eventCtr.connect(charityOwner).submitEvidence(`QmEvidence${i}`);
        await eventCtr.connect(oracle).setVerified(i % 2 === 0, [i % 2 === 0, i % 2 === 0, i % 2 === 0]);
        await reputation.connect(oracle).updateOnEventOutcome(orgId, await eventCtr.eventId(), i % 2 === 0);
      }
      
      const data = await reputation.getReputationData(orgId);
      expect(data.totalEvents).to.equal(3n);
      expect(data.successfulEvents).to.equal(1n); // Only event 2 succeeded
      expect(data.failedEvents).to.equal(2n);
    });
  });
});
