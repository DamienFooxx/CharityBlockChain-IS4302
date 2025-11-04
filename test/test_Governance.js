/* eslint-disable no-undef */
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

describe("Governance", function () {
  const QUORUM_BPS = 7000n;
  const PASS_MAJORITY_BPS = 7000n;
  const ORACLE_ROLE = ethers.id("ORACLE_ROLE");
  const PAUSER_ROLE = ethers.id("PAUSER_ROLE");
  const DEFAULT_ADMIN_ROLE = ethers.ZeroHash; // AccessControl default admin role hash

  // Fixture to deploy the Governance contract
  async function deployGovernanceFixture() {
    const [owner, oracle, pauser, admin, other] = await ethers.getSigners();

    const Governance = await ethers.getContractFactory("Governance");
    const governance = await Governance.deploy(
      oracle.address,
      pauser.address,
      QUORUM_BPS,
      PASS_MAJORITY_BPS
    );
    await governance.waitForDeployment();

    return { governance, owner, oracle, pauser, admin, other };
  }

  // =================================================================
  // 1. Deployment and Initial State
  // =================================================================
  describe("1. Deployment and Initial State", function () {
    it("1a) should set initial roles correctly", async () => {
      const { governance, owner, oracle, pauser } = await loadFixture(
        deployGovernanceFixture
      );
      // Owner gets DEFAULT_ADMIN_ROLE and PAUSER_ROLE
      expect(await governance.hasRole(DEFAULT_ADMIN_ROLE, owner.address)).to.be
        .true;
      expect(await governance.hasRole(PAUSER_ROLE, owner.address)).to.be.true;
      // Initial oracle gets ORACLE_ROLE
      expect(await governance.hasRole(ORACLE_ROLE, oracle.address)).to.be.true;
      // Initial pauser gets PAUSER_ROLE
      expect(await governance.hasRole(PAUSER_ROLE, pauser.address)).to.be.true;
    });

    it("1b) should set initial parameters correctly", async () => {
      const { governance } = await loadFixture(deployGovernanceFixture);
      expect(await governance.globalQuorumBps()).to.equal(QUORUM_BPS); //
      expect(await governance.globalPassMajorityBps()).to.equal(
        PASS_MAJORITY_BPS
      ); //
    });

    it("1c) should not be paused initially", async () => {
      const { governance } = await loadFixture(deployGovernanceFixture);
      expect(await governance.paused()).to.be.false;
    });

    it("1d) should revert deployment if initial Bps > 10000", async () => {
      const [owner, oracle, pauser] = await ethers.getSigners();
      const Governance = await ethers.getContractFactory("Governance");

      await expect(
        Governance.deploy(
          oracle.address,
          pauser.address,
          10001n, // Invalid Quorum
          PASS_MAJORITY_BPS
        )
      ).to.be.revertedWith("Quorum Bps > 100%"); //

      await expect(
        Governance.deploy(
          oracle.address,
          pauser.address,
          QUORUM_BPS,
          10001n // Invalid Pass Majority
        )
      ).to.be.revertedWith("Majority Bps > 100%"); //
    });
  });

  // =================================================================
  // 2. Role Management (Access Control)
  // =================================================================
  describe("2. Role Management", function () {
    it("2a) DEFAULT_ADMIN_ROLE can grant roles", async () => {
      const { governance, owner, admin } = await loadFixture(
        deployGovernanceFixture
      );
      await governance.connect(owner).grantRole(ORACLE_ROLE, admin.address);
      expect(await governance.hasRole(ORACLE_ROLE, admin.address)).to.be.true;
    });

    it("2b) DEFAULT_ADMIN_ROLE can revoke roles", async () => {
      const { governance, owner, oracle } = await loadFixture(
        deployGovernanceFixture
      );
      await governance.connect(owner).revokeRole(ORACLE_ROLE, oracle.address);
      expect(await governance.hasRole(ORACLE_ROLE, oracle.address)).to.be
        .false;
    });

    it("2c) Non-admin cannot grant roles", async () => {
      const { governance, other, admin } = await loadFixture(
        deployGovernanceFixture
      );
      await expect(
        governance.connect(other).grantRole(ORACLE_ROLE, admin.address)
      ).to.be.revertedWithCustomError(governance, 'AccessControlUnauthorizedAccount')
      .withArgs(other.address, DEFAULT_ADMIN_ROLE);
    });

    it("2d) Non-admin cannot revoke roles", async () => {
      const { governance, other, oracle } = await loadFixture(
        deployGovernanceFixture
      );
      await expect(
        governance.connect(other).revokeRole(ORACLE_ROLE, oracle.address)
      ).to.be.revertedWithCustomError(governance, 'AccessControlUnauthorizedAccount')
        .withArgs(other.address, DEFAULT_ADMIN_ROLE);
    });
  });

  // =================================================================
  // 3. Parameter Management
  // =================================================================
  describe("3. Parameter Management", function () {
    it("3a) Admin can set Global Quorum", async () => {
      const { governance, owner } = await loadFixture(deployGovernanceFixture);
      const newQuorum = 5000n;
      await expect(governance.connect(owner).setGlobalQuorum(newQuorum))
        .to.emit(governance, "QuorumUpdated")
        .withArgs(newQuorum); //
      expect(await governance.globalQuorumBps()).to.equal(newQuorum);
    });

    it("3b) Non-admin cannot set Global Quorum", async () => {
      const { governance, other } = await loadFixture(deployGovernanceFixture);
      await expect(
        governance.connect(other).setGlobalQuorum(5000n)
      ).to.be.revertedWithCustomError(governance, 'AccessControlUnauthorizedAccount')
        .withArgs(other.address, DEFAULT_ADMIN_ROLE);
    });

    it("3c) setGlobalQuorum reverts if Bps > 10000", async () => {
      const { governance, owner } = await loadFixture(deployGovernanceFixture);
      await expect(
        governance.connect(owner).setGlobalQuorum(10001n)
      ).to.be.revertedWith("Bps > 100%"); //
    });

    it("3d) Admin can set Global Pass Majority", async () => {
      const { governance, owner } = await loadFixture(deployGovernanceFixture);
      const newMajority = 8000n;
      await expect(
        governance.connect(owner).setGlobalPassMajority(newMajority)
      )
        .to.emit(governance, "PassMajorityUpdated")
        .withArgs(newMajority); //
      expect(await governance.globalPassMajorityBps()).to.equal(newMajority);
    });

    it("3e) Non-admin cannot set Global Pass Majority", async () => {
      const { governance, other } = await loadFixture(deployGovernanceFixture);
      await expect(
        governance.connect(other).setGlobalPassMajority(8000n)
      ).to.be.revertedWithCustomError(governance, 'AccessControlUnauthorizedAccount')
        .withArgs(other.address, DEFAULT_ADMIN_ROLE);
    });

    it("3f) setGlobalPassMajority reverts if Bps > 10000", async () => {
      const { governance, owner } = await loadFixture(deployGovernanceFixture);
      await expect(
        governance.connect(owner).setGlobalPassMajority(10001n)
      ).to.be.revertedWith("Bps > 100%"); //
    });
  });

  // =================================================================
  // 4. Contract Registry
  // =================================================================
  describe("4. Contract Registry", function () {
    const contractName = "DonorRegistry";
    const nameHash = ethers.keccak256(ethers.toUtf8Bytes(contractName));

    it("4a) Admin can set contract address", async () => {
      const { governance, owner, other } = await loadFixture(
        deployGovernanceFixture
      );
      const newAddress = other.address; // Use 'other' as a dummy address
      await expect(
        governance
          .connect(owner)
          .setContractAddress(contractName, newAddress)
      )
        .to.emit(governance, "ContractAddressUpdated")
        .withArgs(nameHash, newAddress); //
      expect(await governance.contractAddresses(nameHash)).to.equal(
        newAddress
      );
      expect(
        await governance.getContractAddress(contractName)
      ).to.equal(newAddress);
    });

    it("4b) Non-admin cannot set contract address", async () => {
      const { governance, other } = await loadFixture(deployGovernanceFixture);
      await expect(
        governance
          .connect(other)
          .setContractAddress(contractName, other.address)
      ).to.be.revertedWithCustomError(governance, 'AccessControlUnauthorizedAccount')
        .withArgs(other.address, DEFAULT_ADMIN_ROLE);
    });

    it("4c) setContractAddress reverts for zero address", async () => {
      const { governance, owner } = await loadFixture(deployGovernanceFixture);
      await expect(
        governance
          .connect(owner)
          .setContractAddress(contractName, ethers.ZeroAddress)
      ).to.be.revertedWith("Zero address"); //
    });

    it("4d) getContractAddress returns correct address", async () => {
      const { governance, owner, other } = await loadFixture(
        deployGovernanceFixture
      );
      await governance
        .connect(owner)
        .setContractAddress(contractName, other.address);
      expect(
        await governance.getContractAddress(contractName)
      ).to.equal(other.address);
    });

    it("4e) getContractAddress returns zero for unset name", async () => {
      const { governance } = await loadFixture(deployGovernanceFixture);
      expect(await governance.getContractAddress("UnsetName")).to.equal(
        ethers.ZeroAddress
      );
    });
  });

  // =================================================================
  // 5. Pausable Functionality
  // =================================================================
  describe("5. Pausable Functionality", function () {
    it("5a) PAUSER_ROLE can pause", async () => {
      const { governance, pauser } = await loadFixture(deployGovernanceFixture);
      await expect(governance.connect(pauser).pause())
        .to.emit(governance, "Paused")
        .withArgs(pauser.address);
      expect(await governance.paused()).to.be.true;
    });

    it("5b) Non-PAUSER_ROLE cannot pause", async () => {
      const { governance, other } = await loadFixture(deployGovernanceFixture);
      await expect(governance.connect(other).pause()
    ).to.be.revertedWithCustomError(governance, 'AccessControlUnauthorizedAccount')
    .withArgs(other.address, PAUSER_ROLE);
    });

    it("5c) DEFAULT_ADMIN_ROLE can unpause", async () => {
      const { governance, owner, pauser } = await loadFixture(
        deployGovernanceFixture
      );
      await governance.connect(pauser).pause(); // First pause it
      await expect(governance.connect(owner).unpause())
        .to.emit(governance, "Unpaused")
        .withArgs(owner.address);
      expect(await governance.paused()).to.be.false;
    });

    it("5d) Non-DEFAULT_ADMIN_ROLE cannot unpause", async () => {
      const { governance, pauser, other } = await loadFixture(
        deployGovernanceFixture
      );
      await governance.connect(pauser).pause(); // First pause it
      await expect(governance.connect(other).unpause()
      ).to.be.revertedWithCustomError(governance, 'AccessControlUnauthorizedAccount')
      .withArgs(other.address, DEFAULT_ADMIN_ROLE);
      // Pauser also cannot unpause by default
      await expect(governance.connect(pauser).unpause()
      ).to.be.revertedWithCustomError(governance, 'AccessControlUnauthorizedAccount')
      .withArgs(pauser.address, DEFAULT_ADMIN_ROLE);
    });

    it("5e) whenNotPaused modifier prevents actions when paused", async () => {
      const { governance, owner, pauser, other } = await loadFixture(
        deployGovernanceFixture
      );
      await governance.connect(pauser).pause(); // Pause the system

      await expect(
        governance.connect(owner).setGlobalQuorum(5000n)
      ).to.be.revertedWithCustomError(governance, 'EnforcedPause');;
      await expect(
        governance.connect(owner).setGlobalPassMajority(5000n)
      ).to.be.revertedWithCustomError(governance, 'EnforcedPause');;
      await expect(
        governance
          .connect(owner)
          .setContractAddress("Test", other.address)
      ).to.be.revertedWithCustomError(governance, 'EnforcedPause');;
    });
  });
});