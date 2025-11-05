const { expect } = require("chai");
const { ethers } = require("hardhat");

// as donor pledge is interacting with escrowvault, hence this test is for the whole flow for both contracts

describe("DonorPledges: integration with EscrowVault", function () {
  let deployer, donor, charity, oracle, pauser;
  let SGDCoin, Governance, EscrowVault, DonorPledges;
  let sgdCoin, governance, escrow, pledges;
  let pledgeId; //both cases use the same pledgeID
  const eventId = ethers.id("EVENT_1");
  const pledge = 500n;

  before(async function () {
    [owner, donor, donor2, charity, oracle] = await ethers.getSigners();

    SGDCoin = await ethers.getContractFactory("SGDCoin");
    sgdCoin = await SGDCoin.deploy();
    await sgdCoin.waitForDeployment();
    console.log("sgd.address =", sgdCoin.target);

    // mint some tokens to donor
    await sgdCoin.mint(donor2.address, 1500n);

    Governance = await ethers.getContractFactory("Governance");
    governance = await Governance.deploy(
      oracle.address,
      owner.address,
      7000n,
      7000n
    );
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
  });

  it("1) flow from donor pledge: donorpledge calls createPledge, then transfers tokens to EscrowVault to records pledge", async function () {
    await sgdCoin.connect(donor2).approve(pledges.target, pledge);

    // Create pledge and get receipt
    const tx = await pledges.connect(donor2).createPledge(eventId, pledge);
    const rc = await tx.wait();

    const parsedLogs = rc.logs
      .map((log) => {
        try {
          return pledges.interface.parseLog(log);
        } catch {
          return null;
        }
      })
      .filter((e) => e && e.name === "PledgeCreated");
    const ev = parsedLogs[0];
    pledgeId = ev.args.pledgeId;

    // confirm Escrow should hold the pledge record
    const storedAmount = await escrow.pledgeAmount(pledgeId);
    const storedDonor = await escrow.pledgeDonor(pledgeId);
    const storedEvent = await escrow.pledgeEvent(pledgeId);

    expect(storedAmount).to.equal(pledge);
    expect(storedDonor).to.equal(donor2.address);
    expect(storedEvent).to.equal(eventId);

    // DonorPledges mappings updated
    const donorStake = await pledges.getDonorStakeInEvent(
      donor2.address,
      eventId
    );
    expect(donorStake).to.equal(pledge);
  });

  // continuous with the above test case
  it("2) withdrawPledge calls EscrowVault.refundPledge and returns tokens", async function () {
    const balAfter = await sgdCoin.balanceOf(donor2.address);
    expect(balAfter).to.equal(1000n);

    await pledges.connect(donor2).withdrawPledge(pledgeId);

    const balFinal = await sgdCoin.balanceOf(donor2.address);
    expect(balFinal).to.equal(1500n);

    const storedAmount = await escrow.pledgeAmount(pledgeId);
    expect(storedAmount).to.equal(0);
  });
});
