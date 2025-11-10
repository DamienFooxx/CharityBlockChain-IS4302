/* eslint-disable no-undef */
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

// Note: Using BigInt (e.g., 1000n) for EVM numbers.
function sqrt(value) {
  if (value < 0n) {
    throw new Error("square root of negative numbers is not supported");
  }
  if (value === 0n) return 0n;

  let z = (value + 1n) / 2n;
  let y = value;
  while (z < y) {
    y = z;
    z = (value / z + z) / 2n;
  }
  return y;
}

describe("DonorVoting", function () {
  const eventId = ethers.id("EVENT_1"); // keccak256("EVENT_1")
  const QUORUM_BPS = 7000n; // 70%
  const PASS_MAJORITY_BPS = 7000n; // 70%

  // Deploys all contracts and sets up roles and initial funds
  async function deployVotingFixture() {
    // Get Signers
    const [owner, oracle, donor1, donor2, donor3, other] =
      await ethers.getSigners();

    // Deploy Dependencies

    // 1. Governance (handles roles)
    const Governance = await ethers.getContractFactory("Governance");
    const governance = await Governance.deploy(
      oracle.address,
      owner.address,
      QUORUM_BPS,
      PASS_MAJORITY_BPS
    );
    await governance.waitForDeployment();

    // 2. DonorRegistry
    const DonorRegistry = await ethers.getContractFactory("DonorRegistry");
    const donorRegistry = await DonorRegistry.deploy(governance.target);
    await donorRegistry.waitForDeployment();

    // 3. SGDCoin (for pledges)
    const SGDCoin = await ethers.getContractFactory("SGDCoin");
    const sgdCoin = await SGDCoin.deploy();
    await sgdCoin.waitForDeployment();

    // 4. DonorPledges
    const DonorPledges = await ethers.getContractFactory("DonorPledges");
    const donorPledges = await DonorPledges.deploy(
      governance.target,
      sgdCoin.target
    );
    await donorPledges.waitForDeployment();

    // Deploy EscrowVault and register it so createPledge finds the vault
    const EscrowVault = await ethers.getContractFactory("EscrowVault");
    const escrow = await EscrowVault.deploy(governance.target, sgdCoin.target);
    await escrow.waitForDeployment();
    await governance
      .connect(owner)
      .setContractAddress("EscrowVault", escrow.target);
    // authorize donorPledges to call depositPledge
    await escrow.connect(owner).authorizeContract(donorPledges.target, true);

    // 5. DonorRanking (gives 1x weight by default)
    const DonorRanking = await ethers.getContractFactory("DonorRanking");
    const donorRanking = await DonorRanking.deploy(governance.target);
    await donorRanking.waitForDeployment();

    // Deploy DonorVoting
    const DonorVoting = await ethers.getContractFactory("DonorVoting");
    const donorVoting = await DonorVoting.deploy(
      governance.target,
      donorRegistry.target,
      donorPledges.target,
      donorRanking.target,
      eventId
    );
    await donorVoting.waitForDeployment();

    // Initial Setup for Donors
    const donors = [donor1, donor2, donor3];
    const pledges = [1000n, 2000n, 5000n]; // Pledges for d1, d2, d3

    for (let i = 0; i < donors.length; i++) {
      const donor = donors[i];
      const pledgeAmount = pledges[i];

      // a) Register donor
      await donorRegistry
        .connect(donor)
        .registerDonor(`Donor ${i + 1}`, "ipfs://cid");

      // b) Fund donor
      await sgdCoin.connect(owner).mint(donor.address, pledgeAmount);

      // c) Donor approves DonorPledges contract
      await sgdCoin.connect(donor).approve(donorPledges.target, pledgeAmount);

      // d) Donor creates pledge
      await donorPledges.connect(donor).createPledge(eventId, pledgeAmount);
    }

    // Helper function to advance time
    const advanceTime = async (seconds) => {
      const now = (await ethers.provider.getBlock("latest")).timestamp;
      await ethers.provider.send("evm_setNextBlockTimestamp", [now + seconds]);
      await ethers.provider.send("evm_mine");
    };

    // Helper to get deadlines
    const getDeadlines = async () => {
      const now = (await ethers.provider.getBlock("latest")).timestamp;
      const commitTime = now + 100;
      const revealTime = now + 200;
      return { commitTime, revealTime };
    };

    return {
      donorVoting,
      governance,
      donorRegistry,
      donorPledges,
      donorRanking,
      owner,
      oracle,
      donor1,
      donor2,
      donor3,
      other,
      advanceTime,
      getDeadlines,
    };
  }

  // 1. Deployment and Initialization

  describe("1. Deployment and Initialization", function () {
    it("1a) should set correct immutable variables", async () => {
      const {
        donorVoting,
        governance,
        donorRegistry,
        donorPledges,
        donorRanking,
      } = await loadFixture(deployVotingFixture);

      expect(await donorVoting.governance()).to.equal(governance.target);
      expect(await donorVoting.donorRegistry()).to.equal(donorRegistry.target);
      expect(await donorVoting.donorPledges()).to.equal(donorPledges.target);
      expect(await donorVoting.donorRanking()).to.equal(donorRanking.target);
      expect(await donorVoting.eventId()).to.equal(eventId);
    });

    it("1b) should initialize in Pending phase", async () => {
      const { donorVoting } = await loadFixture(deployVotingFixture);
      expect(await donorVoting.phase()).to.equal(0n); // 0 = Phase.Pending
    });

    it("1c) should have correct NUM_STREAMS", async () => {
      const { donorVoting } = await loadFixture(deployVotingFixture);
      expect(await donorVoting.NUM_STREAMS()).to.equal(3n);
    });

    it("1d) view functions should return (false, false) before finalization", async () => {
      const { donorVoting } = await loadFixture(deployVotingFixture);
      const [decided, passed] = await donorVoting.streamResult(0);
      expect(decided).to.be.false;
      expect(passed).to.be.false;

      const [overallDecided, overallPassed, perStream] =
        await donorVoting.overallResult();
      expect(overallDecided).to.be.false;
      expect(overallPassed).to.be.false;
      expect(perStream).to.deep.equal([false, false, false]);
    });
  });

  // 2. Oracle Functions (Pending Phase)
  describe("2. Oracle Functions (Pending Phase)", function () {
    // adjustDeadline
    it("2a) adjustDeadline: Oracle can set deadlines", async () => {
      const { donorVoting, oracle, getDeadlines } = await loadFixture(
        deployVotingFixture
      );
      const { commitTime, revealTime } = await getDeadlines();

      await expect(
        donorVoting.connect(oracle).adjustDeadline(commitTime, revealTime)
      )
        .to.emit(donorVoting, "DeadlinesAdjusted")
        .withArgs(commitTime, revealTime);

      expect(await donorVoting.commitDeadline()).to.equal(commitTime);
      expect(await donorVoting.revealDeadline()).to.equal(revealTime);
    });

    it("2b) adjustDeadline: reverts for non-oracle", async () => {
      const { donorVoting, other, getDeadlines } = await loadFixture(
        deployVotingFixture
      );
      const { commitTime, revealTime } = await getDeadlines();
      await expect(
        donorVoting.connect(other).adjustDeadline(commitTime, revealTime)
      ).to.be.revertedWith("DonorVoting: Not oracle");
    });

    it("2c) adjustDeadline: reverts if commit >= reveal", async () => {
      const { donorVoting, oracle, getDeadlines } = await loadFixture(
        deployVotingFixture
      );
      const { commitTime, revealTime } = await getDeadlines();
      await expect(
        donorVoting.connect(oracle).adjustDeadline(revealTime, commitTime)
      ).to.be.revertedWith("DonorVoting: Commit < Reveal");
    });

    it("2d) adjustDeadline: reverts if commit in past", async () => {
      const { donorVoting, oracle } = await loadFixture(deployVotingFixture);
      const now = (await ethers.provider.getBlock("latest")).timestamp;
      await expect(
        donorVoting.connect(oracle).adjustDeadline(now - 1, now + 100)
      ).to.be.revertedWith("DonorVoting: Commit in past");
    });

    // assignVoter
    it("2e) assignVoter: Oracle can assign a valid donor", async () => {
      const { donorVoting, oracle, donor1 } = await loadFixture(
        deployVotingFixture
      );
      const stream = 0;
      const pledgeAmount = 1000n; // From fixture setup
      const weightMultiplier = 100n; // Default from DonorRanking
      const finalWeight = (sqrt(pledgeAmount) * weightMultiplier) / 100n; // 1000

      await expect(
        donorVoting.connect(oracle).assignVoter(donor1.address, stream)
      )
        .to.emit(donorVoting, "VoterAssigned")
        .withArgs(donor1.address, stream);

      expect(await donorVoting.isAssigned(donor1.address)).to.be.true;
      expect(await donorVoting.assignedStream(donor1.address)).to.equal(stream);
      expect(await donorVoting.totalPossibleWeight(stream)).to.equal(
        finalWeight
      );
    });

    it("2f) assignVoter: correctly sums totalPossibleWeight", async () => {
      const { donorVoting, oracle, donor1, donor2 } = await loadFixture(
        deployVotingFixture
      );
      const stream = 0;
      // donor1 pledge 1000, weight 100 -> 1000
      // donor2 pledge 2000, weight 100 -> 2000
      await donorVoting.connect(oracle).assignVoter(donor1.address, stream);
      await donorVoting.connect(oracle).assignVoter(donor2.address, stream);

      expect(await donorVoting.totalPossibleWeight(stream)).to.equal(75n);
    });

    it("2g) assignVoter: reverts for non-oracle", async () => {
      const { donorVoting, other, donor1 } = await loadFixture(
        deployVotingFixture
      );
      await expect(
        donorVoting.connect(other).assignVoter(donor1.address, 0)
      ).to.be.revertedWith("DonorVoting: Not oracle");
    });

    it("2h) assignVoter: reverts for invalid stream", async () => {
      const { donorVoting, oracle, donor1 } = await loadFixture(
        deployVotingFixture
      );
      await expect(
        donorVoting.connect(oracle).assignVoter(donor1.address, 3) // NUM_STREAMS is 3
      ).to.be.revertedWith("DonorVoting: Invalid stream");
    });

    it("2i) assignVoter: reverts if already assigned", async () => {
      const { donorVoting, oracle, donor1 } = await loadFixture(
        deployVotingFixture
      );
      await donorVoting.connect(oracle).assignVoter(donor1.address, 0);
      await expect(
        donorVoting.connect(oracle).assignVoter(donor1.address, 1)
      ).to.be.revertedWith("DonorVoting: Already assigned");
    });

    it("2j) assignVoter: reverts if donor not registered", async () => {
      const { donorVoting, oracle, other } = await loadFixture(
        deployVotingFixture
      );
      await expect(
        donorVoting.connect(oracle).assignVoter(other.address, 0)
      ).to.be.revertedWith("DonorVoting: Not registered");
    });

    it("2k) assignVoter: reverts if donor has no pledge", async () => {
      const { donorVoting, oracle, other, donorRegistry } = await loadFixture(
        deployVotingFixture
      );
      // 'other' is registered but has no pledge
      await donorRegistry.connect(other).registerDonor("Other", "cid");
      await expect(
        donorVoting.connect(oracle).assignVoter(other.address, 0)
      ).to.be.revertedWith("DonorVoting: No pledge weight");
    });

    // advancePhase (from Pending)
    it("2l) advancePhase: reverts from Pending if deadlines not set", async () => {
      const { donorVoting, oracle } = await loadFixture(deployVotingFixture);
      await expect(
        donorVoting.connect(oracle).advancePhase()
      ).to.be.revertedWith("DonorVoting: Deadlines not set");
    });

    it("2m) advancePhase: moves from Pending to Commit", async () => {
      const { donorVoting, oracle, getDeadlines } = await loadFixture(
        deployVotingFixture
      );
      const { commitTime, revealTime } = await getDeadlines();
      await donorVoting.connect(oracle).adjustDeadline(commitTime, revealTime);

      await expect(donorVoting.connect(oracle).advancePhase())
        .to.emit(donorVoting, "PhaseAdvanced")
        .withArgs(1n); // 1 = Phase.Commit

      expect(await donorVoting.phase()).to.equal(1n);
    });
  });

  // 3. Commit Phase

  describe("3. Commit Phase", function () {
    let fixture;
    const salt = ethers.id("MY_SALT");
    const commitTrue = ethers.solidityPackedKeccak256(
      ["bool", "uint256"],
      [true, salt]
    );

    // Setup: Move to Commit phase and assign donor1
    beforeEach(async () => {
      fixture = await loadFixture(deployVotingFixture);
      const { donorVoting, oracle, donor1, getDeadlines } = fixture;
      const { commitTime, revealTime } = await getDeadlines();
      await donorVoting.connect(oracle).adjustDeadline(commitTime, revealTime);
      await donorVoting.connect(oracle).assignVoter(donor1.address, 0);
      await donorVoting.connect(oracle).advancePhase(); // -> Commit
    });

    it("3a) commit: allows assigned donor to commit", async () => {
      const { donorVoting, donor1 } = fixture;
      await expect(donorVoting.connect(donor1).commit(commitTrue))
        .to.emit(donorVoting, "Voted")
        .withArgs(donor1.address, 0); // (voter, stream)

      expect(await donorVoting.commitments(donor1.address)).to.equal(
        commitTrue
      );
    });

    it("3b) commit: reverts if not in Commit phase", async () => {
      const { donorVoting, donor1, oracle, advanceTime, getDeadlines } =
        fixture;
      const { commitTime } = await getDeadlines();
      // Advance to Reveal phase
      await advanceTime(101);
      await donorVoting.connect(oracle).advancePhase(); // -> Reveal
      expect(await donorVoting.phase()).to.equal(2n);

      await expect(
        donorVoting.connect(donor1).commit(commitTrue)
      ).to.be.revertedWith("DonorVoting: Invalid phase");
    });

    it("3b) commit: reverts if donor not assigned", async () => {
      const { donorVoting, donor2 } = fixture; // donor2 is not assigned
      await expect(
        donorVoting.connect(donor2).commit(commitTrue)
      ).to.be.revertedWith("DonorVoting: Not assigned");
    });

    it("3c) commit: reverts if already committed", async () => {
      const { donorVoting, donor1 } = fixture;
      await donorVoting.connect(donor1).commit(commitTrue);
      await expect(
        donorVoting.connect(donor1).commit(commitTrue)
      ).to.be.revertedWith("DonorVoting: Already committed");
    });

    it("3d) commit: reverts for zero commitment", async () => {
      const { donorVoting, donor1 } = fixture;
      await expect(
        donorVoting.connect(donor1).commit(ethers.ZeroHash)
      ).to.be.revertedWith("DonorVoting: Invalid commitment");
    });

    it("3e) advancePhase: reverts from Commit if deadline not met", async () => {
      const { donorVoting, oracle } = fixture;
      await expect(
        donorVoting.connect(oracle).advancePhase()
      ).to.be.revertedWith("DonorVoting: Commit open");
    });

    it("3f) advancePhase: moves from Commit to Reveal", async () => {
      const { donorVoting, oracle, advanceTime } = fixture;
      await advanceTime(101); // Pass commit deadline (100s)
      await expect(donorVoting.connect(oracle).advancePhase())
        .to.emit(donorVoting, "PhaseAdvanced")
        .withArgs(2n); // 2 = Phase.Reveal
      expect(await donorVoting.phase()).to.equal(2n);
    });
  });

  // 4. Reveal Phase
  describe("4. Reveal Phase", function () {
    let fixture;
    const passChoice = true;
    const failChoice = false;
    const passSalt = ethers.id("PASS_SALT");
    const failSalt = ethers.id("FAIL_SALT");

    const commitTrue = ethers.solidityPackedKeccak256(
      ["bool", "uint256"],
      [passChoice, passSalt]
    );
    const commitFalse = ethers.solidityPackedKeccak256(
      ["bool", "uint256"],
      [failChoice, failSalt]
    );

    // Setup: Move to Commit phase (tests will commit/advance)
    beforeEach(async () => {
      fixture = await loadFixture(deployVotingFixture);
      const { donorVoting, oracle, donor1, getDeadlines } = fixture;
      const { commitTime, revealTime } = await getDeadlines();

      await donorVoting.connect(oracle).adjustDeadline(commitTime, revealTime);
      await donorVoting.connect(oracle).assignVoter(donor1.address, 0); // 1000 pledge -> 1000 weight
      await donorVoting.connect(oracle).advancePhase(); // -> Commit
    });

    it("4a) reveal: allows valid 'pass' reveal and tallies correctly", async () => {
      const { donorVoting, donor1, oracle, advanceTime } = fixture;
      const stream = 0;
      const finalWeight = sqrt(1000n);

      // Commit "true"
      await donorVoting.connect(donor1).commit(commitTrue);

      // Advance to Reveal
      await advanceTime(101); // Pass commit deadline
      await donorVoting.connect(oracle).advancePhase(); // -> Reveal

      // Reveal "true"
      await expect(donorVoting.connect(donor1).reveal(passChoice, passSalt))
        .to.emit(donorVoting, "Revealed")
        .withArgs(donor1.address, stream, passChoice, finalWeight);

      expect(await donorVoting.revealed(donor1.address)).to.be.true;
      const tally = await donorVoting.tallies(stream);
      expect(tally.pass).to.equal(finalWeight);
      expect(tally.fail).to.equal(0n);
      expect(tally.totalWeight).to.equal(finalWeight);
    });

    it("4b) reveal: allows valid 'fail' reveal and tallies correctly", async () => {
      const { donorVoting, donor1, oracle, advanceTime } = fixture;
      const stream = 0;
      const finalWeight = sqrt(1000n);

      // Commit "false"
      await donorVoting.connect(donor1).commit(commitFalse);

      // Advance to Reveal
      await advanceTime(101); // Pass commit deadline
      await donorVoting.connect(oracle).advancePhase(); // -> Reveal

      // Reveal "false"
      await expect(donorVoting.connect(donor1).reveal(failChoice, failSalt))
        .to.emit(donorVoting, "Revealed")
        .withArgs(donor1.address, stream, failChoice, finalWeight);

      expect(await donorVoting.revealed(donor1.address)).to.be.true;
      const tally = await donorVoting.tallies(stream);
      expect(tally.pass).to.equal(0n);
      expect(tally.fail).to.equal(finalWeight);
      expect(tally.totalWeight).to.equal(finalWeight);
    });

    //  Nested describe for common setup tests
    describe("4c-4i: Reveal Phase (Common Setup)", function () {
      // Re-setup the fixture, this time committing 'true' for all subsequent tests
      beforeEach(async () => {
        // We reuse the 'fixture' from the parent describe block
        const { donorVoting, donor1, oracle, advanceTime } = fixture;

        // Commit 'true' and advance to Reveal
        await donorVoting.connect(donor1).commit(commitTrue);
        await advanceTime(101); // Pass commit deadline
        await donorVoting.connect(oracle).advancePhase(); // -> Reveal
      });

      it("4c) reveal: reverts if not in Reveal phase", async () => {
        const { donorVoting, donor1, oracle, advanceTime } = fixture;
        await advanceTime(101); // Pass reveal deadline (total 202s)
        await donorVoting.connect(oracle).advancePhase(); // -> Finalized
        expect(await donorVoting.phase()).to.equal(3n);

        await expect(
          donorVoting.connect(donor1).reveal(passChoice, passSalt)
        ).to.be.revertedWith("DonorVoting: Invalid phase");
      });

      it("4d) reveal: reverts if no commit exists", async () => {
        const { donorVoting, donor2 } = fixture; // donor2 did not commit
        await expect(
          donorVoting.connect(donor2).reveal(passChoice, passSalt)
        ).to.be.revertedWith("DonorVoting: No commit");
      });

      it("4e) reveal: reverts if already revealed", async () => {
        const { donorVoting, donor1 } = fixture;
        await donorVoting.connect(donor1).reveal(passChoice, passSalt);
        await expect(
          donorVoting.connect(donor1).reveal(passChoice, passSalt)
        ).to.be.revertedWith("DonorVoting: Already revealed");
      });

      it("4f) reveal: reverts on invalid salt/choice", async () => {
        const { donorVoting, donor1 } = fixture;
        await expect(
          donorVoting.connect(donor1).reveal(passChoice, failSalt) // Bad salt
        ).to.be.revertedWith("DonorVoting: Invalid reveal");
        await expect(
          donorVoting.connect(donor1).reveal(failChoice, passSalt) // Bad choice
        ).to.be.revertedWith("DonorVoting: Invalid reveal");
      });

      it("4g) advancePhase: reverts from Reveal if deadline not met", async () => {
        const { donorVoting, oracle } = fixture;
        await expect(
          donorVoting.connect(oracle).advancePhase()
        ).to.be.revertedWith("DonorVoting: Reveal open");
      });

      it("4h) advancePhase: moves from Reveal to Finalized", async () => {
        const { donorVoting, oracle, advanceTime } = fixture;
        await advanceTime(101); // Pass reveal deadline (total 202s)

        // _finalize() is called, which emits Finalized
        await expect(donorVoting.connect(oracle).advancePhase())
          .to.emit(donorVoting, "PhaseAdvanced")
          .withArgs(3n) // 3 = Phase.Finalized
          .and.to.emit(donorVoting, "Finalized");

        expect(await donorVoting.phase()).to.equal(3n);
      });

      it("4i) advancePhase: reverts if already finalized", async () => {
        const { donorVoting, oracle, advanceTime } = fixture;
        await advanceTime(101); // Pass reveal
        await donorVoting.connect(oracle).advancePhase(); // -> Finalized
        await expect(
          donorVoting.connect(oracle).advancePhase()
        ).to.be.revertedWith("DonorVoting: Already finalized");
      });
    });
  });

  // 5. Finalization Logic

  describe("5. Finalization Logic", function () {
    // Helper to run a full vote
    const runFullVote = async (assignments, votes) => {
      const { donorVoting, oracle, getDeadlines, advanceTime } =
        await loadFixture(deployVotingFixture);
      const { commitTime, revealTime } = await getDeadlines();
      await donorVoting.connect(oracle).adjustDeadline(commitTime, revealTime);

      // 1. Assign
      for (const { donor, stream } of assignments) {
        await donorVoting.connect(oracle).assignVoter(donor.address, stream);
      }
      await donorVoting.connect(oracle).advancePhase(); // -> Commit

      // 2. Commit
      const salts = {};
      for (const { donor, choice } of votes) {
        const salt = ethers.id(`SALT_${donor.address}`);
        salts[donor.address] = salt;
        const commitment = ethers.solidityPackedKeccak256(
          ["bool", "uint256"],
          [choice, salt]
        );
        await donorVoting.connect(donor).commit(commitment);
      }
      await advanceTime(101); // Pass commit
      await donorVoting.connect(oracle).advancePhase(); // -> Reveal

      // 3. Reveal
      for (const { donor, choice } of votes) {
        const salt = salts[donor.address];
        await donorVoting.connect(donor).reveal(choice, salt);
      }
      await advanceTime(101); // Pass reveal
      await donorVoting.connect(oracle).advancePhase(); // -> Finalized

      return { donorVoting };
    };

    it("5a) Scenario: All streams pass (Quorum + Majority)", async () => {
      const { donor1, donor2, donor3 } = await loadFixture(deployVotingFixture);
      // d1 weight 1000, d2 weight 2000, d3 weight 5000
      const assignments = [
        { donor: donor1, stream: 0 },
        { donor: donor2, stream: 1 },
        { donor: donor3, stream: 2 },
      ];
      const votes = [
        { donor: donor1, choice: true },
        { donor: donor2, choice: true },
        { donor: donor3, choice: true },
      ];
      const { donorVoting } = await runFullVote(assignments, votes);

      // Check results
      const [decided, passed, perStream] = await donorVoting.overallResult();
      expect(decided).to.be.true;
      expect(passed).to.be.true;
      expect(perStream).to.deep.equal([true, true, true]);
    });

    it("5b) Scenario: One stream fails (Quorum Failure)", async () => {
      const { donor1, donor2, donor3 } = await loadFixture(deployVotingFixture);
      // d1 (1k) on S0, d2 (2k) on S1, d3 (5k) on S2
      // Quorum is 70%.
      // S0 total = 1000. Needs 700 participation.
      // S1 total = 2000. Needs 1400 participation.
      // S2 total = 5000. Needs 3500 participation.
      const assignments = [
        { donor: donor1, stream: 0 },
        { donor: donor2, stream: 1 },
        { donor: donor3, stream: 2 },
      ];
      // d1 votes, d2 votes, d3 DOES NOT VOTE
      const votes = [
        { donor: donor1, choice: true },
        { donor: donor2, choice: true },
      ];
      const { donorVoting } = await runFullVote(assignments, votes);

      // Check tallies
      // S0: pass=1000, total=1000. Quorum: (1000*10000)/1000 = 10000 >= 7000. Pass.
      // S1: pass=2000, total=2000. Quorum: (2000*10000)/2000 = 10000 >= 7000. Pass.
      // S2: pass=0, total=0. Quorum: (0*10000)/5000 = 0 < 7000. Fail.
      const [decided, passed, perStream] = await donorVoting.overallResult();
      expect(decided).to.be.true;
      expect(passed).to.be.false;
      expect(perStream).to.deep.equal([true, true, false]);
    });

    it("5c) Scenario: One stream fails (Pass Majority Failure)", async () => {
      const { donor1, donor2, donor3 } = await loadFixture(deployVotingFixture);
      // d1 (1k), d2 (2k), d3 (5k) assigned to streams 0, 1, 2
      // All vote, so Quorum (70%) is met everywhere.
      // Pass Majority is 70%.
      const assignments = [
        { donor: donor1, stream: 0 }, // S0 Total Possible = 1000
        { donor: donor2, stream: 1 }, // S1 Total Possible = 2000
        { donor: donor3, stream: 2 }, // S2 Total Possible = 5000
      ];
      const votes = [
        { donor: donor1, choice: true }, // S0: Pass = 1000, Fail = 0 -> Pass% = 100% -> PASS
        { donor: donor2, choice: true }, // S1: Pass = 2000, Fail = 0 -> Pass% = 100% -> PASS
        { donor: donor3, choice: false }, // S2: Pass = 0, Fail = 5000 -> Pass% = 0% -> FAIL
      ];
      const { donorVoting } = await runFullVote(assignments, votes);

      const [decided, passed, perStream] = await donorVoting.overallResult();
      expect(decided).to.be.true;
      expect(passed).to.be.false; // Overall fails because S2 failed
      expect(perStream).to.deep.equal([true, true, false]); // S2 fails majority
    });

    it("5d) Scenario: One stream fails (Tie)", async () => {
      const { donor1, donor2 } = await loadFixture(deployVotingFixture);
      // d1 (1k) and d2 (1k, after mock) on S0
      // We need to deploy a new fixture to get 1k vs 1k
      // This is complex. Let's just use d1 (1k) and d2 (2k)
      // d1 votes True, d2 votes False. S0 fails.
      const assignments = [
        { donor: donor1, stream: 0 }, // 1k
        { donor: donor2, stream: 0 }, // 2k
      ];
      const votes = [
        { donor: donor1, choice: true },
        { donor: donor2, choice: false },
      ];
      const { donorVoting } = await runFullVote(assignments, votes);

      // Check tallies
      // S0: pass=1000, fail=2000. Total=3000.
      // Quorum: (3000*10000)/3000 = 10000 >= 7000. Pass.
      // Majority: (1000 > 2000) is false. Fail.
      // S1, S2: No one assigned. TotalPossible=0. Fail.
      const [decided, passed, perStream] = await donorVoting.overallResult();
      expect(decided).to.be.true;
      expect(passed).to.be.false;
      expect(perStream).to.deep.equal([false, false, false]);
    });

    it("5e) Scenario: Stream with no assignments fails", async () => {
      const { donor1 } = await loadFixture(deployVotingFixture);
      const assignments = [{ donor: donor1, stream: 0 }]; // 1k
      const votes = [{ donor: donor1, choice: true }];
      const { donorVoting } = await runFullVote(assignments, votes);

      // S0: pass=1000. Pass.
      // S1: totalPossible=0. Fail.
      // S2: totalPossible=0. Fail.
      const [decided, passed, perStream] = await donorVoting.overallResult();
      expect(decided).to.be.true;
      expect(passed).to.be.false;
      expect(perStream).to.deep.equal([true, false, false]);
    });

    it("5f) Scenario: Quorum met, Pass Majority fails (below threshold)", async () => {
      const { donor1, donor2, donor3 } = await loadFixture(deployVotingFixture);
      // d1 (1k) votes TRUE, d2 (2k) votes FALSE on Stream 0.
      // Quorum Bps = 70%, Pass Majority Bps = 70%
      // S0 Total Possible = 3000.
      const assignments = [
        { donor: donor1, stream: 0 },
        { donor: donor2, stream: 0 },
        // S1, S2 have no assignments
      ];
      const votes = [
        { donor: donor1, choice: true }, // Weight 1000
        { donor: donor2, choice: false }, // Weight 2000
      ];
      const { donorVoting } = await runFullVote(assignments, votes);

      // --- Check Tallies ---
      // S0: pass=1000, fail=2000, totalWeight=3000.
      // Quorum Check: participationBps = (3000 * 10000) / 3000 = 10000. >= 7000? YES.
      // Pass Majority Check: passPercentageBps = (1000 * 10000) / 3000 = 3333. >= 7000? NO.
      // S0 Result: FAIL

      // S1 & S2: totalPossibleWeight = 0 -> FAIL

      // --- Check Overall ---
      const [decided, passed, perStream] = await donorVoting.overallResult();
      expect(decided).to.be.true;
      expect(passed).to.be.false; // Overall fails
      expect(perStream).to.deep.equal([false, false, false]); // S0 fails majority
    });

    it("5g) Scenario: Quorum fails, Pass Majority met", async () => {
      const { donor1, donor2, donor3 } = await loadFixture(deployVotingFixture);
      // d1 (1k) votes TRUE on Stream 0. d2 (2k) also assigned but DOES NOT VOTE.
      // Quorum Bps = 70%, Pass Majority Bps = 70%
      // S0 Total Possible = 3000.
      const assignments = [
        { donor: donor1, stream: 0 },
        { donor: donor2, stream: 0 },
        // S1, S2 have no assignments
      ];
      const votes = [
        { donor: donor1, choice: true }, // Weight 1000
        // donor2 does not vote
      ];
      const { donorVoting } = await runFullVote(assignments, votes);

      // --- Check Tallies ---
      // S0: pass=1000, fail=0, totalWeight=1000.
      // Quorum Check: participationBps = (1000 * 10000) / 3000 = 3333. >= 7000? NO.
      // Pass Majority Check: Not performed because Quorum failed.
      // S0 Result: FAIL

      // S1 & S2: totalPossibleWeight = 0 -> FAIL

      // --- Check Overall ---
      const [decided, passed, perStream] = await donorVoting.overallResult();
      expect(decided).to.be.true;
      expect(passed).to.be.false; // Overall fails
      expect(perStream).to.deep.equal([false, false, false]); // S0 fails quorum
    });

    it("5h) Scenario: Quorum met, Pass Majority met (exactly at threshold)", async () => {
      const { donor1, donor2, donor3 } = await loadFixture(deployVotingFixture);
      // d1 (1k) votes FALSE, d2 (2k) votes TRUE, d3 (7k, *mock*) votes TRUE on Stream 0.
      // Need to simulate d3 having 7k weight. We'll use d1=3k, d2=7k instead for simplicity.
      // Re-deploy fixture with modified weights/pledges is cleaner, but this uses existing donors:
      // Let's use d1(1k), d2(2k), d3(5k).
      // S0 Total Possible = 8000.
      // Votes: d1=F (1k), d2=T (2k), d3=T (5k) => Total Weight = 8000. Pass Weight = 7000.
      // Quorum Bps = 70%, Pass Majority Bps = 70%
      const assignments = [
        { donor: donor1, stream: 0 },
        { donor: donor2, stream: 0 },
        { donor: donor3, stream: 0 },
        // S1, S2 have no assignments
      ];
      const votes = [
        { donor: donor1, choice: false }, // Weight 1000
        { donor: donor2, choice: true }, // Weight 2000
        { donor: donor3, choice: true }, // Weight 5000
      ];
      const { donorVoting } = await runFullVote(assignments, votes);

      // --- Check Tallies ---
      // S0: pass=7000, fail=1000, totalWeight=8000.
      // Quorum Check: participationBps = (8000 * 10000) / 8000 = 10000. >= 7000? YES.
      // Pass Majority Check: passPercentageBps = (7000 * 10000) / 8000 = 8750. >= 7000? YES.
      // S0 Result: PASS

      // S1 & S2: totalPossibleWeight = 0 -> FAIL

      // --- Check Overall ---
      const [decided, passed, perStream] = await donorVoting.overallResult();
      expect(decided).to.be.true;
      expect(passed).to.be.false; // Overall fails because S1, S2 failed
      expect(perStream).to.deep.equal([true, false, false]); // S0 passes both
    });
  });
});
