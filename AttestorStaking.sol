// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title AttestorStaking
 * @dev Handles staking, unstaking, and slashing for attestors.
 * Designed to be called by AttestorRegistry or DAO-controlled contracts.
 * This is the single source of truth for stake amounts.
 */

contract AttestorStaking {
    address public admin;
    address public registry; // Only registry can slash
    uint256 public minStake;
    uint256 public withdrawalDelay = 7 days; // Time-lock for withdrawals

    mapping(address => uint256) private stakes;
    mapping(address => uint256) private withdrawalRequests; // timestamp when withdrawal requested

    event Staked(address indexed attestor, uint256 amount);
    event WithdrawalRequested(address indexed attestor, uint256 timestamp);
    event Unstaked(address indexed attestor, uint256 amount);
    event Slashed(address indexed attestor, uint256 amount);
    event AdminChanged(address newAdmin);
    event RegistryChanged(address newRegistry);
    event MinStakeChanged(uint256 newMinStake);
    event WithdrawalDelayChanged(uint256 newDelay);

    modifier onlyAdmin() {
        require(msg.sender == admin, "Not admin");
        _;
    }

    modifier onlyRegistry() {
        require(msg.sender == registry, "Not registry");
        _;
    }

    constructor(uint256 _minStake, address _registry) {
        admin = msg.sender;
        registry = _registry;
        minStake = _minStake;
    }

    // -----------CORE FUNCTIONS-----------

    /**
     * @dev Stake ETH to become or remain an active attestor.
     */
    function stake() external payable {
        require(msg.value > 0, "Must stake non-zero amount");

        // If there's a pending withdrawal, require minimum delay has passed
        // or require explicit cancellation
        if (withdrawalRequests[msg.sender] > 0) {
            require(
                block.timestamp >=
                    withdrawalRequests[msg.sender] + (withdrawalDelay / 2),
                "Must wait or cancel withdrawal first"
            );
            // If they've waited half the delay, allow new stake and reset timer
            withdrawalRequests[msg.sender] = 0;
        }

        stakes[msg.sender] += msg.value;
        emit Staked(msg.sender, msg.value);
    }

    /**
     * @dev Request withdrawal - starts time-lock period.
     */
    function requestWithdrawal() external {
        require(stakes[msg.sender] > 0, "No stake to withdraw");
        require(
            withdrawalRequests[msg.sender] == 0,
            "Withdrawal already pending"
        );

        withdrawalRequests[msg.sender] = block.timestamp;
        emit WithdrawalRequested(msg.sender, block.timestamp);
    }

    /**
     * @dev Withdraw available stake after time-lock period.
     */
    function unstake(uint256 amount) external {
        require(stakes[msg.sender] >= amount, "Insufficient stake");
        require(
            withdrawalRequests[msg.sender] > 0,
            "Must request withdrawal first"
        );
        require(
            block.timestamp >= withdrawalRequests[msg.sender] + withdrawalDelay,
            "Withdrawal time-lock active"
        );

        stakes[msg.sender] -= amount;
        withdrawalRequests[msg.sender] = 0;

        payable(msg.sender).transfer(amount);
        emit Unstaked(msg.sender, amount);
    }

    /**
     * @dev Cancel a pending withdrawal request.
     */
    function cancelWithdrawal() external {
        require(withdrawalRequests[msg.sender] > 0, "No pending withdrawal");
        withdrawalRequests[msg.sender] = 0;
    }

    /**
     * @dev Slash stake for attestor misbehavior (called by registry).
     */
    function slash(
        address attestor,
        uint256 penalty
    ) external onlyRegistry returns (uint256) {
        uint256 deducted = penalty > stakes[attestor]
            ? stakes[attestor]
            : penalty;
        stakes[attestor] -= deducted;

        // Cancel any pending withdrawal on slash
        if (withdrawalRequests[attestor] > 0) {
            withdrawalRequests[attestor] = 0;
        }

        emit Slashed(attestor, deducted);
        return deducted;
    }

    /**
     * @dev Add stake as reward (called by registry).
     */
    function addStakeReward(
        address attestor,
        uint256 amount
    ) external onlyRegistry {
        stakes[attestor] += amount;
        emit Staked(attestor, amount);
    }

    /**
     * @dev Batch slash multiple attestors (gas optimization)
     */
    function batchSlash(
        address[] calldata attestors,
        uint256 penalty
    ) external onlyRegistry returns (uint256[] memory) {
        uint256[] memory deducted = new uint256[](attestors.length);

        for (uint256 i = 0; i < attestors.length; i++) {
            uint256 amount = penalty > stakes[attestors[i]]
                ? stakes[attestors[i]]
                : penalty;
            stakes[attestors[i]] -= amount;
            deducted[i] = amount;

            // Cancel pending withdrawals
            if (withdrawalRequests[attestors[i]] > 0) {
                withdrawalRequests[attestors[i]] = 0;
            }

            emit Slashed(attestors[i], amount);
        }

        return deducted;
    }

    /**
     * @dev Batch add stake rewards (gas optimization)
     */
    function batchAddStakeReward(
        address[] calldata attestors,
        uint256 amount
    ) external onlyRegistry {
        for (uint256 i = 0; i < attestors.length; i++) {
            stakes[attestors[i]] += amount;
            emit Staked(attestors[i], amount);
        }
    }

    // -----------VIEWS & ADMIN-----------

    function getStake(address attestor) external view returns (uint256) {
        return stakes[attestor];
    }

    function getWithdrawalRequest(
        address attestor
    ) external view returns (uint256) {
        return withdrawalRequests[attestor];
    }

    function canWithdraw(address attestor) external view returns (bool) {
        if (withdrawalRequests[attestor] == 0) return false;
        return
            block.timestamp >= withdrawalRequests[attestor] + withdrawalDelay;
    }

    function setMinStake(uint256 _minStake) external onlyAdmin {
        minStake = _minStake;
        emit MinStakeChanged(_minStake);
    }

    function setWithdrawalDelay(uint256 _delay) external onlyAdmin {
        withdrawalDelay = _delay;
        emit WithdrawalDelayChanged(_delay);
    }

    function setRegistry(address _registry) external onlyAdmin {
        require(_registry != address(0), "Invalid registry address");
        registry = _registry;
        emit RegistryChanged(_registry);
    }

    function transferAdmin(address newAdmin) external onlyAdmin {
        require(newAdmin != address(0), "Invalid admin address");
        admin = newAdmin;
        emit AdminChanged(newAdmin);
    }

    /**
     * @dev Emergency withdraw slashed funds to treasury/DAO.
     */
    function withdrawSlashedFunds(
        address payable treasury,
        uint256 amount
    ) external onlyAdmin {
        require(treasury != address(0), "Invalid treasury address");
        require(address(this).balance >= amount, "Insufficient balance");
        treasury.transfer(amount);
    }

    receive() external payable {}
}
