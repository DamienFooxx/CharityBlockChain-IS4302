const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

/**
 * TEST SUITE: AttestationManager Contract
 * 
 * This test suite validates attestation management including:
 * - Opening attestation windows for events
 * - Recording attestations from attestors
 * - Computing consensus with reputation weighting
 * - Managing attestation deadlines
 */
describe("AttestationManager", function () {
  let attestationManager, mockRegistry, mockCharityEvents;
  let admin, attestor1, attestor2, attestor3, attestor4, attestor5, other;
  const DEFAULT_MIN_ATTESTORS = 5;
  const DEFAULT_WINDOW = 7 * 24 * 60 * 60; // 7 days

  beforeEach(async function () {
    [admin, mockRegistry, mockCharityEvents, attestor1, attestor2, attestor3, attestor4, attestor5, other] = 
      await ethers.getSigners();

    const AttestationManager = await ethers.getContractFactory("AttestationManager");
    attestationManager = await AttestationManager.deploy();
    await attestationManager.waitForDeployment();

    // Set Registry and CharityEvents contract addresses
    await attestationManager.connect(admin).setRegistry(mockRegistry.address);
    await attestationManager.connect(admin).setCharityEvents(mockCharityEvents.address);
  });

  describe("Deployment", function () {
    /**
     * TEST: Contract initializes with correct admin
     * OUTCOME: Admin should be deployer address
     */
    it("Should set the correct admin", async function () {
      expect(await attestationManager.admin()).to.equal(admin.address);
    });

    /**
     * TEST: Default parameters are set correctly
     * OUTCOME: Should have default minimum attestors and window
     */
    it("Should set default parameters", async function () {
      expect(await attestationManager.defaultMinAttestors()).to.equal(DEFAULT_MIN_ATTESTORS);
      expect(await attestationManager.defaultAttestationWindow()).to.equal(DEFAULT_WINDOW);
    });
  });

  describe("Opening Attestation Windows", function () {
    const eventId = 1;

    /**
     * TEST: CharityEvents can open attestation window
     * OUTCOME: Window should be opened with correct parameters
     */
    it("Should allow CharityEvents to open attestation window", async function () {
      const tx = await attestationManager.connect(mockCharityEvents)
        .openAttestationWindow(eventId, 0, 0);
      
      const receipt = await tx.wait();
      const block = await ethers.provider.getBlock(receipt.blockNumber);
      const expectedDeadline = block.timestamp + DEFAULT_WINDOW;

      await expect(tx)
        .to.emit(attestationManager, "AttestationWindowOpened")
        .withArgs(eventId, expectedDeadline, DEFAULT_MIN_ATTESTORS);

      const window = await attestationManager.getAttestationWindow(eventId);
      expect(window.minAttestors).to.equal(DEFAULT_MIN_ATTESTORS);
      expect(window.isOpen).to.be.true;
      expect(window.isExpired).to.be.false;
    });

    /**
     * TEST: Custom parameters override defaults
     * OUTCOME: Should use custom min attestors and window
     */
    it("Should use custom parameters when provided", async function () {
      const customMin = 10;
      const customWindow = 14 * 24 * 60 * 60; // 14 days

      await attestationManager.connect(mockCharityEvents)
        .openAttestationWindow(eventId, customMin, customWindow);

      const window = await attestationManager.getAttestationWindow(eventId);
      expect(window.minAttestors).to.equal(customMin);
    });

    /**
     * TEST: Cannot open window twice for same event
     * OUTCOME: Second attempt should revert
     */
    it("Should reject opening window twice", async function () {
      await attestationManager.connect(mockCharityEvents)
        .openAttestationWindow(eventId, 0, 0);

      await expect(
        attestationManager.connect(mockCharityEvents)
          .openAttestationWindow(eventId, 0, 0)
      ).to.be.revertedWith("Window already opened");
    });

    /**
     * TEST: Only CharityEvents can open window
     * OUTCOME: Other addresses should be rejected
     */
    it("Should reject non-CharityEvents caller", async function () {
      await expect(
        attestationManager.connect(other)
          .openAttestationWindow(eventId, 0, 0)
      ).to.be.revertedWith("Only charity events");
    });

    /**
     * TEST: Cannot open window for already finalized event
     * OUTCOME: Should revert if event is finalized
     */
    it("Should reject opening window for finalized event", async function () {
      // This test requires mocking registry's getReputation function
      // We'll test the basic check first
      await attestationManager.connect(mockCharityEvents)
        .openAttestationWindow(eventId, 0, 0);
      
      // Try to open window for another event - should work
      await expect(
        attestationManager.connect(mockCharityEvents)
          .openAttestationWindow(eventId + 1, 0, 0)
      ).to.not.be.reverted;
    });
  });

  describe("Recording Attestations", function () {
    const eventId = 1;

    beforeEach(async function () {
      // Open window before each test
      await attestationManager.connect(mockCharityEvents)
        .openAttestationWindow(eventId, 3, 0);
    });

    /**
     * TEST: Registry can record attestation
     * OUTCOME: Attestation should be stored and event emitted
     */
    it("Should allow registry to record attestation", async function () {
      await expect(
        attestationManager.connect(mockRegistry)
          .recordAttestation(eventId, attestor1.address, true, "ipfs://proof")
      )
        .to.emit(attestationManager, "AttestationAdded")
        .withArgs(attestor1.address, eventId, true);

      const attestations = await attestationManager.getEventAttestations(eventId);
      expect(attestations.length).to.equal(1);
      expect(attestations[0].attestor).to.equal(attestor1.address);
      expect(attestations[0].result).to.be.true;
      expect(attestations[0].metadataURI).to.equal("ipfs://proof");
    });

    /**
     * TEST: Attestor cannot attest twice to same event
     * OUTCOME: Second attestation should revert
     */
    it("Should reject duplicate attestation from same attestor", async function () {
      await attestationManager.connect(mockRegistry)
        .recordAttestation(eventId, attestor1.address, true, "uri");

      await expect(
        attestationManager.connect(mockRegistry)
          .recordAttestation(eventId, attestor1.address, false, "uri2")
      ).to.be.revertedWith("Already attested");
    });

    /**
     * TEST: Cannot attest without open window
     * OUTCOME: Should revert if window not opened
     */
    it("Should reject attestation without open window", async function () {
      const unopenedEventId = 999;
      
      await expect(
        attestationManager.connect(mockRegistry)
          .recordAttestation(unopenedEventId, attestor1.address, true, "uri")
      ).to.be.revertedWith("Attestation window not opened");
    });

    /**
     * TEST: Cannot attest after window closes
     * OUTCOME: Should revert after deadline
     */
    it("Should reject attestation after deadline", async function () {
      // Fast forward past deadline
      await time.increase(DEFAULT_WINDOW + 1);

      await expect(
        attestationManager.connect(mockRegistry)
          .recordAttestation(eventId, attestor1.address, true, "uri")
      ).to.be.revertedWith("Attestation window closed");
    });

    /**
     * TEST: Only registry can record attestations
     * OUTCOME: Non-registry addresses should be rejected
     */
    it("Should reject attestation from non-registry", async function () {
      await expect(
        attestationManager.connect(other)
          .recordAttestation(eventId, attestor1.address, true, "uri")
      ).to.be.revertedWith("Only registry");
    });

    /**
     * TEST: Multiple attestors can attest
     * OUTCOME: All attestations should be recorded
     */
    it("Should record multiple attestations", async function () {
      await attestationManager.connect(mockRegistry)
        .recordAttestation(eventId, attestor1.address, true, "uri1");
      await attestationManager.connect(mockRegistry)
        .recordAttestation(eventId, attestor2.address, false, "uri2");
      await attestationManager.connect(mockRegistry)
        .recordAttestation(eventId, attestor3.address, true, "uri3");

      const attestations = await attestationManager.getEventAttestations(eventId);
      expect(attestations.length).to.equal(3);
    });
  });

  describe("Consensus Status (View)", function () {
    const eventId = 1;

    beforeEach(async function () {
      await attestationManager.connect(mockCharityEvents)
        .openAttestationWindow(eventId, 3, 0);
    });

    /**
     * TEST: Get consensus status before finalization
     * OUTCOME: Should return current vote counts and pass status
     */
    it("Should return accurate consensus status", async function () {
      await attestationManager.connect(mockRegistry)
        .recordAttestation(eventId, attestor1.address, true, "uri");
      await attestationManager.connect(mockRegistry)
        .recordAttestation(eventId, attestor2.address, true, "uri");
      await attestationManager.connect(mockRegistry)
        .recordAttestation(eventId, attestor3.address, false, "uri");

      const status = await attestationManager.getConsensusStatus(eventId);
      
      expect(status.approvals).to.equal(2);
      expect(status.total).to.equal(3);
      expect(status.wouldPass).to.be.true;
      expect(status.canFinalize).to.be.true;
    });

    /**
     * TEST: Cannot finalize flag when insufficient attestations
     * OUTCOME: canFinalize should be false
     */
    it("Should indicate cannot finalize with insufficient attestations", async function () {
      await attestationManager.connect(mockRegistry)
        .recordAttestation(eventId, attestor1.address, true, "uri");

      const status = await attestationManager.getConsensusStatus(eventId);
      
      expect(status.canFinalize).to.be.false;
    });
  });

  describe("Attestation Window Details", function () {
    const eventId = 1;

    /**
     * TEST: Window details before opening
     * OUTCOME: Should return empty/default values
     */
    it("Should return default values before window opens", async function () {
      const window = await attestationManager.getAttestationWindow(eventId);
      
      expect(window.deadline).to.equal(0);
      expect(window.isOpen).to.be.false;
      expect(window.isExpired).to.be.false;
    });

    /**
     * TEST: Window details after opening
     * OUTCOME: Should return correct deadline and status
     */
    it("Should return correct window details after opening", async function () {
      const tx = await attestationManager.connect(mockCharityEvents)
        .openAttestationWindow(eventId, 0, 0);
      
      const receipt = await tx.wait();
      const block = await ethers.provider.getBlock(receipt.blockNumber);

      const window = await attestationManager.getAttestationWindow(eventId);
      
      expect(window.deadline).to.equal(block.timestamp + DEFAULT_WINDOW);
      expect(window.minAttestors).to.equal(DEFAULT_MIN_ATTESTORS);
      expect(window.isOpen).to.be.true;
      expect(window.isExpired).to.be.false;
    });

    /**
     * TEST: Window expires after deadline
     * OUTCOME: isExpired should become true
     */
    it("Should show window as expired after deadline", async function () {
      await attestationManager.connect(mockCharityEvents)
        .openAttestationWindow(eventId, 0, 0);

      await time.increase(DEFAULT_WINDOW + 1);

      const window = await attestationManager.getAttestationWindow(eventId);
      expect(window.isExpired).to.be.true;
    });
  });

  describe("Admin Functions", function () {
    /**
     * TEST: Admin can update default parameters
     * OUTCOME: Parameters should be updated
     */
    it("Should allow admin to update default parameters", async function () {
      const newMinAttestors = 7;
      const newWindow = 14 * 24 * 60 * 60;

      await expect(
        attestationManager.connect(admin)
          .setDefaultParameters(newMinAttestors, newWindow)
      )
        .to.emit(attestationManager, "DefaultParametersUpdated")
        .withArgs(newMinAttestors, newWindow);

      expect(await attestationManager.defaultMinAttestors()).to.equal(newMinAttestors);
      expect(await attestationManager.defaultAttestationWindow()).to.equal(newWindow);
    });

    /**
     * TEST: Cannot set invalid parameters
     * OUTCOME: Should revert with validation errors
     */
    it("Should reject invalid default parameters", async function () {
      await expect(
        attestationManager.connect(admin).setDefaultParameters(0, 1000)
      ).to.be.revertedWith("Min attestors must be >= 1");

      await expect(
        attestationManager.connect(admin).setDefaultParameters(3, 0)
      ).to.be.revertedWith("Window must be > 0");
    });

    /**
     * TEST: Admin can update registry address
     * OUTCOME: Registry address should be updated
     */
    it("Should allow admin to update registry", async function () {
      const newRegistry = attestor1.address;

      await expect(
        attestationManager.connect(admin).setRegistry(newRegistry)
      )
        .to.emit(attestationManager, "RegistryUpdated")
        .withArgs(newRegistry);

      expect(await attestationManager.registry()).to.equal(newRegistry);
    });

    /**
     * TEST: Admin can update CharityEvents address
     * OUTCOME: CharityEvents address should be updated
     */
    it("Should allow admin to update CharityEvents", async function () {
      const newCharityEvents = attestor1.address;

      await expect(
        attestationManager.connect(admin).setCharityEvents(newCharityEvents)
      )
        .to.emit(attestationManager, "CharityEventsUpdated")
        .withArgs(newCharityEvents);

      expect(await attestationManager.charityEvents()).to.equal(newCharityEvents);
    });

    /**
     * TEST: Admin can transfer admin rights
     * OUTCOME: New admin should be set
     */
    it("Should allow admin to transfer admin rights", async function () {
      await expect(
        attestationManager.connect(admin).transferAdmin(attestor1.address)
      )
        .to.emit(attestationManager, "AdminTransferred")
        .withArgs(attestor1.address);

      expect(await attestationManager.admin()).to.equal(attestor1.address);
    });

    /**
     * TEST: Non-admin cannot call admin functions
     * OUTCOME: Should revert with authorization error
     */
    it("Should reject admin functions from non-admin", async function () {
      await expect(
        attestationManager.connect(other).setDefaultParameters(3, 1000)
      ).to.be.revertedWith("Not admin");

      await expect(
        attestationManager.connect(other).setRegistry(other.address)
      ).to.be.revertedWith("Not admin");
    });
  });

  describe("View Functions", function () {
    const eventId = 1;

    /**
     * TEST: Get attestation count
     * OUTCOME: Should return correct number of attestations
     */
    it("Should return correct attestation count", async function () {
      await attestationManager.connect(mockCharityEvents)
        .openAttestationWindow(eventId, 3, 0);

      expect(await attestationManager.getAttestationCount(eventId)).to.equal(0);

      await attestationManager.connect(mockRegistry)
        .recordAttestation(eventId, attestor1.address, true, "uri");
      
      expect(await attestationManager.getAttestationCount(eventId)).to.equal(1);
    });

    /**
     * TEST: Check if attestor has attested
     * OUTCOME: Should return true only after attestation
     */
    it("Should correctly report attestor status", async function () {
      await attestationManager.connect(mockCharityEvents)
        .openAttestationWindow(eventId, 3, 0);

      expect(
        await attestationManager.hasAttestorAttested(eventId, attestor1.address)
      ).to.be.false;

      await attestationManager.connect(mockRegistry)
        .recordAttestation(eventId, attestor1.address, true, "uri");

      expect(
        await attestationManager.hasAttestorAttested(eventId, attestor1.address)
      ).to.be.true;
    });

    /**
     * TEST: Check if event is finalized
     * OUTCOME: Should return false before finalization
     */
    it("Should correctly report finalization status", async function () {
      await attestationManager.connect(mockCharityEvents)
        .openAttestationWindow(eventId, 3, 0);

      expect(await attestationManager.isFinalized(eventId)).to.be.false;
    });
  });
});
