const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

/**
 * TEST SUITE: AttestorRegistry Contract (SGD Token Version)
 * 
 * This test suite validates the attestor registry including:
 * - Attestor registration with SGD staking
 * - Attestation submission
 * - Reputation management
 * - Consensus finalization with rewards/slashing
 * - Governance and admin functions
 */
describe("AttestorRegistry (SGD Token)", function () {
  let attestorRegistry, stakingContract, attestationManager, sgdToken;
  let admin, governance, attestor1, attestor2, attestor3, attestor4, attestor5, other;
  const MIN_STAKE = ethers.parseEther("1000"); // 1000 SGD
  const SLASH_PENALTY = ethers.parseEther("500"); // 500 SGD
  const REWARD_AMOUNT = ethers.parseEther("100"); // 100 SGD

  beforeEach(async function () {
    [admin, governance, attestor1, attestor2, attestor3, attestor4, attestor5, other] = 
      await ethers.getSigners();

    // Deploy SGDCoin
    const SGDCoin = await ethers.getContractFactory("SGDCoin");
    sgdToken = await SGDCoin.deploy();
    await sgdToken.waitForDeployment();

    // Deploy AttestorStaking
    const AttestorStaking = await ethers.getContractFactory("AttestorStaking");
    stakingContract = await AttestorStaking.deploy(
      MIN_STAKE,
      ethers.ZeroAddress, // Registry (will be set later)
      await sgdToken.getAddress()
    );
    await stakingContract.waitForDeployment();

    // Deploy AttestationManager
    const AttestationManager = await ethers.getContractFactory("AttestationManager");
    attestationManager = await AttestationManager.deploy();
    await attestationManager.waitForDeployment();

    // Deploy AttestorRegistry
    const AttestorRegistry = await ethers.getContractFactory("AttestorRegistry");
    attestorRegistry = await AttestorRegistry.deploy(
      await stakingContract.getAddress(),
      await attestationManager.getAddress(),
      governance.address,
      await sgdToken.getAddress()
    );
    await attestorRegistry.waitForDeployment();

    // Set cross-references
    await stakingContract.connect(admin).setRegistry(await attestorRegistry.getAddress());
    await attestationManager.connect(admin).setRegistry(await attestorRegistry.getAddress());
    await attestationManager.connect(admin).setCharityEvents(admin.address);

    // Mint SGD tokens for test users
    const mintAmount = ethers.parseEther("10000");
    for (let user of [attestor1, attestor2, attestor3, attestor4, attestor5, other, admin]) {
      await sgdToken.mint(user.address, mintAmount);
    }
  });

  describe("Deployment", function () {
    /**
     * TEST: Contract initializes with correct admin
     * OUTCOME: Admin should be deployer address
     */
    it("Should set the correct admin", async function () {
      expect(await attestorRegistry.admin()).to.equal(admin.address);
    });

    /**
     * TEST: Contract initializes with correct governance
     * OUTCOME: Governance should match constructor parameter
     */
    it("Should set the correct governance address", async function () {
      expect(await attestorRegistry.governance()).to.equal(governance.address);
    });

    /**
     * TEST: Contract links to correct staking contract
     * OUTCOME: Staking contract address should match
     */
    it("Should link to correct staking contract", async function () {
      expect(await attestorRegistry.stakingContract()).to.equal(
        await stakingContract.getAddress()
      );
    });

    /**
     * TEST: Contract links to correct attestation manager
     * OUTCOME: Attestation manager address should match
     */
    it("Should link to correct attestation manager", async function () {
      expect(await attestorRegistry.attestationManager()).to.equal(
        await attestationManager.getAddress()
      );
    });

    /**
     * TEST: Contract links to correct SGD token
     * OUTCOME: SGD token address should match
     */
    it("Should link to correct SGD token", async function () {
      expect(await attestorRegistry.sgdToken()).to.equal(
        await sgdToken.getAddress()
      );
    });

    /**
     * TEST: Default parameters are set correctly
     * OUTCOME: Should have correct initial values
     */
    it("Should set default parameters", async function () {
      expect(await attestorRegistry.minReputation()).to.equal(50);
      expect(await attestorRegistry.maxReputation()).to.equal(1000);
      expect(await attestorRegistry.slashPenalty()).to.equal(SLASH_PENALTY);
      expect(await attestorRegistry.rewardAmount()).to.equal(REWARD_AMOUNT);
    });
  });

  describe("Attestor Registration with SGD", function () {
    /**
     * TEST: Attestor can register with sufficient SGD stake
     * OUTCOME: Attestor should be registered and active
     */
    it("Should allow attestor to register with SGD tokens", async function () {
      const stakeAmount = ethers.parseEther("2000");

      // Approve registry to spend SGD
      await sgdToken.connect(attestor1).approve(
        await attestorRegistry.getAddress(),
        stakeAmount
      );

      await expect(
        attestorRegistry.connect(attestor1).registerAsAttestor(stakeAmount)
      )
        .to.emit(attestorRegistry, "AttestorRegistered")
        .withArgs(attestor1.address, stakeAmount);

      expect(await attestorRegistry.isRegistered(attestor1.address)).to.be.true;
      
      const attestorData = await attestorRegistry.attestors(attestor1.address);
      expect(attestorData.isActive).to.be.true;
      expect(attestorData.reputation).to.equal(100); // Initial reputation
    });

    /**
     * TEST: Registration requires SGD token approval
     * OUTCOME: Should revert without approval
     */
    it("Should reject registration without SGD approval", async function () {
      const stakeAmount = ethers.parseEther("2000");

      await expect(
        attestorRegistry.connect(attestor1).registerAsAttestor(stakeAmount)
      ).to.be.revertedWith("Insufficient SGD allowance");
    });

    /**
     * TEST: Registration requires sufficient approval amount
     * OUTCOME: Should revert with insufficient approval
     */
    it("Should reject registration with insufficient approval", async function () {
      const stakeAmount = ethers.parseEther("2000");
      const approvalAmount = ethers.parseEther("1000");

      await sgdToken.connect(attestor1).approve(
        await attestorRegistry.getAddress(),
        approvalAmount
      );

      await expect(
        attestorRegistry.connect(attestor1).registerAsAttestor(stakeAmount)
      ).to.be.revertedWith("Insufficient SGD allowance");
    });

    /**
     * TEST: Cannot register with insufficient stake
     * OUTCOME: Should revert with error
     */
    it("Should reject registration with insufficient stake", async function () {
      const insufficientStake = ethers.parseEther("500");

      await sgdToken.connect(attestor1).approve(
        await attestorRegistry.getAddress(),
        insufficientStake
      );

      await expect(
        attestorRegistry.connect(attestor1).registerAsAttestor(insufficientStake)
      ).to.be.revertedWith("Insufficient stake");
    });

    /**
     * TEST: Cannot register twice
     * OUTCOME: Second registration should revert
     */
    it("Should reject duplicate registration", async function () {
      const stakeAmount = ethers.parseEther("2000");

      await sgdToken.connect(attestor1).approve(
        await attestorRegistry.getAddress(),
        stakeAmount * 2n
      );

      await attestorRegistry.connect(attestor1).registerAsAttestor(stakeAmount);

      await expect(
        attestorRegistry.connect(attestor1).registerAsAttestor(stakeAmount)
      ).to.be.revertedWith("Already registered");
    });

    /**
     * TEST: Stake is properly forwarded to staking contract
     * OUTCOME: Staking contract should hold the stake
     */
    it("Should forward stake to staking contract", async function () {
      const stakeAmount = ethers.parseEther("2000");

      await sgdToken.connect(attestor1).approve(
        await attestorRegistry.getAddress(),
        stakeAmount
      );

      await attestorRegistry.connect(attestor1).registerAsAttestor(stakeAmount);

      expect(await stakingContract.getStake(attestor1.address)).to.equal(stakeAmount);
    });
  });

  describe("Adding Stake (Recovery) with SGD", function () {
    /**
     * TEST: Registered attestor can add more SGD stake
     * OUTCOME: Stake should increase
     */
    it("Should allow registered attestor to add SGD stake", async function () {
      const initialStake = ethers.parseEther("1000");
      const additionalStake = ethers.parseEther("500");

      // Register
      await sgdToken.connect(attestor1).approve(
        await attestorRegistry.getAddress(),
        initialStake
      );
      await attestorRegistry.connect(attestor1).registerAsAttestor(initialStake);

      // Add more stake
      await sgdToken.connect(attestor1).approve(
        await attestorRegistry.getAddress(),
        additionalStake
      );
      await attestorRegistry.connect(attestor1).addStake(additionalStake);

      expect(await stakingContract.getStake(attestor1.address)).to.equal(
        initialStake + additionalStake
      );
    });

    /**
     * TEST: addStake requires SGD approval
     * OUTCOME: Should revert without approval
     */
    it("Should reject addStake without SGD approval", async function () {
      const stakeAmount = ethers.parseEther("1000");

      // Register first
      await sgdToken.connect(attestor1).approve(
        await attestorRegistry.getAddress(),
        stakeAmount
      );
      await attestorRegistry.connect(attestor1).registerAsAttestor(stakeAmount);

      // Try to add without approval
      await expect(
        attestorRegistry.connect(attestor1).addStake(stakeAmount)
      ).to.be.revertedWith("Insufficient SGD allowance");
    });

    /**
     * TEST: Unregistered attestor cannot add stake
     * OUTCOME: Should revert
     */
    it("Should reject adding stake from unregistered attestor", async function () {
      await expect(
        attestorRegistry.connect(attestor1).addStake(ethers.parseEther("1000"))
      ).to.be.revertedWith("Not registered");
    });

    /**
     * TEST: Adding stake reactivates slashed attestor
     * OUTCOME: Inactive attestor with sufficient reputation should be reactivated
     */
    it("Should auto-reactivate slashed attestor when stake added", async function () {
      const stakeAmount = ethers.parseEther("2000");
      
      // Register
      await sgdToken.connect(attestor1).approve(
        await attestorRegistry.getAddress(),
        stakeAmount
      );
      await attestorRegistry.connect(attestor1).registerAsAttestor(stakeAmount);
      
      // Deactivate
      await attestorRegistry.connect(admin).deactivateAttestor(attestor1.address, "Test");
      
      const attestorBefore = await attestorRegistry.attestors(attestor1.address);
      expect(attestorBefore.isActive).to.be.false;
      
      // Add stake should reactivate (reputation still >= 50)
      await sgdToken.connect(attestor1).approve(
        await attestorRegistry.getAddress(),
        MIN_STAKE
      );
      await attestorRegistry.connect(attestor1).addStake(MIN_STAKE);
      
      const attestorAfter = await attestorRegistry.attestors(attestor1.address);
      expect(attestorAfter.isActive).to.be.true;
    });

    /**
     * TEST: Adding stake does not reactivate if reputation too low
     * OUTCOME: Should remain inactive if reputation < minReputation
     */
    it("Should not auto-reactivate if reputation too low", async function () {
      const stakeAmount = ethers.parseEther("2000");
      
      await sgdToken.connect(attestor1).approve(
        await attestorRegistry.getAddress(),
        stakeAmount
      );
      await attestorRegistry.connect(attestor1).registerAsAttestor(stakeAmount);
      
      // Slash reputation below minimum (need multiple slashes)
      for (let i = 0; i < 3; i++) {
        await attestorRegistry.connect(admin).manualSlash(
          attestor1.address,
          ethers.parseEther("100"),
          "Penalty"
        );
      }
      
      await attestorRegistry.connect(admin).deactivateAttestor(attestor1.address, "Test");
      
      // Add stake
      await sgdToken.connect(attestor1).approve(
        await attestorRegistry.getAddress(),
        MIN_STAKE
      );
      await attestorRegistry.connect(attestor1).addStake(MIN_STAKE);
      
      // Should still be inactive due to low reputation
      const attestor = await attestorRegistry.attestors(attestor1.address);
      expect(attestor.reputation).to.be.lt(50);
      expect(attestor.isActive).to.be.false;
    });
  });

  describe("Deactivation and Reactivation", function () {
    beforeEach(async function () {
      await sgdToken.connect(attestor1).approve(
        await attestorRegistry.getAddress(),
        ethers.parseEther("2000")
      );
      await attestorRegistry.connect(attestor1).registerAsAttestor(
        ethers.parseEther("2000")
      );
    });

    /**
     * TEST: Admin can deactivate attestor
     * OUTCOME: Attestor should become inactive
     */
    it("Should allow admin to deactivate attestor", async function () {
      await expect(
        attestorRegistry.connect(admin).deactivateAttestor(attestor1.address, "Misbehavior")
      )
        .to.emit(attestorRegistry, "AttestorDeactivated")
        .withArgs(attestor1.address, "Misbehavior");

      const attestor = await attestorRegistry.attestors(attestor1.address);
      expect(attestor.isActive).to.be.false;
    });

    /**
     * TEST: Governance can deactivate attestor
     * OUTCOME: Attestor should become inactive
     */
    it("Should allow governance to deactivate attestor", async function () {
      await attestorRegistry.connect(governance).deactivateAttestor(
        attestor1.address, 
        "DAO decision"
      );

      const attestor = await attestorRegistry.attestors(attestor1.address);
      expect(attestor.isActive).to.be.false;
    });

    /**
     * TEST: Cannot deactivate unregistered attestor
     * OUTCOME: Should revert
     */
    it("Should reject deactivating unregistered attestor", async function () {
      await expect(
        attestorRegistry.connect(admin).deactivateAttestor(other.address, "Reason")
      ).to.be.revertedWith("Not registered");
    });

    /**
     * TEST: Admin can reactivate attestor
     * OUTCOME: Attestor should become active again
     */
    it("Should allow admin to reactivate attestor", async function () {
      await attestorRegistry.connect(admin).deactivateAttestor(attestor1.address, "Test");
      
      await expect(
        attestorRegistry.connect(admin).reactivateAttestor(attestor1.address)
      )
        .to.emit(attestorRegistry, "AttestorReactivated")
        .withArgs(attestor1.address);

      const attestor = await attestorRegistry.attestors(attestor1.address);
      expect(attestor.isActive).to.be.true;
    });

    /**
     * TEST: Cannot reactivate if stake below minimum
     * OUTCOME: Should revert
     */
    it("Should reject reactivation if stake insufficient", async function () {
      await attestorRegistry.connect(admin).deactivateAttestor(attestor1.address, "Test");
      
      // Slash stake below minimum
      await attestorRegistry.connect(admin).manualSlash(
        attestor1.address,
        ethers.parseEther("1500"),
        "Penalty"
      );

      await expect(
        attestorRegistry.connect(admin).reactivateAttestor(attestor1.address)
      ).to.be.revertedWith("Insufficient stake");
    });

    /**
     * TEST: Cannot reactivate already active attestor
     * OUTCOME: Should revert
     */
    it("Should reject reactivating already active attestor", async function () {
      await expect(
        attestorRegistry.connect(admin).reactivateAttestor(attestor1.address)
      ).to.be.revertedWith("Already active");
    });

    /**
     * TEST: Non-admin/governance cannot deactivate
     * OUTCOME: Should revert
     */
    it("Should reject deactivation from unauthorized address", async function () {
      await expect(
        attestorRegistry.connect(other).deactivateAttestor(attestor1.address, "Reason")
      ).to.be.revertedWith("Not authorized");
    });
  });

  describe("Withdrawal", function () {
    /**
     * TEST: Attestor can request withdrawal
     * OUTCOME: Attestor should be deactivated and withdrawal requested
     */
    it("Should allow attestor to request withdrawal", async function () {
      await sgdToken.connect(attestor1).approve(
        await attestorRegistry.getAddress(),
        ethers.parseEther("2000")
      );
      await attestorRegistry.connect(attestor1).registerAsAttestor(
        ethers.parseEther("2000")
      );

      await attestorRegistry.connect(attestor1).requestWithdrawal();

      const attestor = await attestorRegistry.attestors(attestor1.address);
      expect(attestor.isActive).to.be.false;
      
      expect(await stakingContract.getWithdrawalRequest(attestor1.address)).to.be.gt(0);
    });

    /**
     * TEST: Unregistered attestor cannot request withdrawal
     * OUTCOME: Should revert
     */
    it("Should reject withdrawal request from unregistered", async function () {
      await expect(
        attestorRegistry.connect(attestor1).requestWithdrawal()
      ).to.be.revertedWith("Not registered");
    });
  });

  describe("Attestation Submission", function () {
    const eventId = 1;

    beforeEach(async function () {
      // Register 5 attestors
      for (let attestor of [attestor1, attestor2, attestor3, attestor4, attestor5]) {
        await sgdToken.connect(attestor).approve(
          await attestorRegistry.getAddress(),
          ethers.parseEther("2000")
        );
        await attestorRegistry.connect(attestor).registerAsAttestor(
          ethers.parseEther("2000")
        );
      }

      // Open attestation window
      await attestationManager.connect(admin).openAttestationWindow(eventId, 3, 0);
    });

    /**
     * TEST: Active attestor can submit attestation
     * OUTCOME: Attestation should be recorded
     */
    it("Should allow active attestor to submit attestation", async function () {
      await expect(
        attestorRegistry.connect(attestor1).submitAttestation(
          eventId, 
          true, 
          "ipfs://proof-hash"
        )
      )
        .to.emit(attestorRegistry, "AttestationSubmitted")
        .withArgs(attestor1.address, eventId, true);

      expect(
        await attestationManager.hasAttestorAttested(eventId, attestor1.address)
      ).to.be.true;
    });

    /**
     * TEST: Cannot submit attestation if not registered
     * OUTCOME: Should revert
     */
    it("Should reject attestation from unregistered attestor", async function () {
      await expect(
        attestorRegistry.connect(other).submitAttestation(eventId, true, "uri")
      ).to.be.revertedWith("Not registered");
    });

    /**
     * TEST: Cannot submit attestation if inactive
     * OUTCOME: Should revert
     */
    it("Should reject attestation from inactive attestor", async function () {
      await attestorRegistry.connect(admin).deactivateAttestor(attestor1.address, "Test");

      await expect(
        attestorRegistry.connect(attestor1).submitAttestation(eventId, true, "uri")
      ).to.be.revertedWith("Not active attestor");
    });

    /**
     * TEST: Cannot submit attestation if reputation too low
     * OUTCOME: Should revert
     */
    it("Should reject attestation if reputation below minimum", async function () {
      // Slash attestor multiple times to reduce reputation below 50
      for (let i = 0; i < 3; i++) {
        await attestorRegistry.connect(admin).manualSlash(
          attestor1.address,
          ethers.parseEther("100"),
          "Penalty"
        );
      }

      await expect(
        attestorRegistry.connect(attestor1).submitAttestation(eventId, true, "uri")
      ).to.be.revertedWith("Reputation too low");
    });

    /**
     * TEST: Cannot submit attestation if stake below minimum
     * OUTCOME: Should revert (checked in modifier)
     */
    it("Should reject attestation if stake below minimum", async function () {
      // Slash stake below minimum
      await attestorRegistry.connect(admin).manualSlash(
        attestor1.address,
        ethers.parseEther("1500"),
        "Heavy penalty"
      );

      await expect(
        attestorRegistry.connect(attestor1).submitAttestation(eventId, true, "uri")
      ).to.be.revertedWith("Stake below minimum");
    });

    /**
     * TEST: Cannot submit attestation twice
     * OUTCOME: Second submission should revert
     */
    it("Should reject duplicate attestation from same attestor", async function () {
      await attestorRegistry.connect(attestor1).submitAttestation(eventId, true, "uri");

      await expect(
        attestorRegistry.connect(attestor1).submitAttestation(eventId, false, "uri2")
      ).to.be.revertedWith("Already attested to this event");
    });

    /**
     * TEST: Multiple attestors can submit attestations
     * OUTCOME: All attestations should be recorded
     */
    it("Should allow multiple attestors to submit attestations", async function () {
      await attestorRegistry.connect(attestor1).submitAttestation(eventId, true, "uri1");
      await attestorRegistry.connect(attestor2).submitAttestation(eventId, true, "uri2");
      await attestorRegistry.connect(attestor3).submitAttestation(eventId, false, "uri3");

      const attestations = await attestorRegistry.getEventAttestations(eventId);
      expect(attestations.length).to.equal(3);
    });
  });

  describe("Consensus Finalization with SGD", function () {
    const eventId = 1;

    beforeEach(async function () {
      // Register attestors
      for (let attestor of [attestor1, attestor2, attestor3, attestor4, attestor5]) {
        await sgdToken.connect(attestor).approve(
          await attestorRegistry.getAddress(),
          ethers.parseEther("2000")
        );
        await attestorRegistry.connect(attestor).registerAsAttestor(
          ethers.parseEther("2000")
        );
      }

      // Open attestation window
      await attestationManager.connect(admin).openAttestationWindow(eventId, 5, 0);

      // Fund reward pool with SGD
      await sgdToken.connect(admin).approve(
        await attestorRegistry.getAddress(),
        ethers.parseEther("5000")
      );
      await attestorRegistry.connect(admin).fundRewardPool(ethers.parseEther("5000"));
    });

    /**
     * TEST: Correct attestors are rewarded after approval
     * OUTCOME: Attestors who voted correctly should gain reputation and rewards
     */
    it("Should reward correct attestors on approval", async function () {
      // Submit attestations (4 approve, 1 reject)
      await attestorRegistry.connect(attestor1).submitAttestation(eventId, true, "uri");
      await attestorRegistry.connect(attestor2).submitAttestation(eventId, true, "uri");
      await attestorRegistry.connect(attestor3).submitAttestation(eventId, true, "uri");
      await attestorRegistry.connect(attestor4).submitAttestation(eventId, true, "uri");
      await attestorRegistry.connect(attestor5).submitAttestation(eventId, false, "uri");

      const repBefore = await attestorRegistry.getReputation(attestor1.address);

      await attestorRegistry.connect(admin).finalizeEventConsensus(eventId);

      const repAfter = await attestorRegistry.getReputation(attestor1.address);
      expect(repAfter).to.be.gt(repBefore); // Reputation increased
    });

    /**
     * TEST: Incorrect attestors are slashed after approval
     * OUTCOME: Attestors who voted incorrectly should lose reputation and stake
     */
    it("Should slash incorrect attestors on approval", async function () {
      // Submit attestations (4 approve, 1 reject - attestor5 is wrong)
      await attestorRegistry.connect(attestor1).submitAttestation(eventId, true, "uri");
      await attestorRegistry.connect(attestor2).submitAttestation(eventId, true, "uri");
      await attestorRegistry.connect(attestor3).submitAttestation(eventId, true, "uri");
      await attestorRegistry.connect(attestor4).submitAttestation(eventId, true, "uri");
      await attestorRegistry.connect(attestor5).submitAttestation(eventId, false, "uri");

      const stakeBefore = await stakingContract.getStake(attestor5.address);
      const repBefore = await attestorRegistry.getReputation(attestor5.address);

      await expect(
        attestorRegistry.connect(admin).finalizeEventConsensus(eventId)
      )
        .to.emit(attestorRegistry, "AttestorSlashed")
        .withArgs(attestor5.address, SLASH_PENALTY, "Incorrect attestation");

      const stakeAfter = await stakingContract.getStake(attestor5.address);
      const repAfter = await attestorRegistry.getReputation(attestor5.address);

      expect(stakeAfter).to.equal(stakeBefore - SLASH_PENALTY);
      expect(repAfter).to.be.lt(repBefore);
    });

    /**
     * TEST: Correct attestors are rewarded after rejection
     * OUTCOME: Attestors who voted to reject should be rewarded
     */
    it("Should reward correct attestors on rejection", async function () {
      // Submit attestations (1 approve, 4 reject - consensus is reject)
      await attestorRegistry.connect(attestor1).submitAttestation(eventId, false, "uri");
      await attestorRegistry.connect(attestor2).submitAttestation(eventId, false, "uri");
      await attestorRegistry.connect(attestor3).submitAttestation(eventId, false, "uri");
      await attestorRegistry.connect(attestor4).submitAttestation(eventId, false, "uri");
      await attestorRegistry.connect(attestor5).submitAttestation(eventId, true, "uri");

      const repBefore = await attestorRegistry.getReputation(attestor1.address);

      await attestorRegistry.connect(admin).finalizeEventConsensus(eventId);

      const repAfter = await attestorRegistry.getReputation(attestor1.address);
      expect(repAfter).to.be.gt(repBefore);
    });

    /**
     * TEST: Slashed funds go to reward pool
     * OUTCOME: Reward pool should increase by slashed amount
     */
    it("Should add slashed funds to reward pool", async function () {
      await attestorRegistry.connect(attestor1).submitAttestation(eventId, true, "uri");
      await attestorRegistry.connect(attestor2).submitAttestation(eventId, true, "uri");
      await attestorRegistry.connect(attestor3).submitAttestation(eventId, true, "uri");
      await attestorRegistry.connect(attestor4).submitAttestation(eventId, true, "uri");
      await attestorRegistry.connect(attestor5).submitAttestation(eventId, false, "uri");

      const poolBefore = await attestorRegistry.rewardPool();

      await attestorRegistry.connect(admin).finalizeEventConsensus(eventId);

      const poolAfter = await attestorRegistry.rewardPool();
      expect(poolAfter).to.be.gt(poolBefore);
    });

    /**
     * TEST: Consensus emits correct event
     * OUTCOME: ConsensusFinalized event should be emitted
     */
    it("Should emit ConsensusFinalized event", async function () {
      await attestorRegistry.connect(attestor1).submitAttestation(eventId, true, "uri");
      await attestorRegistry.connect(attestor2).submitAttestation(eventId, true, "uri");
      await attestorRegistry.connect(attestor3).submitAttestation(eventId, true, "uri");
      await attestorRegistry.connect(attestor4).submitAttestation(eventId, true, "uri");
      await attestorRegistry.connect(attestor5).submitAttestation(eventId, true, "uri");

      await expect(
        attestorRegistry.connect(admin).finalizeEventConsensus(eventId)
      )
        .to.emit(attestorRegistry, "ConsensusFinalized")
        .withArgs(eventId, true);
    });

    /**
     * TEST: Only admin or governance can finalize
     * OUTCOME: Other addresses should be rejected
     */
    it("Should reject finalization from unauthorized address", async function () {
      await attestorRegistry.connect(attestor1).submitAttestation(eventId, true, "uri");
      await attestorRegistry.connect(attestor2).submitAttestation(eventId, true, "uri");
      await attestorRegistry.connect(attestor3).submitAttestation(eventId, true, "uri");
      await attestorRegistry.connect(attestor4).submitAttestation(eventId, true, "uri");
      await attestorRegistry.connect(attestor5).submitAttestation(eventId, true, "uri");

      await expect(
        attestorRegistry.connect(other).finalizeEventConsensus(eventId)
      ).to.be.revertedWith("Not authorized");
    });

    /**
     * TEST: Governance can finalize consensus
     * OUTCOME: Should succeed with governance address
     */
    it("Should allow governance to finalize consensus", async function () {
      await attestorRegistry.connect(attestor1).submitAttestation(eventId, true, "uri");
      await attestorRegistry.connect(attestor2).submitAttestation(eventId, true, "uri");
      await attestorRegistry.connect(attestor3).submitAttestation(eventId, true, "uri");
      await attestorRegistry.connect(attestor4).submitAttestation(eventId, true, "uri");
      await attestorRegistry.connect(attestor5).submitAttestation(eventId, true, "uri");

      await expect(
        attestorRegistry.connect(governance).finalizeEventConsensus(eventId)
      ).to.not.be.reverted;
    });
  });

  describe("Manual Slashing with SGD", function () {
    beforeEach(async function () {
      await sgdToken.connect(attestor1).approve(
        await attestorRegistry.getAddress(),
        ethers.parseEther("2000")
      );
      await attestorRegistry.connect(attestor1).registerAsAttestor(
        ethers.parseEther("2000")
      );
    });

    /**
     * TEST: Admin can manually slash attestor
     * OUTCOME: Stake and reputation should decrease
     */
    it("Should allow admin to manually slash attestor", async function () {
      const penalty = ethers.parseEther("500");
      const stakeBefore = await stakingContract.getStake(attestor1.address);

      await expect(
        attestorRegistry.connect(admin).manualSlash(
          attestor1.address,
          penalty,
          "Manual penalty"
        )
      )
        .to.emit(attestorRegistry, "AttestorSlashed")
        .withArgs(attestor1.address, penalty, "Manual penalty");

      const stakeAfter = await stakingContract.getStake(attestor1.address);
      expect(stakeAfter).to.equal(stakeBefore - penalty);
    });

    /**
     * TEST: Governance can manually slash attestor
     * OUTCOME: Should succeed
     */
    it("Should allow governance to manually slash attestor", async function () {
      await attestorRegistry.connect(governance).manualSlash(
        attestor1.address,
        ethers.parseEther("500"),
        "DAO decision"
      );
    });

    /**
     * TEST: Cannot slash unregistered attestor
     * OUTCOME: Should revert
     */
    it("Should reject slashing unregistered attestor", async function () {
      await expect(
        attestorRegistry.connect(admin).manualSlash(
          other.address,
          ethers.parseEther("500"),
          "Reason"
        )
      ).to.be.revertedWith("Not registered");
    });

    /**
     * TEST: Non-admin/governance cannot slash
     * OUTCOME: Should revert
     */
    it("Should reject manual slash from unauthorized", async function () {
      await expect(
        attestorRegistry.connect(other).manualSlash(
          attestor1.address,
          ethers.parseEther("500"),
          "Reason"
        )
      ).to.be.revertedWith("Not authorized");
    });

    /**
     * TEST: Slashed funds go to reward pool
     * OUTCOME: Reward pool should increase
     */
    it("Should add slashed funds to reward pool", async function () {
      const poolBefore = await attestorRegistry.rewardPool();
      
      await attestorRegistry.connect(admin).manualSlash(
        attestor1.address,
        ethers.parseEther("500"),
        "Penalty"
      );

      const poolAfter = await attestorRegistry.rewardPool();
      expect(poolAfter).to.be.gt(poolBefore);
    });
  });

  describe("Reward Pool with SGD", function () {
    /**
     * TEST: Can fund reward pool with SGD tokens
     * OUTCOME: Pool balance should increase
     */
    it("Should allow funding reward pool with SGD", async function () {
      const fundAmount = ethers.parseEther("5000");

      // Approve registry to spend SGD
      await sgdToken.connect(admin).approve(
        await attestorRegistry.getAddress(),
        fundAmount
      );

      await expect(
        attestorRegistry.connect(admin).fundRewardPool(fundAmount)
      )
        .to.emit(attestorRegistry, "RewardPoolFunded")
        .withArgs(fundAmount);

      expect(await attestorRegistry.rewardPool()).to.equal(fundAmount);
    });

    /**
     * TEST: Funding requires SGD approval
     * OUTCOME: Should revert without approval
     */
    it("Should reject funding without SGD approval", async function () {
      const fundAmount = ethers.parseEther("5000");

      await expect(
        attestorRegistry.connect(admin).fundRewardPool(fundAmount)
      ).to.be.revertedWith("SGD transfer failed");
    });

    /**
     * TEST: Cannot fund with zero amount
     * OUTCOME: Should revert
     */
    it("Should reject funding with zero amount", async function () {
      await expect(
        attestorRegistry.connect(admin).fundRewardPool(0)
      ).to.be.revertedWith("Must send SGD");
    });

    /**
     * TEST: Anyone can fund the reward pool
     * OUTCOME: Non-admin addresses can fund
     */
    it("Should allow anyone to fund reward pool", async function () {
      const fundAmount = ethers.parseEther("1000");

      await sgdToken.connect(attestor1).approve(
        await attestorRegistry.getAddress(),
        fundAmount
      );

      await expect(
        attestorRegistry.connect(attestor1).fundRewardPool(fundAmount)
      ).to.not.be.reverted;
    });
  });

  describe("Parameter Updates", function () {
    /**
     * TEST: Admin can update parameters
     * OUTCOME: Parameters should be updated
     */
    it("Should allow admin to update parameters", async function () {
      const newMinRep = 75;
      const newMaxRep = 1200;
      const newSlash = ethers.parseEther("1000");
      const newReward = ethers.parseEther("200");

      await expect(
        attestorRegistry.connect(admin).updateParameters(
          newMinRep, 
          newMaxRep, 
          newSlash, 
          newReward
        )
      )
        .to.emit(attestorRegistry, "ParametersUpdated");

      expect(await attestorRegistry.minReputation()).to.equal(newMinRep);
      expect(await attestorRegistry.maxReputation()).to.equal(newMaxRep);
      expect(await attestorRegistry.slashPenalty()).to.equal(newSlash);
      expect(await attestorRegistry.rewardAmount()).to.equal(newReward);
    });

    /**
     * TEST: Governance can update parameters
     * OUTCOME: Should succeed
     */
    it("Should allow governance to update parameters", async function () {
      await attestorRegistry.connect(governance).updateParameters(
        60, 
        1000,
        ethers.parseEther("750"), 
        ethers.parseEther("150")
      );
    });

    /**
     * TEST: Cannot set invalid reputation range
     * OUTCOME: Should revert
     */
    it("Should reject invalid reputation range", async function () {
      await expect(
        attestorRegistry.connect(admin).updateParameters(
          100, // minRep
          50,  // maxRep (less than min)
          ethers.parseEther("500"),
          ethers.parseEther("100")
        )
      ).to.be.revertedWith("Invalid reputation range");
    });

    /**
     * TEST: Non-admin/governance cannot update parameters
     * OUTCOME: Should revert
     */
    it("Should reject parameter updates from unauthorized", async function () {
      await expect(
        attestorRegistry.connect(other).updateParameters(
          60, 
          1000,
          ethers.parseEther("1000"), 
          ethers.parseEther("200")
        )
      ).to.be.revertedWith("Not authorized");
    });
  });

  describe("Governance Functions", function () {
    /**
     * TEST: Admin can set governance address
     * OUTCOME: Governance address should be updated
     */
    it("Should allow admin to set governance", async function () {
      const newGovernance = other.address;

      await expect(
        attestorRegistry.connect(admin).setGovernance(newGovernance)
      )
        .to.emit(attestorRegistry, "GovernanceSet")
        .withArgs(newGovernance);

      expect(await attestorRegistry.governance()).to.equal(newGovernance);
    });

    /**
     * TEST: Cannot set zero address as governance
     * OUTCOME: Should revert
     */
    it("Should reject zero address for governance", async function () {
      await expect(
        attestorRegistry.connect(admin).setGovernance(ethers.ZeroAddress)
      ).to.be.revertedWith("Invalid address");
    });

    /**
     * TEST: Admin can transfer admin rights
     * OUTCOME: New admin should be set
     */
    it("Should allow admin to transfer admin rights", async function () {
      await expect(
        attestorRegistry.connect(admin).transferAdmin(other.address)
      )
        .to.emit(attestorRegistry, "AdminTransferred")
        .withArgs(other.address);

      expect(await attestorRegistry.admin()).to.equal(other.address);
    });

    /**
     * TEST: Non-admin cannot set governance
     * OUTCOME: Should revert
     */
    it("Should reject setting governance from non-admin", async function () {
      await expect(
        attestorRegistry.connect(other).setGovernance(attestor1.address)
      ).to.be.revertedWith("Not authorized");
    });

    /**
     * TEST: Admin can update staking contract
     * OUTCOME: Staking contract address should be updated
     */
    it("Should allow admin to update staking contract", async function () {
      const newStaking = other.address;
      
      await attestorRegistry.connect(admin).updateStakingContract(newStaking);
      
      expect(await attestorRegistry.stakingContract()).to.equal(newStaking);
    });

    /**
     * TEST: Admin can update attestation manager
     * OUTCOME: Attestation manager address should be updated
     */
    it("Should allow admin to update attestation manager", async function () {
      const newManager = other.address;
      
      await attestorRegistry.connect(admin).updateAttestationManager(newManager);
      
      expect(await attestorRegistry.attestationManager()).to.equal(newManager);
    });
  });

  describe("View Functions", function () {
    beforeEach(async function () {
      await sgdToken.connect(attestor1).approve(
        await attestorRegistry.getAddress(),
        ethers.parseEther("2000")
      );
      await attestorRegistry.connect(attestor1).registerAsAttestor(
        ethers.parseEther("2000")
      );
    });

    /**
     * TEST: Get attestor complete data
     * OUTCOME: Should return all attestor information
     */
    it("Should return complete attestor data", async function () {
      const data = await attestorRegistry.getAttestor(attestor1.address);
      
      expect(data.attestorAddress).to.equal(attestor1.address);
      expect(data.isActive).to.be.true;
      expect(data.reputation).to.equal(100);
      expect(data.stake).to.equal(ethers.parseEther("2000"));
    });

    /**
     * TEST: Get attestor reputation
     * OUTCOME: Should return correct reputation value
     */
    it("Should return attestor reputation", async function () {
      expect(await attestorRegistry.getReputation(attestor1.address)).to.equal(100);
    });

    /**
     * TEST: Get attestor accuracy
     * OUTCOME: Should return accuracy percentage
     */
    it("Should return attestor accuracy", async function () {
      // Initially 0 attestations
      expect(await attestorRegistry.getAccuracy(attestor1.address)).to.equal(0);
    });

    /**
     * TEST: Get consensus status
     * OUTCOME: Should return consensus details for event
     */
    it("Should return consensus status for event", async function () {
      const eventId = 1;
      
      // Open window and submit attestations
      await attestationManager.connect(admin).openAttestationWindow(eventId, 3, 0);
      await attestorRegistry.connect(attestor1).submitAttestation(eventId, true, "uri");
      
      const status = await attestorRegistry.getConsensusStatus(eventId);
      expect(status.total).to.equal(1);
    });

    /**
     * TEST: Get event attestations
     * OUTCOME: Should return all attestations for event
     */
    it("Should return event attestations", async function () {
      const eventId = 1;
      
      await attestationManager.connect(admin).openAttestationWindow(eventId, 3, 0);
      await attestorRegistry.connect(attestor1).submitAttestation(eventId, true, "uri");
      
      const attestations = await attestorRegistry.getEventAttestations(eventId);
      expect(attestations.length).to.equal(1);
      expect(attestations[0].attestor).to.equal(attestor1.address);
    });
  });

  describe("Reputation Cap Enforcement", function () {
    beforeEach(async function () {
      await sgdToken.connect(attestor1).approve(
        await attestorRegistry.getAddress(),
        ethers.parseEther("2000")
      );
      await attestorRegistry.connect(attestor1).registerAsAttestor(
        ethers.parseEther("2000")
      );
    });

    /**
     * TEST: Reputation is capped at maximum
     * OUTCOME: Reputation should not exceed maxReputation
     */
    it("Should cap reputation at maximum value", async function () {
      // Update max reputation
      await attestorRegistry.connect(admin).updateParameters(
        50, 
        500, // Lower max
        ethers.parseEther("500"), 
        ethers.parseEther("100")
      );

      const maxRep = await attestorRegistry.maxReputation();
      
      // Check that getAttestor caps the reputation
      const data = await attestorRegistry.getAttestor(attestor1.address);
      expect(data.reputation).to.be.lte(maxRep);
    });

    /**
     * TEST: getAttestor returns capped reputation
     * OUTCOME: Should return min(reputation, maxReputation)
     */
    it("Should return capped reputation in getAttestor", async function () {
      // Set a very low max reputation
      await attestorRegistry.connect(admin).updateParameters(
        50, 
        80, 
        ethers.parseEther("500"), 
        ethers.parseEther("100")
      );

      const data = await attestorRegistry.getAttestor(attestor1.address);
      expect(data.reputation).to.equal(80); // Capped at 80, not 100
    });
  });
});