const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

/**
 * TEST SUITE: AttestorStaking Contract (SGD Token Version)
 * 
 * This test suite validates the SGD token-based staking functionality including:
 * - Stake deposits and withdrawals using SGD tokens
 * - Token approval requirements
 * - Time-lock mechanisms
 * - Slashing penalties
 * - Batch operations for gas optimization
 * - Access control for registry-only functions
 */
describe("AttestorStaking (SGD Token)", function () {
  let stakingContract, sgdToken;
  let admin, registry, attestor1, attestor2, attestor3, nonRegistry;
  const MIN_STAKE = ethers.parseEther("1000"); // 1000 SGD
  const WITHDRAWAL_DELAY = 7 * 24 * 60 * 60; // 7 days in seconds

  beforeEach(async function () {
    [admin, registry, attestor1, attestor2, attestor3, nonRegistry] = await ethers.getSigners();

    // Deploy SGDCoin
    const SGDCoin = await ethers.getContractFactory("SGDCoin");
    sgdToken = await SGDCoin.deploy();
    await sgdToken.waitForDeployment();

    // Deploy AttestorStaking with SGD token
    const AttestorStaking = await ethers.getContractFactory("AttestorStaking");
    stakingContract = await AttestorStaking.deploy(
      MIN_STAKE,
      registry.address,
      await sgdToken.getAddress()
    );
    await stakingContract.waitForDeployment();

    // Mint SGD tokens for test users
    await sgdToken.mint(attestor1.address, ethers.parseEther("10000"));
    await sgdToken.mint(attestor2.address, ethers.parseEther("10000"));
    await sgdToken.mint(attestor3.address, ethers.parseEther("10000"));
    await sgdToken.mint(registry.address, ethers.parseEther("10000"));
  });

  describe("Deployment", function () {
    /**
     * TEST: Contract initializes with correct admin
     * OUTCOME: Admin should be the deployer address
     */
    it("Should set the correct admin", async function () {
      expect(await stakingContract.admin()).to.equal(admin.address);
    });

    /**
     * TEST: Contract initializes with correct registry
     * OUTCOME: Registry should match constructor parameter
     */
    it("Should set the correct registry", async function () {
      expect(await stakingContract.registry()).to.equal(registry.address);
    });

    /**
     * TEST: Contract initializes with correct minimum stake
     * OUTCOME: minStake should equal the constructor parameter
     */
    it("Should set the correct minimum stake", async function () {
      expect(await stakingContract.minStake()).to.equal(MIN_STAKE);
    });

    /**
     * TEST: Contract initializes with correct SGD token
     * OUTCOME: sgdToken address should match
     */
    it("Should set the correct SGD token", async function () {
      expect(await stakingContract.sgdToken()).to.equal(await sgdToken.getAddress());
    });

    /**
     * TEST: Contract initializes with correct withdrawal delay
     * OUTCOME: Withdrawal delay should be 7 days
     */
    it("Should set default withdrawal delay", async function () {
      expect(await stakingContract.withdrawalDelay()).to.equal(WITHDRAWAL_DELAY);
    });
  });

  describe("Staking with SGD Tokens", function () {
    /**
     * TEST: Users can stake SGD tokens successfully
     * OUTCOME: Stake balance should increase, tokens transferred
     */
    it("Should allow users to stake SGD tokens", async function () {
      const stakeAmount = ethers.parseEther("2000");
      
      // Approve staking contract to spend tokens
      await sgdToken.connect(attestor1).approve(
        await stakingContract.getAddress(),
        stakeAmount
      );

      await expect(stakingContract.connect(attestor1).stake(stakeAmount))
        .to.emit(stakingContract, "Staked")
        .withArgs(attestor1.address, stakeAmount);

      expect(await stakingContract.getStake(attestor1.address)).to.equal(stakeAmount);
      
      // Check token was transferred
      expect(await sgdToken.balanceOf(await stakingContract.getAddress())).to.equal(stakeAmount);
    });

    /**
     * TEST: Staking fails without approval
     * OUTCOME: Transaction should revert
     */
    it("Should reject staking without token approval", async function () {
      const stakeAmount = ethers.parseEther("2000");
      
      // Don't approve tokens
      await expect(
        stakingContract.connect(attestor1).stake(stakeAmount)
      ).to.be.revertedWith("SGD transfer failed");
    });

    /**
     * TEST: Staking fails with insufficient approval
     * OUTCOME: Transaction should revert
     */
    it("Should reject staking with insufficient approval", async function () {
      const stakeAmount = ethers.parseEther("2000");
      const approvalAmount = ethers.parseEther("1000");
      
      await sgdToken.connect(attestor1).approve(
        await stakingContract.getAddress(),
        approvalAmount
      );

      await expect(
        stakingContract.connect(attestor1).stake(stakeAmount)
      ).to.be.revertedWith("SGD transfer failed");
    });

    /**
     * TEST: Staking zero amount should fail
     * OUTCOME: Transaction should revert with error message
     */
    it("Should reject zero stake amount", async function () {
      await expect(
        stakingContract.connect(attestor1).stake(0)
      ).to.be.revertedWith("Must stake non-zero amount");
    });

    /**
     * TEST: Multiple stakes should accumulate
     * OUTCOME: Total stake should be sum of all deposits
     */
    it("Should accumulate multiple stakes", async function () {
      const stake1 = ethers.parseEther("1000");
      const stake2 = ethers.parseEther("500");

      // First stake
      await sgdToken.connect(attestor1).approve(
        await stakingContract.getAddress(),
        stake1
      );
      await stakingContract.connect(attestor1).stake(stake1);

      // Second stake
      await sgdToken.connect(attestor1).approve(
        await stakingContract.getAddress(),
        stake2
      );
      await stakingContract.connect(attestor1).stake(stake2);

      expect(await stakingContract.getStake(attestor1.address)).to.equal(stake1 + stake2);
    });

    /**
     * TEST: Staking requires cancellation or waiting with pending withdrawal
     * OUTCOME: Should enforce half delay or cancellation
     */
    it("Should require waiting period with pending withdrawal", async function () {
      const stakeAmount = ethers.parseEther("2000");
      
      // Initial stake
      await sgdToken.connect(attestor1).approve(
        await stakingContract.getAddress(),
        stakeAmount
      );
      await stakingContract.connect(attestor1).stake(stakeAmount);
      
      // Request withdrawal
      await stakingContract.connect(attestor1).requestWithdrawal();
      
      // Try to stake again immediately - should fail
      await sgdToken.connect(attestor1).approve(
        await stakingContract.getAddress(),
        stakeAmount
      );
      await expect(
        stakingContract.connect(attestor1).stake(stakeAmount)
      ).to.be.revertedWith("Must wait or cancel withdrawal first");
      
      // Cancel withdrawal
      await stakingContract.connect(attestor1).cancelWithdrawal();
      
      // Now staking should work
      await expect(
        stakingContract.connect(attestor1).stake(stakeAmount)
      ).to.not.be.reverted;
    });
  });

  describe("stakeFor Function (Registry Only)", function () {
    /**
     * TEST: Registry can stake on behalf of another address
     * OUTCOME: Target address should receive the stake
     */
    it("Should allow registry to stake for another address", async function () {
      const stakeAmount = ethers.parseEther("2000");
      
      // Registry approves and stakes for attestor1
      await sgdToken.connect(registry).approve(
        await stakingContract.getAddress(),
        stakeAmount
      );

      await expect(
        stakingContract.connect(registry).stakeFor(attestor1.address, stakeAmount)
      )
        .to.emit(stakingContract, "Staked")
        .withArgs(attestor1.address, stakeAmount);

      expect(await stakingContract.getStake(attestor1.address)).to.equal(stakeAmount);
    });

    /**
     * TEST: stakeFor requires token approval from registry
     * OUTCOME: Should revert without approval
     */
    it("Should reject stakeFor without token approval", async function () {
      const stakeAmount = ethers.parseEther("2000");
      
      await expect(
        stakingContract.connect(registry).stakeFor(attestor1.address, stakeAmount)
      ).to.be.revertedWith("SGD transfer failed");
    });

    /**
     * TEST: Non-registry address cannot use stakeFor
     * OUTCOME: Transaction should revert with authorization error
     */
    it("Should reject stakeFor from non-registry", async function () {
      const stakeAmount = ethers.parseEther("2000");
      
      await sgdToken.connect(attestor1).approve(
        await stakingContract.getAddress(),
        stakeAmount
      );

      await expect(
        stakingContract.connect(attestor1).stakeFor(attestor2.address, stakeAmount)
      ).to.be.revertedWith("Not registry");
    });

    /**
     * TEST: stakeFor should cancel pending withdrawal for target address
     * OUTCOME: Withdrawal request should be reset
     */
    it("Should cancel pending withdrawal when staking for address", async function () {
      const stakeAmount = ethers.parseEther("2000");
      
      // Attestor stakes and requests withdrawal
      await sgdToken.connect(attestor1).approve(
        await stakingContract.getAddress(),
        stakeAmount
      );
      await stakingContract.connect(attestor1).stake(stakeAmount);
      await stakingContract.connect(attestor1).requestWithdrawal();
      
      // Verify withdrawal request exists
      expect(await stakingContract.getWithdrawalRequest(attestor1.address)).to.be.gt(0);
      
      // Registry stakes for attestor
      await sgdToken.connect(registry).approve(
        await stakingContract.getAddress(),
        stakeAmount
      );
      await stakingContract.connect(registry).stakeFor(attestor1.address, stakeAmount);
      
      // Withdrawal request should be cancelled
      expect(await stakingContract.getWithdrawalRequest(attestor1.address)).to.equal(0);
    });
  });

  describe("Withdrawal Requests", function () {
    /**
     * TEST: Attestor can request withdrawal
     * OUTCOME: Withdrawal request timestamp should be recorded
     */
    it("Should allow attestor to request withdrawal", async function () {
      const stakeAmount = ethers.parseEther("2000");
      
      await sgdToken.connect(attestor1).approve(
        await stakingContract.getAddress(),
        stakeAmount
      );
      await stakingContract.connect(attestor1).stake(stakeAmount);

      const tx = await stakingContract.connect(attestor1).requestWithdrawal();
      const receipt = await tx.wait();
      const block = await ethers.provider.getBlock(receipt.blockNumber);

      expect(await stakingContract.getWithdrawalRequest(attestor1.address)).to.equal(block.timestamp);
    });

    /**
     * TEST: Cannot request withdrawal without stake
     * OUTCOME: Transaction should revert
     */
    it("Should reject withdrawal request with no stake", async function () {
      await expect(
        stakingContract.connect(attestor1).requestWithdrawal()
      ).to.be.revertedWith("No stake to withdraw");
    });

    /**
     * TEST: Cannot request withdrawal twice
     * OUTCOME: Second request should revert
     */
    it("Should reject duplicate withdrawal requests", async function () {
      const stakeAmount = ethers.parseEther("2000");
      
      await sgdToken.connect(attestor1).approve(
        await stakingContract.getAddress(),
        stakeAmount
      );
      await stakingContract.connect(attestor1).stake(stakeAmount);
      await stakingContract.connect(attestor1).requestWithdrawal();
      
      await expect(
        stakingContract.connect(attestor1).requestWithdrawal()
      ).to.be.revertedWith("Withdrawal already pending");
    });

    /**
     * TEST: Attestor can cancel withdrawal request
     * OUTCOME: Withdrawal request should be cleared
     */
    it("Should allow cancellation of withdrawal request", async function () {
      const stakeAmount = ethers.parseEther("2000");
      
      await sgdToken.connect(attestor1).approve(
        await stakingContract.getAddress(),
        stakeAmount
      );
      await stakingContract.connect(attestor1).stake(stakeAmount);
      await stakingContract.connect(attestor1).requestWithdrawal();
      await stakingContract.connect(attestor1).cancelWithdrawal();

      expect(await stakingContract.getWithdrawalRequest(attestor1.address)).to.equal(0);
    });
  });

  describe("Unstaking (Withdrawing SGD)", function () {
    /**
     * TEST: Cannot unstake without withdrawal request
     * OUTCOME: Transaction should revert
     */
    it("Should reject unstake without withdrawal request", async function () {
      const stakeAmount = ethers.parseEther("2000");
      
      await sgdToken.connect(attestor1).approve(
        await stakingContract.getAddress(),
        stakeAmount
      );
      await stakingContract.connect(attestor1).stake(stakeAmount);

      await expect(
        stakingContract.connect(attestor1).unstake(stakeAmount)
      ).to.be.revertedWith("Must request withdrawal first");
    });

    /**
     * TEST: Cannot unstake before time-lock expires
     * OUTCOME: Transaction should revert during lock period
     */
    it("Should enforce withdrawal time-lock", async function () {
      const stakeAmount = ethers.parseEther("2000");
      
      await sgdToken.connect(attestor1).approve(
        await stakingContract.getAddress(),
        stakeAmount
      );
      await stakingContract.connect(attestor1).stake(stakeAmount);
      await stakingContract.connect(attestor1).requestWithdrawal();

      await expect(
        stakingContract.connect(attestor1).unstake(stakeAmount)
      ).to.be.revertedWith("Withdrawal time-lock active");
    });

    /**
     * TEST: Successful unstake after time-lock
     * OUTCOME: SGD tokens should be transferred back
     */
    it("Should allow unstake after time-lock period", async function () {
      const stakeAmount = ethers.parseEther("2000");
      
      await sgdToken.connect(attestor1).approve(
        await stakingContract.getAddress(),
        stakeAmount
      );
      await stakingContract.connect(attestor1).stake(stakeAmount);
      await stakingContract.connect(attestor1).requestWithdrawal();

      // Fast forward time by 7 days
      await time.increase(WITHDRAWAL_DELAY);

      const balanceBefore = await sgdToken.balanceOf(attestor1.address);
      
      await stakingContract.connect(attestor1).unstake(stakeAmount);

      const balanceAfter = await sgdToken.balanceOf(attestor1.address);

      expect(balanceAfter).to.equal(balanceBefore + stakeAmount);
      expect(await stakingContract.getStake(attestor1.address)).to.equal(0);
    });

    /**
     * TEST: Partial unstaking
     * OUTCOME: Should allow unstaking less than total stake
     */
    it("Should allow partial unstaking", async function () {
      const stakeAmount = ethers.parseEther("2000");
      const unstakeAmount = ethers.parseEther("1000");
      
      await sgdToken.connect(attestor1).approve(
        await stakingContract.getAddress(),
        stakeAmount
      );
      await stakingContract.connect(attestor1).stake(stakeAmount);
      await stakingContract.connect(attestor1).requestWithdrawal();
      await time.increase(WITHDRAWAL_DELAY);

      await stakingContract.connect(attestor1).unstake(unstakeAmount);

      expect(await stakingContract.getStake(attestor1.address)).to.equal(stakeAmount - unstakeAmount);
    });

    /**
     * TEST: Cannot unstake more than available stake
     * OUTCOME: Transaction should revert
     */
    it("Should reject unstaking more than staked amount", async function () {
      const stakeAmount = ethers.parseEther("1000");
      const unstakeAmount = ethers.parseEther("2000");
      
      await sgdToken.connect(attestor1).approve(
        await stakingContract.getAddress(),
        stakeAmount
      );
      await stakingContract.connect(attestor1).stake(stakeAmount);
      await stakingContract.connect(attestor1).requestWithdrawal();
      await time.increase(WITHDRAWAL_DELAY);

      await expect(
        stakingContract.connect(attestor1).unstake(unstakeAmount)
      ).to.be.revertedWith("Insufficient stake");
    });
  });

  describe("Slashing", function () {
    /**
     * TEST: Registry can slash attestor stake
     * OUTCOME: Stake should be reduced by penalty amount
     */
    it("Should allow registry to slash attestor", async function () {
      const stakeAmount = ethers.parseEther("2000");
      const slashAmount = ethers.parseEther("500");
      
      await sgdToken.connect(attestor1).approve(
        await stakingContract.getAddress(),
        stakeAmount
      );
      await stakingContract.connect(attestor1).stake(stakeAmount);

      await expect(stakingContract.connect(registry).slash(attestor1.address, slashAmount))
        .to.emit(stakingContract, "Slashed")
        .withArgs(attestor1.address, slashAmount);

      expect(await stakingContract.getStake(attestor1.address)).to.equal(stakeAmount - slashAmount);
    });

    /**
     * TEST: Non-registry cannot slash
     * OUTCOME: Transaction should revert with authorization error
     */
    it("Should reject slashing from non-registry address", async function () {
      const stakeAmount = ethers.parseEther("2000");
      const slashAmount = ethers.parseEther("500");
      
      await sgdToken.connect(attestor1).approve(
        await stakingContract.getAddress(),
        stakeAmount
      );
      await stakingContract.connect(attestor1).stake(stakeAmount);

      await expect(
        stakingContract.connect(nonRegistry).slash(attestor1.address, slashAmount)
      ).to.be.revertedWith("Not registry");
    });

    /**
     * TEST: Slashing more than stake deducts only available amount
     * OUTCOME: Should slash entire stake if penalty exceeds balance
     */
    it("Should slash only available stake if penalty exceeds balance", async function () {
      const stakeAmount = ethers.parseEther("1000");
      const slashAmount = ethers.parseEther("2000");
      
      await sgdToken.connect(attestor1).approve(
        await stakingContract.getAddress(),
        stakeAmount
      );
      await stakingContract.connect(attestor1).stake(stakeAmount);

      await stakingContract.connect(registry).slash(attestor1.address, slashAmount);
      
      expect(await stakingContract.getStake(attestor1.address)).to.equal(0);
    });

    /**
     * TEST: Slashing cancels pending withdrawals
     * OUTCOME: Withdrawal request should be cleared after slash
     */
    it("Should cancel pending withdrawal on slash", async function () {
      const stakeAmount = ethers.parseEther("2000");
      const slashAmount = ethers.parseEther("500");
      
      await sgdToken.connect(attestor1).approve(
        await stakingContract.getAddress(),
        stakeAmount
      );
      await stakingContract.connect(attestor1).stake(stakeAmount);
      await stakingContract.connect(attestor1).requestWithdrawal();
      
      expect(await stakingContract.getWithdrawalRequest(attestor1.address)).to.be.gt(0);
      
      await stakingContract.connect(registry).slash(attestor1.address, slashAmount);
      
      expect(await stakingContract.getWithdrawalRequest(attestor1.address)).to.equal(0);
    });
  });

  describe("Batch Operations", function () {
    /**
     * TEST: Batch slashing multiple attestors
     * OUTCOME: All specified attestors should be slashed correctly
     */
    it("Should batch slash multiple attestors", async function () {
      const stakeAmount = ethers.parseEther("2000");
      const slashAmount = ethers.parseEther("500");
      
      // Stake from multiple attestors
      for (let attestor of [attestor1, attestor2, attestor3]) {
        await sgdToken.connect(attestor).approve(
          await stakingContract.getAddress(),
          stakeAmount
        );
        await stakingContract.connect(attestor).stake(stakeAmount);
      }

      const attestors = [attestor1.address, attestor2.address, attestor3.address];
      
      await stakingContract.connect(registry).batchSlash(attestors, slashAmount);

      expect(await stakingContract.getStake(attestor1.address)).to.equal(stakeAmount - slashAmount);
      expect(await stakingContract.getStake(attestor2.address)).to.equal(stakeAmount - slashAmount);
      expect(await stakingContract.getStake(attestor3.address)).to.equal(stakeAmount - slashAmount);
    });

    /**
     * TEST: Batch adding stake rewards
     * OUTCOME: All specified attestors should receive reward amounts
     */
    it("Should batch add stake rewards", async function () {
      const stakeAmount = ethers.parseEther("1000");
      const rewardAmount = ethers.parseEther("100");
      
      // Initial stakes
      for (let attestor of [attestor1, attestor2]) {
        await sgdToken.connect(attestor).approve(
          await stakingContract.getAddress(),
          stakeAmount
        );
        await stakingContract.connect(attestor).stake(stakeAmount);
      }

      const attestors = [attestor1.address, attestor2.address];
      
      await stakingContract.connect(registry).batchAddStakeReward(attestors, rewardAmount);

      expect(await stakingContract.getStake(attestor1.address)).to.equal(stakeAmount + rewardAmount);
      expect(await stakingContract.getStake(attestor2.address)).to.equal(stakeAmount + rewardAmount);
    });

    /**
     * TEST: Non-registry cannot use batch operations
     * OUTCOME: Transactions should revert
     */
    it("Should reject batch operations from non-registry", async function () {
      const attestors = [attestor1.address, attestor2.address];
      const amount = ethers.parseEther("500");

      await expect(
        stakingContract.connect(nonRegistry).batchSlash(attestors, amount)
      ).to.be.revertedWith("Not registry");

      await expect(
        stakingContract.connect(nonRegistry).batchAddStakeReward(attestors, amount)
      ).to.be.revertedWith("Not registry");
    });
  });

  describe("Admin Functions", function () {
    /**
     * TEST: Admin can update minimum stake
     * OUTCOME: minStake should be updated
     */
    it("Should allow admin to update minimum stake", async function () {
      const newMinStake = ethers.parseEther("2000");
      
      await expect(stakingContract.connect(admin).setMinStake(newMinStake))
        .to.emit(stakingContract, "MinStakeChanged")
        .withArgs(newMinStake);

      expect(await stakingContract.minStake()).to.equal(newMinStake);
    });

    /**
     * TEST: Admin can update withdrawal delay
     * OUTCOME: withdrawalDelay should be updated
     */
    it("Should allow admin to update withdrawal delay", async function () {
      const newDelay = 14 * 24 * 60 * 60; // 14 days
      
      await expect(stakingContract.connect(admin).setWithdrawalDelay(newDelay))
        .to.emit(stakingContract, "WithdrawalDelayChanged")
        .withArgs(newDelay);

      expect(await stakingContract.withdrawalDelay()).to.equal(newDelay);
    });

    /**
     * TEST: Admin can transfer admin rights
     * OUTCOME: New address should become admin
     */
    it("Should allow admin to transfer admin rights", async function () {
      await expect(stakingContract.connect(admin).transferAdmin(attestor1.address))
        .to.emit(stakingContract, "AdminChanged")
        .withArgs(attestor1.address);

      expect(await stakingContract.admin()).to.equal(attestor1.address);
    });

    /**
     * TEST: Non-admin cannot call admin functions
     * OUTCOME: Transactions should revert
     */
    it("Should reject admin functions from non-admin", async function () {
      await expect(
        stakingContract.connect(attestor1).setMinStake(ethers.parseEther("2000"))
      ).to.be.revertedWith("Not admin");

      await expect(
        stakingContract.connect(attestor1).setRegistry(attestor2.address)
      ).to.be.revertedWith("Not admin");
    });

    /**
     * TEST: Admin can withdraw slashed funds (SGD tokens)
     * OUTCOME: SGD tokens should be transferred to treasury
     */
    it("Should allow admin to withdraw slashed funds", async function () {
      const stakeAmount = ethers.parseEther("2000");
      const slashAmount = ethers.parseEther("500");
      
      await sgdToken.connect(attestor1).approve(
        await stakingContract.getAddress(),
        stakeAmount
      );
      await stakingContract.connect(attestor1).stake(stakeAmount);
      await stakingContract.connect(registry).slash(attestor1.address, slashAmount);

      const treasuryBalanceBefore = await sgdToken.balanceOf(admin.address);
      
      await stakingContract.connect(admin).withdrawSlashedFunds(admin.address, slashAmount);
      
      const treasuryBalanceAfter = await sgdToken.balanceOf(admin.address);
      
      expect(treasuryBalanceAfter).to.equal(treasuryBalanceBefore + slashAmount);
    });
  });

  describe("View Functions", function () {
    /**
     * TEST: canWithdraw returns correct status
     * OUTCOME: Should return true only after time-lock expires
     */
    it("Should correctly report withdrawal eligibility", async function () {
      const stakeAmount = ethers.parseEther("2000");
      
      await sgdToken.connect(attestor1).approve(
        await stakingContract.getAddress(),
        stakeAmount
      );
      await stakingContract.connect(attestor1).stake(stakeAmount);
      
      // No withdrawal request
      expect(await stakingContract.canWithdraw(attestor1.address)).to.be.false;
      
      // Request withdrawal
      await stakingContract.connect(attestor1).requestWithdrawal();
      expect(await stakingContract.canWithdraw(attestor1.address)).to.be.false;
      
      // After time-lock
      await time.increase(WITHDRAWAL_DELAY);
      expect(await stakingContract.canWithdraw(attestor1.address)).to.be.true;
    });
  });
});
