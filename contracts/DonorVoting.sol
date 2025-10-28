// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "./Governance.sol";
import "./DonorRegistry.sol";
import "./DonorPledges.sol";
import "./DonorRanking.sol";

/**
 * @title DonorVoting
 * @notice
 * Implements the Oracle-facing control/read surface for the DonorVoting module.
 * This contract manages the donor voting process for a specific CharityEvent,
 * using a weighted (pledge + reputation) commit-reveal scheme.
 *
 * @dev
 * This contract is instantiated per-event and controlled by the Oracle.
 * It reads from DonorRegistry for eligibility.
 * It reads from DonorPledges for base pledge amount.
 * It reads from DonorRanking for the reputation multiplier.
 * It reads from Governance for role checks (onlyOracle) and quorum rules.
 */
contract DonorVoting {

    Governance public immutable governance;
    DonorRegistry public immutable donorRegistry;
    DonorPledges public immutable donorPledges;
    DonorRanking public immutable donorRanking;

    // The eventId this voting module is associated with.
    bytes32 public immutable eventId;

    uint8 public constant NUM_STREAMS = 3;
 
    enum Phase { Pending, Commit, Reveal, Finalized }
    Phase public phase;

    uint256 public commitDeadline;
    uint256 public revealDeadline;

    // Voter Assignment
    mapping(address => uint8) public assignedStream; // voter => streamId
    mapping(address => bool) public isAssigned; // voter => bool

    // Total *weighted* pledge (sum) of all voters assigned to each stream.
    // Used to calculate quorum participation.
    mapping(uint8 => uint256) public totalPossibleWeight;

    // Voting Data
    mapping(address => bytes32) public commitments; // voter => keccak256(choice, salt)
    mapping(address => bool) public revealed; // voter => bool

    // Finalization Data
    struct Tally {
        uint256 pass; // Total weighted votes for "Pass"
        uint256 fail; // Total weighted votes for "Fail"
        uint256 totalWeight; // Total participating weighted votes (pass + fail)
    }

    Tally[NUM_STREAMS] public tallies;
    bool[NUM_STREAMS] public streamPassed; // Final decision per stream
    bool public overallPassed; // Final aggregate decision (true if all streams passed)

    // --- Events ---
    event VoterAssigned(address indexed voter, uint8 stream);
    event DeadlinesAdjusted(uint256 commitDeadline, uint256 revealDeadline);
    event PhaseAdvanced(Phase newPhase);
    event Voted(address indexed voter, uint8 indexed stream);
    event Revealed(address indexed voter, uint8 indexed stream, bool choice, uint256 weight);
    event Finalized(bool overallPassed, bool[3] streamResults);

    /**
    * Constructor
     */

    /**
     * @dev Sets up the voting module for a specific event.
     * @param _governance Address of the main Governance contract.
     * @param _donorRegistry Address of the DonorRegistry contract.
     * @param _donorPledges Address of the DonorPledges contract.
     * @param _donorRanking Address of the DonorRanking contract.
     * @param _eventId The unique ID of the event this module serves.
     */
    constructor(
        address _governance,
        address _donorRegistry,
        address _donorPledges,
        address _donorRanking,
        bytes32 _eventId
    ) {
        require(
            _governance != address(0) && 
            _donorRegistry != address(0) && 
            _donorPledges != address(0) &&
            _donorRanking != address(0),
            "DonorVoting: Zero address dependency"
        );
        require(_eventId != bytes32(0), "DonorVoting: Zero eventId");

        governance = Governance(_governance);
        donorRegistry = DonorRegistry(_donorRegistry);
        donorPledges = DonorPledges(_donorPledges);
        donorRanking = DonorRanking(_donorRanking);
        eventId = _eventId;
        phase = Phase.Pending;
    }

    /** 
    * Modifiers
     */

    /**
     * @dev Throws if called by any account other than the Oracle.
     */
    modifier onlyOracle() {
        require(governance.hasRole(governance.ORACLE_ROLE(), msg.sender), "DonorVoting: Not oracle");
        _;
    }

    /**
     * @dev Throws if the contract is not in the specified phase.
     */
    modifier inPhase(Phase _phase) {
        require(phase == _phase, "DonorVoting: Invalid phase");
        _;
    }

    /**
    * Oracle-Facing Functions
     */

    /**
     * @notice (Oracle) Assign a donor to exactly one evidence stream.
     * This function calculates the voter's weighted vote power.
     */
    function assignVoter(address voter, uint8 stream) external onlyOracle inPhase(Phase.Pending) {
        require(stream < NUM_STREAMS, "DonorVoting: Invalid stream");
        require(!isAssigned[voter], "DonorVoting: Already assigned");
        require(donorRegistry.isRegistered(voter), "DonorVoting: Not registered");

        uint256 pledgedAmount = donorPledges.getDonorStakeInEvent(voter, eventId);
        require(pledgedAmount > 0, "DonorVoting: No pledge weight");

        // Get reputation multiplier (e.g., 100 for 1x, 110 for 1.1x)
        uint256 weightMultiplier = donorRanking.getVotingWeight(voter);
        
        // Calculate final weighted vote power
        uint256 finalWeight = (pledgedAmount * weightMultiplier) / 100;

        // Record assignment
        isAssigned[voter] = true;
        assignedStream[voter] = stream;

        // Add this voter's final weight to the total possible for this stream (for quorum)
        totalPossibleWeight[stream] += finalWeight;

        emit VoterAssigned(voter, stream);
    }

    /**
     * @notice (Oracle) Adjust commit and reveal deadlines for this module/round.
     * @dev See interface documentation.
     */
    function adjustDeadline(uint256 _commitDeadline, uint256 _revealDeadline) external onlyOracle {
        require(phase == Phase.Pending, "DonorVoting: Voting started");
        require(_commitDeadline < _revealDeadline, "DonorVoting: Commit < Reveal");
        require(_commitDeadline > block.timestamp, "DonorVoting: Commit in past");

        commitDeadline = _commitDeadline;
        revealDeadline = _revealDeadline;

        emit DeadlinesAdjusted(_commitDeadline, _revealDeadline);
    }

    /**
     * @notice (Oracle) Advance the module phase: Pending -> Commit -> Reveal -> Finalized.
     * @dev See interface documentation.
     */
    function advancePhase() external onlyOracle {
        if (phase == Phase.Pending) {
            require(commitDeadline > 0 && revealDeadline > 0, "DonorVoting: Deadlines not set");
            phase = Phase.Commit;
        } else if (phase == Phase.Commit) {
            require(block.timestamp >= commitDeadline, "DonorVoting: Commit open");
            phase = Phase.Reveal;
        } else if (phase == Phase.Reveal) {
            require(block.timestamp >= revealDeadline, "DonorVoting: Reveal open");
            phase = Phase.Finalized;
            _finalize();
        } else {
            revert("DonorVoting: Already finalized");
        }

        emit PhaseAdvanced(phase);
    }

    /**
    * Donor-Facing Functions (Commit/Reveal)
     */

    /**
     * @notice (Donor) Commit a vote.
     * @param _commitment The keccak256 hash of the vote and salt.
     * `keccak256(abi.encodePacked(bool choice, uint256 salt))`
     */
    function commit(bytes32 _commitment) external inPhase(Phase.Commit) {
        require(isAssigned[msg.sender], "DonorVoting: Not assigned");
        require(commitments[msg.sender] == bytes32(0), "DonorVoting: Already committed");
        require(_commitment != bytes32(0), "DonorVoting: Invalid commitment");

        commitments[msg.sender] = _commitment;
        emit Voted(msg.sender, assignedStream[msg.sender]);
    }

    /**
     * @notice (Donor) Reveal a committed vote.
     * @param _choice The vote (true for "Pass", false for "Fail").
     * @param _salt The secret salt used to generate the commitment.
     */
    function reveal(bool _choice, uint256 _salt) external inPhase(Phase.Reveal) {
        bytes32 commitment = commitments[msg.sender];
        require(commitment != bytes32(0), "DonorVoting: No commit");
        require(!revealed[msg.sender], "DonorVoting: Already revealed");

        // Verify the reveal matches the commitment
        bytes32 hash = keccak256(abi.encodePacked(_choice, _salt));
        require(hash == commitment, "DonorVoting: Invalid reveal");

        revealed[msg.sender] = true;

        // Get voter's base weight (pledge amount)
        uint256 pledgedAmount = donorPledges.getDonorStakeInEvent(msg.sender, eventId);
        if (pledgedAmount == 0) {
            // Pledge might have been withdrawn; vote is nullified.
            return;
        }

        // Get reputation multiplier (e.g., 100 for 1x, 110 for 1.1x)
        uint256 weightMultiplier = donorRanking.getVotingWeight(msg.sender);
        
        // Calculate final weighted vote power
        uint256 finalWeight = (pledgedAmount * weightMultiplier) / 100;

        // Add vote to the correct stream's tally
        uint8 stream = assignedStream[msg.sender];
        Tally storage tally = tallies[stream];
        tally.totalWeight += finalWeight; // Use finalWeight

        if (_choice == true) {
            tally.pass += finalWeight; // Use finalWeight
        } else {
            tally.fail += finalWeight; // Use finalWeight
        }

        emit Revealed(msg.sender, stream, _choice, finalWeight); // Use finalWeight
    }

    /**
    * Internal logic
     */

    /**
     * @dev Internal function to compute tallies and set final outcomes.
     * Called once when moving to the Finalized phase.
     *
     * Rules:
     * 1. Quorum: Participating vote weight must meet `globalQuorumBps`
     * of the total possible vote weight for that stream.
     * 2. Majority: `pass` weight must be strictly greater than `fail` weight and above PassMajorityBps set
     *
     * A stream passes iff BOTH Quorum and Majority are met.
     */
function _finalize() internal {
        uint256 quorumRequiredBps = governance.globalQuorumBps(); // Fetch quorum threshold
        uint256 passMajorityRequiredBps = governance.globalPassMajorityBps(); // <-- Fetch NEW pass threshold
        bool _overallPassed = true;

        for (uint8 s = 0; s < NUM_STREAMS; s++) {
            Tally storage tally = tallies[s];
            bool streamPasses = false; // Default to false
            uint256 streamTotalPossible = totalPossibleWeight[s];

            // Only proceed if voters were assigned and actually voted
            if (streamTotalPossible > 0 && tally.totalWeight > 0) {
                // --- Check 1: Quorum ---
                // Is participation weight % >= quorumRequiredBps?
                uint256 participationBps = (tally.totalWeight * 10000) / streamTotalPossible;
                bool quorumMet = participationBps >= quorumRequiredBps;

                if (quorumMet) {
                    // --- Check 2: Pass Majority Threshold ---
                    // Is pass weight % of *participating* weight >= passMajorityRequiredBps?
                    uint256 passPercentageBps = (tally.pass * 10000) / tally.totalWeight;
                    bool passThresholdMet = passPercentageBps >= passMajorityRequiredBps; // <-- USES NEW VARIABLE

                    if (passThresholdMet) {
                        streamPasses = true; // Only passes if BOTH checks are true
                    }
                }
            }
            // If streamTotalPossible is 0, or tally.totalWeight is 0, streamPasses remains false.

            streamPassed[s] = streamPasses;
            if (!streamPasses) {
                _overallPassed = false; // If any stream fails, the overall result is false
            }
        }

        overallPassed = _overallPassed;
        emit Finalized(_overallPassed, streamPassed);
    }

    /** 
    * View Functions (Oracle-Facing)
     */

    /**
     * @notice Read the per-stream decision (donor "truth") once finalized.
     * @dev See interface documentation.
     */
    function streamResult(uint8 stream) external view returns (bool decided, bool passed) {
        require(stream < NUM_STREAMS, "DonorVoting: Invalid stream");

        if (phase != Phase.Finalized) {
            return (false, false);
        }

        return (true, streamPassed[stream]);
    }

    /**
     * @notice Aggregate decision across all streams for escrow gating.
     * @dev See interface documentation.
     */
    function overallResult() external view returns (bool decided, bool passed, bool[3] memory perStream) {
        if (phase != Phase.Finalized) {
            return (false, false, [false, false, false]);
        }

        return (true, overallPassed, streamPassed);
    }
}