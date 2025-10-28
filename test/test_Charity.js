/* eslint-disable no-undef */
const { expect } = require("chai");
const { ethers } = require("hardhat");

// Helpers
const nowPlus = (secs) => Math.floor(Date.now() / 1000) + secs;

describe("Charity contracts integration", function () {
  let deployer, oracle, pauser, charityOwner, beneficiary, user1;
  let governance, sgd, registry, reputation, treasury, eventCtr;

  const QUORUM_BPS = 7000n;

  async function deployAll() {
    [deployer, oracle, pauser, charityOwner, beneficiary, user1] = await ethers.getSigners();

    // Governance
    const Governance = await ethers.getContractFactory("Governance");
    governance = await Governance.deploy(
      await oracle.getAddress(),
      await pauser.getAddress(),
      QUORUM_BPS,
      QUORUM_BPS
    );
    await governance.waitForDeployment();

    // SGD token
    const SGDCoin = await ethers.getContractFactory("SGDCoin");
    sgd = await SGDCoin.deploy();
    await sgd.waitForDeployment();

    // Core contracts
    const CharityRegistry = await ethers.getContractFactory("CharityRegistry");
    registry = await CharityRegistry.deploy(await governance.getAddress());
    await registry.waitForDeployment();

    const CharityReputation = await ethers.getContractFactory("CharityReputation");
    reputation = await CharityReputation.deploy(await governance.getAddress());
    await reputation.waitForDeployment();

    const CharityTreasury = await ethers.getContractFactory("CharityTreasury");
    treasury = await CharityTreasury.deploy(
      await sgd.getAddress(),
      await governance.getAddress()
    );
    await treasury.waitForDeployment();

    // CharityEvent (deploy from charityOwner so it becomes the owner)
    const CharityEvent = await ethers.getContractFactory("CharityEvent");
    const evId = ethers.keccak256(ethers.toUtf8Bytes("event-1"));
    const orgId = 1n; // will register below to match
    const goal = ethers.parseEther("100");
    const deadline = BigInt(nowPlus(3600));
    eventCtr = await CharityEvent.connect(charityOwner).deploy(
      await governance.getAddress(),
      await registry.getAddress(),
      evId,
      orgId,
      await beneficiary.getAddress(),
      goal,
      deadline,
      "Food Drive"
    );
    await eventCtr.waitForDeployment();
  }

  beforeEach(async () => {
    await deployAll();
  });

  it("1) CharityRegistry: register, approve, set treasury, stats", async () => {
    // Register by charity owner
    const tx = await registry
      .connect(charityOwner)
      .registerCharity("Charity A", "QmMeta");
    await tx.wait();

    const orgId = await registry.addressToOrgId(await charityOwner.getAddress());
    expect(orgId).to.equal(1n);

    // Approve and set treasury by admin (deployer has DEFAULT_ADMIN_ROLE)
    await registry.connect(deployer).setApproval(orgId, true);
    await registry.connect(deployer).setTreasury(orgId, await treasury.getAddress());

    const profile = await registry.profiles(orgId);
    expect(profile.approved).to.equal(true);
    expect(profile.treasury).to.equal(await treasury.getAddress());

    const [registeredCount, approvedCount] = await registry.getStats();
    expect(registeredCount).to.equal(1n);
    expect(approvedCount).to.equal(1n);
  });

  it("1b) CharityRegistry: rejects duplicate registration and enforces onlyAdmin", async () => {
    // Register by wallet
    await registry.connect(charityOwner).registerCharity("Charity A", "QmMeta");
    await expect(
      registry.connect(charityOwner).registerCharity("Charity A", "QmMeta2")
    ).to.be.revertedWith("Address already registered");

    const orgId = await registry.addressToOrgId(await charityOwner.getAddress());
    // Non-admin cannot approve or set treasury
    await expect(registry.connect(user1).setApproval(orgId, true)).to.be.revertedWith("Registry: Caller is not admin");
    await expect(registry.connect(user1).setTreasury(orgId, await treasury.getAddress())).to.be.revertedWith("Registry: Caller is not admin");
  });

  it("1c) CharityRegistry: pause in governance blocks system functions", async () => {
    await registry.connect(charityOwner).registerCharity("Charity A", "QmMeta");
    await governance.connect(pauser).pause();
    await expect(
      registry.connect(charityOwner).updateProfile(1n, "QmNew")
    ).to.be.revertedWith("Registry: System is paused");
    await governance.connect(deployer).unpause();
    await registry.connect(charityOwner).updateProfile(1n, "QmNew");
    const prof = await registry.profiles(1n);
    expect(prof.metaCID).to.equal("QmNew");
  });

  it("2) CharityReputation: initialize and update via oracle", async () => {
    // Ensure org exists
    await registry.connect(charityOwner).registerCharity("Charity A", "QmMeta");
    const orgId = await registry.addressToOrgId(await charityOwner.getAddress());

    await reputation.connect(deployer).initializeReputation(orgId);
    expect(await reputation.scoreOf(orgId)).to.equal(500n);

    // Oracle updates event outcome (success)
    await reputation.connect(oracle).updateOnEventOutcome(orgId, 1n, true);
    expect(await reputation.scoreOf(orgId)).to.equal(510n);

    // Oracle records a positive vote changing ratio slightly
    await reputation.connect(oracle).recordVote(orgId, true);
    const tier = await reputation.getReputationTier(orgId);
    expect(tier >= 2n && tier <= 5n).to.equal(true);

    // Finalize pass gives +15 (500 -> 510 -> 515 -> 530)
    await reputation.connect(oracle).updateOnFinalize(orgId, true);
    expect(await reputation.scoreOf(orgId)).to.equal(530n);
  });

  it("2b) CharityReputation: onlyOracle enforced and duplicate event outcome prevented", async () => {
    await registry.connect(charityOwner).registerCharity("Charity A", "QmMeta");
    const orgId = await registry.addressToOrgId(await charityOwner.getAddress());
    await reputation.connect(deployer).initializeReputation(orgId);

    await expect(
      reputation.connect(user1).updateOnEventOutcome(orgId, 99n, true)
    ).to.be.revertedWith("Not oracle");

    await reputation.connect(oracle).updateOnEventOutcome(orgId, 99n, true);
    await expect(
      reputation.connect(oracle).updateOnEventOutcome(orgId, 99n, false)
    ).to.be.revertedWith("Event already recorded");
  });

  it("3) CharityTreasury: create, receive release (oracle), withdraw", async () => {
    // Register + approve + set treasury
    await registry.connect(charityOwner).registerCharity("Charity A", "QmMeta");
    const orgId = await registry.addressToOrgId(await charityOwner.getAddress());
    await registry.connect(deployer).setApproval(orgId, true);
    await registry.connect(deployer).setTreasury(orgId, await treasury.getAddress());

    // Create treasury entry for org
    await treasury.connect(deployer).createTreasury(orgId, await charityOwner.getAddress());

    // Fund oracle for transfer
    await sgd.connect(deployer).mint(await oracle.getAddress(), ethers.parseEther("200"));
    await sgd.connect(oracle).approve(await treasury.getAddress(), ethers.parseEther("100"));

    // Oracle releases to treasury for event
    await treasury
      .connect(oracle)
      .receiveRelease(orgId, 1n, ethers.parseEther("100"));

    let [total, available, locked] = await treasury.balanceOf(orgId);
    expect(total).to.equal(ethers.parseEther("100"));
    expect(available).to.equal(ethers.parseEther("100"));
    expect(locked).to.equal(0n);

    // Charity withdraws 30
    await treasury
      .connect(charityOwner)
      .withdraw(await beneficiary.getAddress(), ethers.parseEther("30"));

    [total, available, locked] = await treasury.balanceOf(orgId);
    expect(total).to.equal(ethers.parseEther("70"));
    expect(available).to.equal(ethers.parseEther("70"));
    expect(locked).to.equal(0n);
    expect(await sgd.balanceOf(await beneficiary.getAddress())).to.equal(
      ethers.parseEther("30")
    );
  });

  it("3b) CharityTreasury: onlyAdmin/onlyOracle/owner checks and edge cases", async () => {
    // Non-admin cannot create treasury
    await expect(
      treasury.connect(user1).createTreasury(1n, await charityOwner.getAddress())
    ).to.be.revertedWith("Not admin");

    // Setup org and treasury
    await registry.connect(charityOwner).registerCharity("Charity A", "QmMeta");
    const orgId = await registry.addressToOrgId(await charityOwner.getAddress());
    await registry.connect(deployer).setApproval(orgId, true);
    await registry.connect(deployer).setTreasury(orgId, await treasury.getAddress());
    await treasury.connect(deployer).createTreasury(orgId, await charityOwner.getAddress());

    // Non-oracle cannot receiveRelease
    await expect(
      treasury.connect(user1).receiveRelease(orgId, 1n, 1n)
    ).to.be.revertedWith("Not oracle");

    // Mint to oracle and approve
    await sgd.connect(deployer).mint(await oracle.getAddress(), 1000n);
    await sgd.connect(oracle).approve(await treasury.getAddress(), 1000n);

    // Receive zero amount reverts
    await expect(
      treasury.connect(oracle).receiveRelease(orgId, 1n, 0n)
    ).to.be.revertedWith("Amount must be positive");

    // Happy path
    await treasury.connect(oracle).receiveRelease(orgId, 1n, 500n);

    // Non-owner cannot withdraw
    await expect(
      treasury.connect(user1).withdraw(await beneficiary.getAddress(), 1n)
    ).to.be.revertedWith("Treasury not found");

    // Owner cannot withdraw > available
    await expect(
      treasury.connect(charityOwner).withdraw(await beneficiary.getAddress(), 10000n)
    ).to.be.revertedWith("Insufficient available balance");
  });

  it("4) CharityEvent: lifecycle funding -> closed -> verification -> approved", async () => {
    // Event starts in FUNDING
    let summary = await eventCtr.getEventSummary();
    // currentPhase index 0 = FUNDING
    expect(summary[2]).to.equal(0n);

    // Update raised to reach goal triggers auto close
    await eventCtr.connect(ethers.provider).getBalance; // noop to ensure signer types
    await eventCtr.connect(deployer).updateRaised(ethers.parseEther("100"));
    summary = await eventCtr.getEventSummary();
    expect(summary[2]).to.equal(1n); // CLOSED

    // Charity submits evidence
    await eventCtr.connect(charityOwner).submitEvidence("QmEvidence");
    summary = await eventCtr.getEventSummary();
    expect(summary[2]).to.equal(2n); // VERIFICATION

    // Oracle verifies true
    await eventCtr.connect(oracle).setVerified(true, [true, true, true]);
    summary = await eventCtr.getEventSummary();
    expect(summary[2]).to.equal(3n); // APPROVED
  });

  it("4b) CharityEvent: access control and phase guards", async () => {
    // Only owner can close funding
    await expect(eventCtr.connect(user1).closeFunding()).to.be.revertedWith("Not charity owner");
    await eventCtr.connect(charityOwner).closeFunding();

    // Only owner can submit evidence, only in CLOSED
    await expect(eventCtr.connect(user1).submitEvidence("Qm1")).to.be.revertedWith("Not charity owner");
    await eventCtr.connect(charityOwner).submitEvidence("Qm1");

    // Only oracle can setVerified; wrong phase or caller reverts
    await expect(eventCtr.connect(user1).setVerified(true, [true, true, true])).to.be.revertedWith("Not oracle");
    await eventCtr.connect(oracle).setVerified(false, [false, false, false]);

    // After REJECTED, requestRetry allowed only by owner via requestRetry (if implemented), else ensure phase set
    const summary = await eventCtr.getEventSummary();
    expect(summary[2] === 3n || summary[2] === 4n).to.equal(true);
  });
});


