// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "./AttestorRegistry.sol";
import "./Governance.sol";
import "./SGDCoin.sol";
import "./DonorVoting.sol";

/**
 * @title AttestorVoting
 * @notice
 * Implements the Oracle-facing and Attestor-facing functions for the AttestorVoting module.
 * This contract manages a commit-reveal-stake-slash-reward mechanism for expert attestors.
 *
 * @dev
 * This contract is instantiated per-event and controlled by the Oracle.
 * It uses a stakeToken (e.g., SGDCoin) for all financial operations.
 * It reads from a DonorVoting module to determine the "truth" for settlement.
 */
contract AttestorVoting {

    // State Variables
    Governance public immutable governance;
    SGDCoin public immutable stakeToken; // The ERC20 token used for staking/rewards

    uint8 public constant NUM_STREAMS = 3;
    uint256 public constant RAY = 1e27; // For high-precision reward calculation

    enum Phase { Pending, Commit, Reveal, Finalized }
    Phase public phase;

    uint256 public commitDeadline;
    uint256 public revealDeadline;
    uint256 public challengeWindow; // Delay (in seconds) after settlement before claiming

    // Oracle-Set Parameters
    uint256 public sigmaMin; // Minimum stake
    uint256 public sigmaMax; // Maximum stake (0 = no cap)
    uint256 public tau; // Reward pool divisor (Pool / tau)
    AttestorRegistry public immutable attestorRegistry;

    // Reward Pools (Internal Accounting)
    uint256 public RT; // Reward Pool for "True" (Pass) outcomes
    uint256 public RF; // Reward Pool for "False" (Fail) outcomes

    // Attestor Data
    mapping(address => uint8) public assignedStream; // attestor => stream
    mapping(address => bool) public isAssigned; // attestor => bool
    mapping(address => bytes32) public commitments; // attestor => hash
    mapping(address => uint256) public stakes; // attestor => stake amount
    mapping(address => bool) public revealed; // attestor => bool
    mapping(address => bool) public revealedChoice; // attestor => choice (true/false)
    mapping(address => bool) public hasClaimed; // attestor => bool

    // Finalization & Settlement Data
    struct Tally {
        uint256 passStake; // Total stake from attestors who voted "Pass" (True)
        uint256 failStake; // Total stake from attestors who voted "Fail" (False)
    }

    struct Settlement {
        bool settled; // True if settleStream has been called
        bool donorOutcomeTrue; // The "truth" from the DonorVoting module
        uint256 settledAt; // Timestamp of settlement (for challenge window)
        uint256 rewardPerStakeRay; // Payout per stake (using RAY precision)
        uint256 winnersStake;
        uint256 losersStake;
    }

    Tally[NUM_STREAMS] public tallies;
    Settlement[NUM_STREAMS] public settlements;

    /**
    * Events
     */

    // Oracle-facing events
    event SigmaBoundsUpdated(uint256 minSigma, uint256 maxSigma);
    event TauUpdated(uint256 oldTau, uint256 newTau);
    event PoolsFunded(uint256 newRT, uint256 newRF);
    event AttestorAssigned(address indexed attestor, uint8 stream);
    event DeadlinesAdjusted(uint256 commitDeadline, uint256 revealDeadline);
    event PhaseAdvanced(Phase newPhase);
    event Finalized(Tally[NUM_STREAMS] tallies); // Emits final tallies
    event ChallengeWindowSet(uint256 seconds_);
    event StreamSettled(
        uint8 indexed stream,
        bool donorOutcomeTrue,
        uint256 winnersStake,
        uint256 losersStake,
        uint256 poolSlice,
        uint256 rewardPerStakeRay
    );

    // Attestor-facing events
    event Committed(address indexed attestor, uint8 indexed stream, uint256 stake, bytes32 commitment);
    event Revealed(address indexed attestor, uint8 indexed stream, bool choice, uint256 stake);
    event Claimed(address indexed attestor, uint8 indexed stream, uint256 payout);


    // Constructor

    /**
     * @dev Sets up the module with its dependencies.
     * @param _governance Address of the main Governance contract.
     * @param _stakeToken Address of the ERC20 token to be used for staking.
     */
    constructor(
        address _governance,
        address _stakeToken,
        address _attestorRegistry // <-- ADDED
    ) {
        require(_governance != address(0), "AV: Zero governance");
        require(_stakeToken != address(0), "AV: Zero stake token");
        require(_attestorRegistry != address(0), "AV: Zero registry"); // <-- ADDED

        governance = Governance(_governance);
        stakeToken = SGDCoin(_stakeToken);
        attestorRegistry = AttestorRegistry(_attestorRegistry); // <-- ADDED
        phase = Phase.Pending;
        tau = 1; // Default to 1 to avoid division by zero
    }

    // Modifiers

    /**
     * @dev Throws if called by any account other than the Oracle.
     */
    modifier onlyOracle() {
        require(governance.hasRole(governance.ORACLE_ROLE(), msg.sender), "AV: Not oracle");
        _;
    }

    /**
     * @dev Throws if the contract is not in the specified phase.
     */
    modifier inPhase(Phase _phase) {
        require(phase == _phase, "AV: Invalid phase");
        _;
    }

    // Oracle-Facing Functions

    /**
     * @notice (Oracle) Sets minimum and maximum stake ("sigma") bounds.
     * @dev See interface documentation.
     */
    function setSigmaBounds(uint256 _minSigma, uint256 _maxSigma) external onlyOracle {
        if (_maxSigma > 0) {
            require(_maxSigma >= _minSigma, "AV: Max < Min");
        }
        sigmaMin = _minSigma;
        sigmaMax = _maxSigma;
        emit SigmaBoundsUpdated(_minSigma, _maxSigma);
    }

    /**
     * @notice (Oracle) Sets the reward pacing divisor `τ`.
     */
    function setTau(uint256 _tau) external onlyOracle {
        require(_tau > 0, "AV: Tau must be > 0");
        uint256 old = tau;
        tau = _tau;
        emit TauUpdated(old, _tau);
    }

    /**
     * @notice (Oracle) Increases accounting balances for reward pools.
     * @dev See interface documentation.
     */
    function fundPools(uint256 _addRT, uint256 _addRF) external onlyOracle {
        // This function just updates the *accounting*.
        // The Oracle is responsible for ensuring this contract
        // holds enough `stakeToken` balance to cover claims.
        RT += _addRT;
        RF += _addRF;
        emit PoolsFunded(RT, RF);
    }

    /**
     * @notice (Oracle) Records the attestor's stream assignment.
     * @dev See interface documentation.
     */
    function recordAttestorAssignment(address _attestor, uint8 _stream) external onlyOracle {
        require(_stream < NUM_STREAMS, "AV: Invalid stream");
        require(!isAssigned[_attestor], "AV: Already assigned");
        isAssigned[_attestor] = true;
        assignedStream[_attestor] = _stream;
        emit AttestorAssigned(_attestor, _stream);
    }

    /**
     * @notice (Oracle) Adjusts commit and reveal deadlines.
     * @dev See interface documentation.
     */
    function adjustDeadline(uint256 _commitDeadline, uint256 _revealDeadline) external onlyOracle {
        require(phase == Phase.Pending, "AV: Voting started");
        require(_commitDeadline < _revealDeadline, "AV: Commit < Reveal");
        require(_commitDeadline > block.timestamp, "AV: Commit in past");

        commitDeadline = _commitDeadline;
        revealDeadline = _revealDeadline;
        emit DeadlinesAdjusted(_commitDeadline, _revealDeadline);
    }

    /**
     * @notice (Oracle) Advances the AttestorVoting phase sequentially.
     * @dev See interface documentation.
     */
    function advancePhase() external onlyOracle {
        if (phase == Phase.Pending) {
            require(commitDeadline > 0 && revealDeadline > 0, "AV: Deadlines not set");
            phase = Phase.Commit;
        } else if (phase == Phase.Commit) {
            require(block.timestamp >= commitDeadline, "AV: Commit open");
            phase = Phase.Reveal;
        } else if (phase == Phase.Reveal) {
            require(block.timestamp >= revealDeadline, "AV: Reveal open");
            phase = Phase.Finalized;
            _finalize(); // Emit final tallies
        } else {
            revert("AV: Already finalized");
        }
        emit PhaseAdvanced(phase);
    }

    /**
     * @notice (Oracle) Sets a challenge/appeal window (in seconds).
     * @dev See interface documentation.
     */
    function setChallengeWindow(uint256 _seconds) external onlyOracle {
        challengeWindow = _seconds;
        emit ChallengeWindowSet(_seconds);
    }

    /**
     * @notice (Oracle) Performs settlement for a specific stream using donor truth.
     * @dev See interface documentation.
     */
    function settleStream(uint8 _stream, address _donorModule) external onlyOracle inPhase(Phase.Finalized) {
        require(_stream < NUM_STREAMS, "AV: Invalid stream");
        Settlement storage s = settlements[_stream];
        require(!s.settled, "AV: Already settled");

        // 1. Get Donor Truth
        (bool decided, bool passed) = DonorVoting(_donorModule).streamResult(_stream);
        require(decided, "AV: Donor not decided");

        // 2. Store settlement data
        s.settled = true;
        s.settledAt = block.timestamp;
        s.donorOutcomeTrue = passed; // 'passed' (true) or 'failed' (false)

        // 3. Get tallies for this stream
        Tally memory tally = tallies[_stream];
        uint256 poolSlice;
        
        // 4. Determine winners, losers, and pool slice
        if (passed == true) {
            // Donors voted "Pass" (True)
            s.winnersStake = tally.passStake;
            s.losersStake = tally.failStake;
            poolSlice = RT / tau;
            RT -= poolSlice; // Deduct from pool
        } else {
            // Donors voted "Fail" (False)
            s.winnersStake = tally.failStake;
            s.losersStake = tally.passStake;
            poolSlice = RF / tau;
            RF -= poolSlice; // Deduct from pool
        }

        // 5. Calculate reward per unit of stake (using RAY precision)
        // Winners get: (Pool Slice + Slashed Stakes)
        uint256 totalReward = poolSlice + s.losersStake;

        if (s.winnersStake > 0) {
            s.rewardPerStakeRay = (totalReward * RAY) / s.winnersStake;
        } else {
            s.rewardPerStakeRay = 0;
            // If winnersStake is 0, totalReward is effectively
            // returned to the pools (by not being paid out).
        }

        emit StreamSettled(
            _stream,
            s.donorOutcomeTrue,
            s.winnersStake,
            s.losersStake,
            poolSlice,
            s.rewardPerStakeRay
        );
    }

    // Attestor-Facing Functions

    /**
     * @notice (Attestor) Commit a vote with stake and eligibility proof.
     * @param _commitment keccak256(abi.encodePacked(bool choice, uint256 salt))
     * @param _stake The amount of `stakeToken` to stake.
     */
    function commit(
        bytes32 _commitment,
        uint256 _stake
    ) external inPhase(Phase.Commit) {
        require(isAssigned[msg.sender], "AV: Not assigned");
        require(stakes[msg.sender] == 0, "AV: Already committed");
        require(_commitment != bytes32(0), "AV: Invalid commitment");

        // 1. Check Stake Bounds
        require(_stake >= sigmaMin, "AV: Stake < min");
        if (sigmaMax > 0) {
            require(_stake <= sigmaMax, "AV: Stake > max");
        }

        // 2. Check Registry for Eligibility
        require(attestorRegistry.isRegistered(msg.sender), "AV: Not eligible"); // <-- REPLACED LOGIC

        // 3. Store commitment
        stakes[msg.sender] = _stake;
        commitments[msg.sender] = _commitment;

        // 4. Pull stake token
        require(stakeToken.transferFrom(msg.sender, address(this), _stake), "AV: Stake transfer failed");

        emit Committed(msg.sender, assignedStream[msg.sender], _stake, _commitment);
    }

    /**
     * @notice (Attestor) Reveal a committed vote.
     * @param _choice The vote (true for "Pass", false for "Fail").
     * @param _salt The secret salt used to generate the commitment.
     */
    function reveal(bool _choice, uint256 _salt) external inPhase(Phase.Reveal) {
        bytes32 commitment = commitments[msg.sender];
        require(commitment != bytes32(0), "AV: No commit");
        require(!revealed[msg.sender], "AV: Already revealed");

        // 1. Verify the reveal matches the commitment
        bytes32 hash = keccak256(abi.encodePacked(_choice, _salt));
        require(hash == commitment, "AV: Invalid reveal");

        // 2. Store revealed state
        revealed[msg.sender] = true;
        revealedChoice[msg.sender] = _choice; // Store choice for claiming
        
        uint256 stake = stakes[msg.sender];
        uint8 stream = assignedStream[msg.sender];

        // 3. Add stake to the correct stream's tally
        Tally storage tally = tallies[stream];
        if (_choice == true) {
            tally.passStake += stake;
        } else {
            tally.failStake += stake;
        }

        emit Revealed(msg.sender, stream, _choice, stake);
    }

    /**
     * @notice (Attestor) Claim rewards (if winner) or principal (if neutral).
     * @dev If the attestor voted with the losing side, their stake is slashed
     * and this function will transfer them 0 tokens.
     */
    function claim() external {
        uint256 stake = stakes[msg.sender];
        require(stake > 0, "AV: No stake");
        require(revealed[msg.sender], "AV: Not revealed");
        require(!hasClaimed[msg.sender], "AV: Already claimed");

        // 1. Get stream and settlement data
        uint8 stream = assignedStream[msg.sender];
        Settlement storage s = settlements[stream];
        require(s.settled, "AV: Stream not settled");

        // 2. Check challenge window
        require(block.timestamp >= s.settledAt + challengeWindow, "AV: Challenge window active");

        // 3. Mark as claimed before transfer (Checks-Effects-Interactions)
        hasClaimed[msg.sender] = true;

        // 4. Determine payout
        uint256 payout = 0;
        bool attestorVotedTrue = revealedChoice[msg.sender];
        bool isWinner = (attestorVotedTrue == s.donorOutcomeTrue);

        if (isWinner) {
            // Payout = Principal + Reward
            // Reward = (Stake * RewardPerStakeRay) / RAY
            uint256 reward = (stake * s.rewardPerStakeRay) / RAY;
            payout = stake + reward;
        }
        // If not winner, payout remains 0 (stake is slashed).

        // 5. Transfer funds (if any)
        if (payout > 0) {
            require(stakeToken.transfer(msg.sender, payout), "AV: Claim transfer failed");
        }

        emit Claimed(msg.sender, stream, payout);
    }


    // Internal Functions

    /**
     * @dev Internal function called when moving to the Finalized phase.
     * Emits the final tallies.
     */
    function _finalize() internal {
        emit Finalized(tallies);
    }
}