const { expect } = require("chai");
const { ethers } = require("hardhat");

/**
 * TEST SUITE: AttestorLib Library
 * 
 * This test suite validates the AttestorLib library functions including:
 * - Attestor initialization
 * - Activation/deactivation
 * - Reputation management with caps
 * - Attestation tracking
 * - Accuracy calculations
 * 
 * Note: Since AttestorLib is a library, we test it through a mock contract
 * that uses the library functions.
 */
describe("AttestorLib", function () {
  let attestorLibTest;
  let owner, addr1, addr2;

  // Deploy a test contract that uses AttestorLib
  before(async function () {
    [owner, addr1, addr2] = await ethers.getSigners();

    // Create a test contract that exposes AttestorLib functions
    const AttestorLibTest = await ethers.getContractFactory("AttestorLibTest");
    attestorLibTest = await AttestorLibTest.deploy();
    await attestorLibTest.waitForDeployment();
  });

  describe("Attestor Initialization", function () {
    /**
     * TEST: Initialize creates attestor with default values
     * OUTCOME: Attestor should have correct initial state
     */
    it("Should initialize attestor with correct default values", async function () {
      await attestorLibTest.initializeAttestor(addr1.address);

      const attestor = await attestorLibTest.getAttestor(addr1.address);
      
      expect(attestor.attestorAddress).to.equal(addr1.address);
      expect(attestor.isActive).to.be.true;
      expect(attestor.reputation).to.equal(100); // Initial reputation
      expect(attestor.totalAttestations).to.equal(0);
      expect(attestor.successfulAttestations).to.equal(0);
    });

    /**
     * TEST: Last attestation timestamp is set on initialization
     * OUTCOME: lastAttestation should be current block timestamp
     */
    it("Should set lastAttestation timestamp on initialization", async function () {
      const tx = await attestorLibTest.initializeAttestor(addr2.address);
      const receipt = await tx.wait();
      const block = await ethers.provider.getBlock(receipt.blockNumber);

      const attestor = await attestorLibTest.getAttestor(addr2.address);
      expect(attestor.lastAttestation).to.equal(block.timestamp);
    });
  });

  describe("Activation and Deactivation", function () {
    beforeEach(async function () {
      await attestorLibTest.initializeAttestor(addr1.address);
    });

    /**
     * TEST: Deactivate sets isActive to false
     * OUTCOME: Attestor should become inactive
     */
    it("Should deactivate attestor", async function () {
      await attestorLibTest.deactivateAttestor(addr1.address);

      const attestor = await attestorLibTest.getAttestor(addr1.address);
      expect(attestor.isActive).to.be.false;
    });

    /**
     * TEST: Activate sets isActive to true
     * OUTCOME: Attestor should become active
     */
    it("Should activate attestor", async function () {
      await attestorLibTest.deactivateAttestor(addr1.address);
      await attestorLibTest.activateAttestor(addr1.address);

      const attestor = await attestorLibTest.getAttestor(addr1.address);
      expect(attestor.isActive).to.be.true;
    });

    /**
     * TEST: Can toggle activation status multiple times
     * OUTCOME: Status should change with each call
     */
    it("Should allow multiple activation toggles", async function () {
      const attestor1 = await attestorLibTest.getAttestor(addr1.address);
      expect(attestor1.isActive).to.be.true;

      await attestorLibTest.deactivateAttestor(addr1.address);
      const attestor2 = await attestorLibTest.getAttestor(addr1.address);
      expect(attestor2.isActive).to.be.false;

      await attestorLibTest.activateAttestor(addr1.address);
      const attestor3 = await attestorLibTest.getAttestor(addr1.address);
      expect(attestor3.isActive).to.be.true;
    });
  });

  describe("Reputation Management", function () {
    beforeEach(async function () {
      await attestorLibTest.initializeAttestor(addr1.address);
    });

    /**
     * TEST: Increase reputation adds to current value
     * OUTCOME: Reputation should increase by specified amount
     */
    it("Should increase reputation correctly", async function () {
      const initialRep = await attestorLibTest.getReputationValue(addr1.address);
      const increaseAmount = 50;

      await attestorLibTest.increaseReputationBy(addr1.address, increaseAmount);

      const newRep = await attestorLibTest.getReputationValue(addr1.address);
      expect(newRep).to.equal(initialRep + BigInt(increaseAmount));
    });

    /**
     * TEST: Reputation is capped at 1000
     * OUTCOME: Reputation should not exceed 1000
     */
    it("Should cap reputation at 1000", async function () {
      // Increase reputation beyond cap
      await attestorLibTest.increaseReputationBy(addr1.address, 1000);

      const reputation = await attestorLibTest.getReputationValue(addr1.address);
      expect(reputation).to.equal(1000);
    });

    /**
     * TEST: Multiple small increases respect cap
     * OUTCOME: Final reputation should be 1000
     */
    it("Should respect cap with multiple increases", async function () {
      await attestorLibTest.increaseReputationBy(addr1.address, 500);
      await attestorLibTest.increaseReputationBy(addr1.address, 500);
      await attestorLibTest.increaseReputationBy(addr1.address, 500);

      const reputation = await attestorLibTest.getReputationValue(addr1.address);
      expect(reputation).to.equal(1000);
    });

    /**
     * TEST: Decrease reputation subtracts from current value
     * OUTCOME: Reputation should decrease by specified amount
     */
    it("Should decrease reputation correctly", async function () {
      const initialRep = await attestorLibTest.getReputationValue(addr1.address);
      const decreaseAmount = 30;

      await attestorLibTest.decreaseReputationBy(addr1.address, decreaseAmount);

      const newRep = await attestorLibTest.getReputationValue(addr1.address);
      expect(newRep).to.equal(initialRep - BigInt(decreaseAmount));
    });

    /**
     * TEST: Reputation cannot go below zero
     * OUTCOME: Reputation should be 0, not negative
     */
    it("Should floor reputation at 0", async function () {
      // Decrease by more than current reputation
      await attestorLibTest.decreaseReputationBy(addr1.address, 200);

      const reputation = await attestorLibTest.getReputationValue(addr1.address);
      expect(reputation).to.equal(0);
    });

    /**
     * TEST: Exact decrease to zero works correctly
     * OUTCOME: Reputation should be exactly 0
     */
    it("Should handle exact decrease to zero", async function () {
      const currentRep = await attestorLibTest.getReputationValue(addr1.address);
      
      await attestorLibTest.decreaseReputationBy(addr1.address, Number(currentRep));

      const reputation = await attestorLibTest.getReputationValue(addr1.address);
      expect(reputation).to.equal(0);
    });

    /**
     * TEST: getReputation returns current reputation
     * OUTCOME: Should return the reputation value
     */
    it("Should return reputation via getReputation", async function () {
      const reputation = await attestorLibTest.getReputationValue(addr1.address);
      expect(reputation).to.equal(100); // Initial value
    });
  });

  describe("Attestation Recording", function () {
    beforeEach(async function () {
      await attestorLibTest.initializeAttestor(addr1.address);
    });

    /**
     * TEST: Recording successful attestation updates counters
     * OUTCOME: Total and successful attestations should increase
     */
    it("Should record successful attestation", async function () {
      const initialTotal = await attestorLibTest.getTotalAttestations(addr1.address);
      const initialSuccessful = await attestorLibTest.getSuccessfulAttestations(addr1.address);
      const initialRep = await attestorLibTest.getReputationValue(addr1.address);

      await attestorLibTest.recordAttestationFor(addr1.address, true);

      const newTotal = await attestorLibTest.getTotalAttestations(addr1.address);
      const newSuccessful = await attestorLibTest.getSuccessfulAttestations(addr1.address);
      const newRep = await attestorLibTest.getReputationValue(addr1.address);

      expect(newTotal).to.equal(initialTotal + 1n);
      expect(newSuccessful).to.equal(initialSuccessful + 1n);
      expect(newRep).to.equal(initialRep + 10n); // +10 reputation for success
    });

    /**
     * TEST: Recording failed attestation updates counters
     * OUTCOME: Only total attestations increase, reputation decreases
     */
    it("Should record failed attestation", async function () {
      const initialTotal = await attestorLibTest.getTotalAttestations(addr1.address);
      const initialSuccessful = await attestorLibTest.getSuccessfulAttestations(addr1.address);
      const initialRep = await attestorLibTest.getReputationValue(addr1.address);

      await attestorLibTest.recordAttestationFor(addr1.address, false);

      const newTotal = await attestorLibTest.getTotalAttestations(addr1.address);
      const newSuccessful = await attestorLibTest.getSuccessfulAttestations(addr1.address);
      const newRep = await attestorLibTest.getReputationValue(addr1.address);

      expect(newTotal).to.equal(initialTotal + 1n);
      expect(newSuccessful).to.equal(initialSuccessful); // No change
      expect(newRep).to.equal(initialRep - 20n); // -20 reputation for failure
    });

    /**
     * TEST: Multiple attestations accumulate correctly
     * OUTCOME: Counters should reflect all attestations
     */
    it("Should accumulate multiple attestations", async function () {
      await attestorLibTest.recordAttestationFor(addr1.address, true);
      await attestorLibTest.recordAttestationFor(addr1.address, true);
      await attestorLibTest.recordAttestationFor(addr1.address, false);
      await attestorLibTest.recordAttestationFor(addr1.address, true);

      const total = await attestorLibTest.getTotalAttestations(addr1.address);
      const successful = await attestorLibTest.getSuccessfulAttestations(addr1.address);

      expect(total).to.equal(4);
      expect(successful).to.equal(3);
    });

    /**
     * TEST: lastAttestation timestamp updates
     * OUTCOME: Timestamp should be updated to current block
     */
    it("Should update lastAttestation timestamp", async function () {
      const tx = await attestorLibTest.recordAttestationFor(addr1.address, true);
      const receipt = await tx.wait();
      const block = await ethers.provider.getBlock(receipt.blockNumber);

      const attestor = await attestorLibTest.getAttestor(addr1.address);
      expect(attestor.lastAttestation).to.equal(block.timestamp);
    });

    /**
     * TEST: Successful attestation increases reputation by 10
     * OUTCOME: Reputation should increase by exactly 10
     */
    it("Should increase reputation by 10 for successful attestation", async function () {
      const repBefore = await attestorLibTest.getReputationValue(addr1.address);
      
      await attestorLibTest.recordAttestationFor(addr1.address, true);
      
      const repAfter = await attestorLibTest.getReputationValue(addr1.address);
      expect(repAfter).to.equal(repBefore + 10n);
    });

    /**
     * TEST: Failed attestation decreases reputation by 20
     * OUTCOME: Reputation should decrease by exactly 20
     */
    it("Should decrease reputation by 20 for failed attestation", async function () {
      const repBefore = await attestorLibTest.getReputationValue(addr1.address);
      
      await attestorLibTest.recordAttestationFor(addr1.address, false);
      
      const repAfter = await attestorLibTest.getReputationValue(addr1.address);
      expect(repAfter).to.equal(repBefore - 20n);
    });
  });

  describe("Accuracy Calculation", function () {
    beforeEach(async function () {
      await attestorLibTest.initializeAttestor(addr1.address);
    });

    /**
     * TEST: Accuracy is 0 with no attestations
     * OUTCOME: Should return 0
     */
    it("Should return 0 accuracy with no attestations", async function () {
      const accuracy = await attestorLibTest.getAccuracyValue(addr1.address);
      expect(accuracy).to.equal(0);
    });

    /**
     * TEST: Accuracy is 100 with all successful attestations
     * OUTCOME: Should return 100
     */
    it("Should return 100% accuracy with all successful", async function () {
      await attestorLibTest.recordAttestationFor(addr1.address, true);
      await attestorLibTest.recordAttestationFor(addr1.address, true);
      await attestorLibTest.recordAttestationFor(addr1.address, true);

      const accuracy = await attestorLibTest.getAccuracyValue(addr1.address);
      expect(accuracy).to.equal(100);
    });

    /**
     * TEST: Accuracy is 0 with all failed attestations
     * OUTCOME: Should return 0
     */
    it("Should return 0% accuracy with all failed", async function () {
      await attestorLibTest.recordAttestationFor(addr1.address, false);
      await attestorLibTest.recordAttestationFor(addr1.address, false);
      await attestorLibTest.recordAttestationFor(addr1.address, false);

      const accuracy = await attestorLibTest.getAccuracyValue(addr1.address);
      expect(accuracy).to.equal(0);
    });

    /**
     * TEST: Accuracy calculates correctly for mixed results
     * OUTCOME: Should return correct percentage (66% for 2/3)
     */
    it("Should calculate accuracy correctly for mixed results", async function () {
      await attestorLibTest.recordAttestationFor(addr1.address, true);
      await attestorLibTest.recordAttestationFor(addr1.address, true);
      await attestorLibTest.recordAttestationFor(addr1.address, false);

      const accuracy = await attestorLibTest.getAccuracyValue(addr1.address);
      expect(accuracy).to.equal(66); // 2/3 = 66%
    });

    /**
     * TEST: Accuracy for 50% success rate
     * OUTCOME: Should return 50
     */
    it("Should return 50% accuracy for half successful", async function () {
      await attestorLibTest.recordAttestationFor(addr1.address, true);
      await attestorLibTest.recordAttestationFor(addr1.address, false);

      const accuracy = await attestorLibTest.getAccuracyValue(addr1.address);
      expect(accuracy).to.equal(50);
    });

    /**
     * TEST: Accuracy for 75% success rate
     * OUTCOME: Should return 75
     */
    it("Should return 75% accuracy for 3/4 successful", async function () {
      await attestorLibTest.recordAttestationFor(addr1.address, true);
      await attestorLibTest.recordAttestationFor(addr1.address, true);
      await attestorLibTest.recordAttestationFor(addr1.address, true);
      await attestorLibTest.recordAttestationFor(addr1.address, false);

      const accuracy = await attestorLibTest.getAccuracyValue(addr1.address);
      expect(accuracy).to.equal(75);
    });

    /**
     * TEST: Accuracy for 80% success rate
     * OUTCOME: Should return 80
     */
    it("Should return 80% accuracy for 4/5 successful", async function () {
      for (let i = 0; i < 4; i++) {
        await attestorLibTest.recordAttestationFor(addr1.address, true);
      }
      await attestorLibTest.recordAttestationFor(addr1.address, false);

      const accuracy = await attestorLibTest.getAccuracyValue(addr1.address);
      expect(accuracy).to.equal(80);
    });
  });

  describe("Reputation with Attestation Tracking", function () {
    beforeEach(async function () {
      await attestorLibTest.initializeAttestor(addr1.address);
    });

    /**
     * TEST: Reputation caps at 1000 even with successful attestations
     * OUTCOME: Should not exceed 1000
     */
    it("Should cap reputation at 1000 with successful attestations", async function () {
      // Record 100 successful attestations (100 + 100*10 = 1100, capped at 1000)
      for (let i = 0; i < 100; i++) {
        await attestorLibTest.recordAttestationFor(addr1.address, true);
      }

      const reputation = await attestorLibTest.getReputationValue(addr1.address);
      expect(reputation).to.equal(1000);
    });

    /**
     * TEST: Reputation floors at 0 with failed attestations
     * OUTCOME: Should not go negative
     */
    it("Should floor reputation at 0 with failed attestations", async function () {
      // Record 10 failed attestations (100 - 10*20 = -100, floored at 0)
      for (let i = 0; i < 10; i++) {
        await attestorLibTest.recordAttestationFor(addr1.address, false);
      }

      const reputation = await attestorLibTest.getReputationValue(addr1.address);
      expect(reputation).to.equal(0);
    });

    /**
     * TEST: Mixed attestations affect reputation correctly
     * OUTCOME: Net reputation change should be accurate
     */
    it("Should handle mixed attestations reputation changes", async function () {
      // Start: 100
      // +10 (true) = 110
      // +10 (true) = 120
      // -20 (false) = 100
      // +10 (true) = 110
      
      await attestorLibTest.recordAttestationFor(addr1.address, true);
      await attestorLibTest.recordAttestationFor(addr1.address, true);
      await attestorLibTest.recordAttestationFor(addr1.address, false);
      await attestorLibTest.recordAttestationFor(addr1.address, true);

      const reputation = await attestorLibTest.getReputationValue(addr1.address);
      expect(reputation).to.equal(110);
    });
  });

  describe("Complete Attestor Lifecycle", function () {
    /**
     * TEST: Full attestor lifecycle from init to deactivation
     * OUTCOME: All state transitions should work correctly
     */
    it("Should handle complete attestor lifecycle", async function () {
      // Initialize
      await attestorLibTest.initializeAttestor(addr1.address);
      let attestor = await attestorLibTest.getAttestor(addr1.address);
      expect(attestor.isActive).to.be.true;
      expect(attestor.reputation).to.equal(100);

      // Record some attestations
      await attestorLibTest.recordAttestationFor(addr1.address, true);
      await attestorLibTest.recordAttestationFor(addr1.address, true);
      await attestorLibTest.recordAttestationFor(addr1.address, false);

      attestor = await attestorLibTest.getAttestor(addr1.address);
      expect(attestor.totalAttestations).to.equal(3);
      expect(attestor.successfulAttestations).to.equal(2);

      // Deactivate
      await attestorLibTest.deactivateAttestor(addr1.address);
      attestor = await attestorLibTest.getAttestor(addr1.address);
      expect(attestor.isActive).to.be.false;

      // Reactivate
      await attestorLibTest.activateAttestor(addr1.address);
      attestor = await attestorLibTest.getAttestor(addr1.address);
      expect(attestor.isActive).to.be.true;
    });

    /**
     * TEST: Multiple attestors can be managed independently
     * OUTCOME: Each attestor maintains separate state
     */
    it("Should manage multiple attestors independently", async function () {
      // Initialize two attestors
      await attestorLibTest.initializeAttestor(addr1.address);
      await attestorLibTest.initializeAttestor(addr2.address);

      // Record different attestations
      await attestorLibTest.recordAttestationFor(addr1.address, true);
      await attestorLibTest.recordAttestationFor(addr1.address, true);
      await attestorLibTest.recordAttestationFor(addr2.address, false);

      // Verify independent state
      const attestor1 = await attestorLibTest.getAttestor(addr1.address);
      const attestor2 = await attestorLibTest.getAttestor(addr2.address);

      expect(attestor1.totalAttestations).to.equal(2);
      expect(attestor1.successfulAttestations).to.equal(2);
      expect(attestor2.totalAttestations).to.equal(1);
      expect(attestor2.successfulAttestations).to.equal(0);

      // Verify independent reputation
      expect(attestor1.reputation).to.be.gt(attestor2.reputation);
    });
  });

  describe("Edge Cases", function () {
    beforeEach(async function () {
      await attestorLibTest.initializeAttestor(addr1.address);
    });

    /**
     * TEST: Rapidly alternating success/failure
     * OUTCOME: All attestations should be recorded correctly
     */
    it("Should handle rapid attestation recording", async function () {
      for (let i = 0; i < 10; i++) {
        await attestorLibTest.recordAttestationFor(addr1.address, i % 2 === 0);
      }

      const total = await attestorLibTest.getTotalAttestations(addr1.address);
      const successful = await attestorLibTest.getSuccessfulAttestations(addr1.address);

      expect(total).to.equal(10);
      expect(successful).to.equal(5);
    });

    /**
     * TEST: Large reputation increases
     * OUTCOME: Should handle large values and cap correctly
     */
    it("Should handle large reputation increases", async function () {
      await attestorLibTest.increaseReputationBy(addr1.address, 5000);

      const reputation = await attestorLibTest.getReputationValue(addr1.address);
      expect(reputation).to.equal(1000); // Capped
    });

    /**
     * TEST: Large reputation decreases
     * OUTCOME: Should handle large values and floor correctly
     */
    it("Should handle large reputation decreases", async function () {
      await attestorLibTest.decreaseReputationBy(addr1.address, 5000);

      const reputation = await attestorLibTest.getReputationValue(addr1.address);
      expect(reputation).to.equal(0); // Floored
    });

    /**
     * TEST: Reputation exactly at boundaries
     * OUTCOME: Should handle boundary values correctly
     */
    it("Should handle reputation at exact boundaries", async function () {
      // Increase to exactly 1000
      await attestorLibTest.increaseReputationBy(addr1.address, 900);
      let reputation = await attestorLibTest.getReputationValue(addr1.address);
      expect(reputation).to.equal(1000);

      // Decrease to exactly 0
      await attestorLibTest.decreaseReputationBy(addr1.address, 1000);
      reputation = await attestorLibTest.getReputationValue(addr1.address);
      expect(reputation).to.equal(0);
    });

    /**
     * TEST: Zero attestations accuracy edge case
     * OUTCOME: Should return 0 without division by zero
     */
    it("Should handle zero attestations gracefully", async function () {
      const accuracy = await attestorLibTest.getAccuracyValue(addr1.address);
      expect(accuracy).to.equal(0);
    });

    /**
     * TEST: Single failed attestation accuracy
     * OUTCOME: Should return 0% accurately
     */
    it("Should calculate 0% accuracy with single failure", async function () {
      await attestorLibTest.recordAttestationFor(addr1.address, false);
      
      const accuracy = await attestorLibTest.getAccuracyValue(addr1.address);
      expect(accuracy).to.equal(0);
    });

    /**
     * TEST: Single successful attestation accuracy
     * OUTCOME: Should return 100% accurately
     */
    it("Should calculate 100% accuracy with single success", async function () {
      await attestorLibTest.recordAttestationFor(addr1.address, true);
      
      const accuracy = await attestorLibTest.getAccuracyValue(addr1.address);
      expect(accuracy).to.equal(100);
    });
  });
});
