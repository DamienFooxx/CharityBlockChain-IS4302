/* eslint-disable no-undef */
const { expect } = require("chai");
const { ethers } = require("hardhat");

// Note: Contract calls return BigInt. Use 5000n (BigInt) rather than 5000 (Number).

describe("SGDCoin", function () {
  let owner, alice, bob, spender, other;
  let sgd;

  async function deploy() {
    [owner, alice, bob, spender, other] = await ethers.getSigners();
    const SGDCoin = await ethers.getContractFactory("SGDCoin");
    sgd = await SGDCoin.deploy();
    await sgd.waitForDeployment();
  }

  beforeEach(async () => {
    await deploy();
  });

  // 1) Deployment & Metadata
  it("1) deploys with correct metadata and zero supply", async () => {
    expect(await sgd.name()).to.equal("SGD Coin");
    expect(await sgd.symbol()).to.equal("SGD");
    expect(await sgd.decimals()).to.equal(18);
    expect(await sgd.totalSupply()).to.equal(0n);
  });

  it("2) sets the deployer as owner", async () => {
    expect(await sgd.owner()).to.equal(await owner.getAddress());
  });

  // 3) Approve / Allowance
  it("3) approve sets allowance and emits Approval", async () => {
    const amount = 123n;
    await expect(sgd.connect(alice).approve(await spender.getAddress(), amount))
      .to.emit(sgd, "Approval")
      .withArgs(await alice.getAddress(), await spender.getAddress(), amount);

    const a = await sgd.allowance(await alice.getAddress(), await spender.getAddress());
    expect(a).to.equal(amount);
  });

  it("4) approve overwrites previous allowance", async () => {
    await sgd.connect(alice).approve(await spender.getAddress(), 100n);
    expect(await sgd.allowance(await alice.getAddress(), await spender.getAddress())).to.equal(100n);

    await sgd.connect(alice).approve(await spender.getAddress(), 7n);
    expect(await sgd.allowance(await alice.getAddress(), await spender.getAddress())).to.equal(7n);
  });

  // 5) Transfer (requires balances)
  describe("5) transfer", () => {
    beforeEach(async () => {
      // owner mints to alice for testing transfers
      await sgd.connect(owner).mint(await alice.getAddress(), 1_000n);
    });

    it("5a) moves tokens and emits Transfer", async () => {
      await expect(sgd.connect(alice).transfer(await bob.getAddress(), 250n))
        .to.emit(sgd, "Transfer")
        .withArgs(await alice.getAddress(), await bob.getAddress(), 250n);

      expect(await sgd.balanceOf(await alice.getAddress())).to.equal(750n);
      expect(await sgd.balanceOf(await bob.getAddress())).to.equal(250n);
    });

    it("5b) reverts on insufficient balance", async () => {
      await expect(
        sgd.connect(bob).transfer(await alice.getAddress(), 1n)
      ).to.be.revertedWith("Insufficient balance");
    });

    it("5c) reverts if recipient is zero address", async () => {
      await expect(
        sgd.connect(alice).transfer(ethers.ZeroAddress, 10n)
      ).to.be.revertedWith("Invalid address");
    });

    it("5d) allows self-transfer (including 0) and preserves supply", async () => {
      const supplyBefore = await sgd.totalSupply();
      await sgd.connect(alice).transfer(await alice.getAddress(), 0n);
      await sgd.connect(alice).transfer(await alice.getAddress(), 100n);
      expect(await sgd.balanceOf(await alice.getAddress())).to.equal(1000n);
      expect(await sgd.totalSupply()).to.equal(supplyBefore);
    });
  });

  // 6) transferFrom
  describe("6) transferFrom", () => {
    beforeEach(async () => {
      await sgd.connect(owner).mint(await alice.getAddress(), 500n);
      await sgd.connect(alice).approve(await spender.getAddress(), 200n);
    });

    it("6a) transfers on behalf and decreases allowance", async () => {
      await expect(
        sgd.connect(spender).transferFrom(
          await alice.getAddress(),
          await bob.getAddress(),
          150n
        )
      )
        .to.emit(sgd, "Transfer")
        .withArgs(await alice.getAddress(), await bob.getAddress(), 150n);

      expect(await sgd.balanceOf(await alice.getAddress())).to.equal(350n);
      expect(await sgd.balanceOf(await bob.getAddress())).to.equal(150n);
      expect(
        await sgd.allowance(await alice.getAddress(), await spender.getAddress())
      ).to.equal(50n);
    });

    it("6b) reverts when allowance exceeded", async () => {
      await expect(
        sgd.connect(spender).transferFrom(
          await alice.getAddress(),
          await bob.getAddress(),
          201n
        )
      ).to.be.revertedWith("Allowance exceeded");
    });

    it("6c) reverts when from balance insufficient", async () => {
      // reduce alice balance to 10
      await sgd.connect(alice).transfer(await other.getAddress(), 490n);
      await expect(
        sgd.connect(spender).transferFrom(
          await alice.getAddress(),
          await bob.getAddress(),
          50n
        )
      ).to.be.revertedWith("Insufficient balance");
    });

    it("6d) reverts if recipient is zero address", async () => {
      await expect(
        sgd.connect(spender).transferFrom(
          await alice.getAddress(),
          ethers.ZeroAddress,
          10n
        )
      ).to.be.revertedWith("Invalid address");
    });
  });

  // 7) Mint (onlyOwner)
  describe("7) mint (onlyOwner)", () => {
    it("7a) owner can mint; balances and totalSupply updated; events emitted", async () => {
      const to = await bob.getAddress();
      const amount = 1_234n;

      await expect(sgd.connect(owner).mint(to, amount))
        .to.emit(sgd, "Mint").withArgs(to, amount)
        .and.to.emit(sgd, "Transfer").withArgs(ethers.ZeroAddress, to, amount);

      expect(await sgd.balanceOf(to)).to.equal(amount);
      expect(await sgd.totalSupply()).to.equal(amount);
    });

    it("7b) non-owner cannot mint", async () => {
      await expect(
        sgd.connect(alice).mint(await alice.getAddress(), 1n)
      ).to.be.revertedWith("Only owner");
    });

    it("7c) reverts on zero amount", async () => {
      await expect(
        sgd.connect(owner).mint(await alice.getAddress(), 0n)
      ).to.be.revertedWith("Amount must be positive");
    });

    it("7d) reverts on zero address", async () => {
      await expect(
        sgd.connect(owner).mint(ethers.ZeroAddress, 10n)
      ).to.be.revertedWith("Invalid address");
    });
  });

  // 8) Burn (onlyOwner)
  describe("8) burn (onlyOwner)", () => {
    beforeEach(async () => {
      await sgd.connect(owner).mint(await alice.getAddress(), 1_000n);
    });

    it("8a) owner can burn from an account; updates balances & supply; emits events", async () => {
      const from = await alice.getAddress();
      const amount = 400n;
      const supplyBefore = await sgd.totalSupply();

      await expect(sgd.connect(owner).burn(from, amount))
        .to.emit(sgd, "Burn").withArgs(from, amount)
        .and.to.emit(sgd, "Transfer").withArgs(from, ethers.ZeroAddress, amount);

      expect(await sgd.balanceOf(from)).to.equal(600n);
      expect(await sgd.totalSupply()).to.equal(supplyBefore - amount);
    });

    it("8b) non-owner cannot burn", async () => {
      await expect(
        sgd.connect(bob).burn(await alice.getAddress(), 1n)
      ).to.be.revertedWith("Only owner");
    });

    it("8c) reverts when burning more than balance", async () => {
      await expect(
        sgd.connect(owner).burn(await alice.getAddress(), 1_001n)
      ).to.be.revertedWith("Insufficient balance");
    });

    it("8d) reverts on zero amount", async () => {
      await expect(
        sgd.connect(owner).burn(await alice.getAddress(), 0n)
      ).to.be.revertedWith("Amount must be positive");
    });

    it("8e) reverts on zero address", async () => {
      await expect(
        sgd.connect(owner).burn(ethers.ZeroAddress, 10n)
      ).to.be.revertedWith("Invalid address");
    });
  });

  // 9) Invariant / Accounting conservation
  it("9) mint → transfer → burn conserves accounting", async () => {
    await sgd.connect(owner).mint(await owner.getAddress(), 10_000n);
    await sgd.connect(owner).transfer(await alice.getAddress(), 2_000n);
    await sgd.connect(owner).transfer(await bob.getAddress(), 1_000n);

    const supplyBefore = await sgd.totalSupply();
    await sgd.connect(owner).burn(await alice.getAddress(), 500n);
    await sgd.connect(owner).burn(await bob.getAddress(), 250n);

    const totalBalances =
      (await sgd.balanceOf(await owner.getAddress())) +
      (await sgd.balanceOf(await alice.getAddress())) +
      (await sgd.balanceOf(await bob.getAddress()));

    expect(await sgd.totalSupply()).to.equal(supplyBefore - 750n);
    expect(totalBalances).to.equal(await sgd.totalSupply());
  });
});
