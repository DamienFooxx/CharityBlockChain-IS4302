const { expect } = require("chai");
const { ethers } = require("hardhat");

// this test case does not cover function refundPledge and depositPledge. these are tested in the integration test with DonorPledge contract, found in test_donorPledges.js

describe("DonorPledges <-> EscrowVault integration", function () {
  let owner, donor1, donor2, charity, oracle, beneficiary;
  let SGDCoin, Governance, EscrowVault, DonorPledges;
  let sgdCoin, governance, escrow, pledges;
  let pledgeId; //both cases use the same pledgeID
  const eventId = ethers.id("EVENT_1");
  const pledge = 500n;

  before(async function () {
    // start the flow from when donor pledges tokens to escrowVault, via pledgeToken Contract. then escrowVault holds token, and can release

    [owner, donor1, donor2, charity, oracle, beneficiary] =
      await ethers.getSigners();

    SGDCoin = await ethers.getContractFactory("SGDCoin");
    sgdCoin = await SGDCoin.deploy();
    await sgdCoin.waitForDeployment();

    // mint some tokens to donor
    await sgdCoin.mint(donor1.address, 1500n);
    await sgdCoin.mint(donor2.address, 1000n);

    Governance = await ethers.getContractFactory("Governance");
    governance = await Governance.deploy(oracle.address, owner.address, 7000n);
    await governance.waitForDeployment();
    console.log("governance.address =", governance.target);

    DonorPledges = await ethers.getContractFactory("DonorPledges");
    pledges = await DonorPledges.deploy(governance.target, sgdCoin.target);
    await pledges.waitForDeployment();
    console.log("pledges.address =", pledges.target);

    EscrowVault = await ethers.getContractFactory("EscrowVault");
    escrow = await EscrowVault.deploy(governance.target, sgdCoin.target);
    await escrow.waitForDeployment();
    console.log("escrow.address =", escrow.target);
    await governance
      .connect(owner)
      .setContractAddress("EscrowVault", escrow.target);
    await escrow.connect(owner).authorizeContract(pledges.target, true);

    //check that
  });
  it("escrowVault holds token mapping from donorPledge, and holds token within contract", async function () {
    await sgdCoin.connect(donor1).approve(pledges.target, 100n);
    await sgdCoin.connect(donor2).approve(pledges.target, 500n);

    const tx1 = await pledges.connect(donor1).createPledge(eventId, 100n);
    await tx1.wait();

    // Verify escrow recorded the pledge for donor 1
    const pledgeId = 1; //
    const storedAmount = await escrow.pledgeAmount(pledgeId);
    const storedDonor = await escrow.pledgeDonor(pledgeId);
    const storedEvent = await escrow.pledgeEvent(pledgeId);
    const isActive = await escrow.pledgeActive(pledgeId);

    expect(storedAmount).to.equal(100n);
    expect(storedDonor).to.equal(donor1.address);
    expect(storedEvent).to.equal(eventId);
    expect(isActive).to.be.true;

    // carry with second pledge, just check total sum of tokens
    await pledges.connect(donor2).createPledge(eventId, 500n);

    // Check that EscrowVault holds pledged tokens
    const escrowBal = await sgdCoin.balanceOf(escrow.target);
    expect(escrowBal).to.equal(600n);
  });

  it("releases all pledges for an event to beneficiary when called by oracle", async function () {
    // beneficiary balance before
    const balBefore = await sgdCoin.balanceOf(beneficiary.address);

    // Call release as oracle (oracle was given ORACLE_ROLE in Governance constructor)
    await escrow
      .connect(oracle)
      .releaseToVerifiedBeneficiary(eventId, beneficiary.address);

    // Check escrow flags
    expect(await escrow.released(eventId)).to.be.true;
    expect(await escrow.releaseRecipient(eventId)).to.equal(
      beneficiary.address
    );

    // beneficiary should receive 30 SGD
    const balAfter = await sgdCoin.balanceOf(beneficiary.address);
    expect(balAfter - balBefore).to.equal(600n);

    // pledge records should be zeroed/ inactive
    expect(await escrow.pledgeAmount(1)).to.equal(0);
    expect(await escrow.pledgeAmount(2)).to.equal(0);
    expect(await escrow.pledgeActive(1)).to.equal(false);
    expect(await escrow.pledgeActive(2)).to.equal(false);
  });
});
