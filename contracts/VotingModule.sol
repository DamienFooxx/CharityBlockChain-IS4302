// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/**
 * @title VotingModule
 * @notice 
 * A modular, oracle-controlled voting contract designed to verify off-chain charitable work 
 * through three distinct evidence streams: Receipts, Attendance, and Photos.
 *
 * @dev 
 * Implements:
 * - A commit–reveal voting mechanism for confidentiality
 * - Quadratic voting to limit dominance by large donors (based on pledged amounts)
 * - Oracle-driven governance for off-chain verification coordination
 * - Phase-controlled state transitions
 * @custom:architecture 
 * Each `VotingModule` corresponds to a unique `CharityEvent` identified by `eventId`.
 * Donors are assigned to one of three evidence streams by the Oracle to maintain distributed review.
 *
 * @custom:oracle
 * The Oracle:
 * - Assigns donors to evidence streams.
 * - Advances contract phases (Commit → Reveal → Finalized).
 * - Reads and interprets results for off-chain disbursement via Escrow.
 */

import "./DonorPledges.sol";
import "./EscrowVault.sol";
import "./DonorRegistry.sol";
import "./Governance.sol";

contract VotingModule {
    /// @notice Defines the lifecycle phases of the voting process
    enum Phase { Commit, Reveal, Finalized }

    /// @notice Enumeration of the three evidence streams
    enum Evidence { Receipts, Attendance, Photos }

    /**
     * @dev Represents a single donor’s vote.
     * @param commitHash Hash(commit) = keccak256(decision, salt)
     * @param revealed Indicates if the vote has been revealed
     * @param choice The boolean decision (true = Yes, false = No)
     * @param weight Quadratic voting weight (sqrt of pledged amount)
     */
    struct Vote {
        bytes32 commitHash;
        bool revealed;
        bool choice;
        uint256 weight;
    }

    /// @dev votes[stream][voter] => Vote structure
    mapping(uint8 => mapping(address => Vote)) public votes;

    /// @notice Aggregate vote tallies for each evidence stream
    uint256[3] public yesWeight;
    uint256[3] public noWeight;
    uint256[3] public totalEligibleWeight;

    /// @notice Phase deadlines controlled by Oracle
    uint256 public commitDeadline;
    uint256 public revealDeadline;

    /// @notice Current phase of the voting process
    Phase public phase;

    /// @notice Identifier for the associated charity event
    bytes32 public eventId;

    /// @notice Governance contract that provides Oracle access control and registry lookups
    Governance public governance;
    bytes32 public constant ORACLE_ROLE = keccak256("ORACLE_ROLE");

    /// @notice Linked subsystem contracts
    DonorPledges public pledges;
    EscrowVault public escrow;
    DonorRegistry public donors;

    /// @notice Oracle-assigned stream mapping for each voter
    mapping(address => uint8) public assignedStream;
    mapping(address => bool)  public isAssigned;

    // ------------------------------------------------------------------------
    // Events
    // ------------------------------------------------------------------------

    /// @notice Emitted when a donor commits a vote
    event VoteCommitted(address indexed voter, uint8 indexed stream);

    /// @notice Emitted when a donor reveals their vote
    event VoteRevealed(address indexed voter, uint8 indexed stream, bool choice, uint256 weight);

    /// @notice Emitted whenever the Oracle advances the voting phase
    event PhaseAdvanced(Phase newPhase);

    /// @notice Emitted upon finalization of all streams
    event Finalized(bool overallPassed, bool[3] streamPassed);

    // ------------------------------------------------------------------------
    // Modifiers
    // ------------------------------------------------------------------------

    /// @notice Restricts function access to Oracle only
    modifier onlyOracle() {
        require(governance.hasRole(ORACLE_ROLE, msg.sender), "not oracle");
        _;
    }

    /// @notice Restricts function execution to a specific voting phase
    modifier atPhase(Phase p) {
        require(phase == p, "wrong phase");
        _;
    }

    /// @notice Ensures system-wide governance pause is not active
    modifier whenNotPaused() {
        require(!governance.paused(), "system paused");
        _;
    }

    // ------------------------------------------------------------------------
    // Constructor
    // ------------------------------------------------------------------------

    /**
     * @param _governanceAddress Address of Governance contract (manages system-wide configuration)
     * @param _eventId Identifier for the associated CharityEvent
     * @param _commitDeadline Timestamp for end of commit phase
     * @param _revealDeadline Timestamp for end of reveal phase
     */
    constructor(address _governanceAddress, bytes32 _eventId, uint256 _commitDeadline, uint256 _revealDeadline) {
        require(_governanceAddress != address(0), "zero address");
        governance = Governance(_governanceAddress);
        eventId = _eventId;

        // Retrieve dependencies from Governance registry (Lecture 4: Contract Register pattern)
        pledges = DonorPledges(governance.getContractAddress("DonorPledges"));
        escrow  = EscrowVault(governance.getContractAddress("EscrowVault"));
        donors  = DonorRegistry(governance.getContractAddress("DonorRegistry"));

        // Verify valid subsystem references
        require(address(pledges) != address(0), "PledgeBook not set");
        require(address(escrow) != address(0), "EscrowVault not set");
        require(address(donors) != address(0), "DonorRegistry not set");

        phase = Phase.Commit;
        commitDeadline = _commitDeadline;
        revealDeadline = _revealDeadline;
    }

    // ------------------------------------------------------------------------
    // Internal Utility
    // ------------------------------------------------------------------------

    /**
     * @notice Calculates integer square root for quadratic voting.
     * @dev Used to determine quadratic weight = sqrt(pledged amount).
     *      Ensures donors with large pledges have diminishing marginal influence.
     */
    function sqrt(uint256 y) internal pure returns (uint256 z) {
        if (y > 3) {
            z = y;
            uint256 x = y / 2 + 1;
            while (x < z) {
                z = x;
                x = (y / x + x) / 2;
            }
        } else if (y != 0) {
            z = 1;
        }
    }

    // ------------------------------------------------------------------------
    // Oracle Functions
    // ------------------------------------------------------------------------

    /**
     * @notice Adjusts the commit/reveal deadlines.
     * @dev Only callable by the Oracle. Used to reschedule due to off-chain delays.
     */
    function adjustDeadline(uint256 _commitDeadline, uint256 _revealDeadline) external onlyOracle {
        require(_commitDeadline < block.timestamp, "Cannot set deadline before now");
        require(_commitDeadline < _revealDeadline, "commit < reveal");
        commitDeadline = _commitDeadline;
        revealDeadline = _revealDeadline;
    }

    /**
     * @notice Advances voting phase sequentially (Commit → Reveal → Finalized).
     * @dev Automatically calls `_finalize()` once Reveal phase ends.
     */
    function advancePhase() external onlyOracle {
        if (phase == Phase.Commit && block.timestamp >= commitDeadline) {
            phase = Phase.Reveal;
        } else if (phase == Phase.Reveal && block.timestamp >= revealDeadline) {
            phase = Phase.Finalized;
            _finalize();
        } else {
            revert("invalid phase");
        }
        emit PhaseAdvanced(phase);
    }

    /**
     * @notice Assigns a donor to a specific evidence stream.
     * @dev Ensures no duplicate assignment. Controlled solely by Oracle.
     */
    function assignVoter(address voter, uint8 stream) external onlyOracle {
        require(stream <= uint8(Evidence.Photos), "bad stream");
        require(!isAssigned[voter], "already assigned");
        isAssigned[voter] = true;
        assignedStream[voter] = stream;
    }

    // ------------------------------------------------------------------------
    // Donor Voting Logic (Commit & Reveal)
    // ------------------------------------------------------------------------

    /**
     * @notice Donor commits a hashed vote during Commit phase.
     * @param hashCommit keccak256(decision, salt)
     * @dev 
     * - Requires Oracle assignment and valid pledge
     * - Calculates quadratic weight from pledged amount
     */
    function commitVote(bytes32 hashCommit) external atPhase(Phase.Commit) whenNotPaused {
        require(block.timestamp < commitDeadline, "commit closed");
        require(donors.isRegistered(msg.sender), "not donor");
        require(isAssigned[msg.sender], "no stream assigned");

        uint8 stream = assignedStream[msg.sender];
        require(votes[stream][msg.sender].commitHash == 0, "already committed");
        require(pledges.hasPledged(msg.sender, eventId), "not pledged to event");

        uint256 pledgedAmt = pledges.getPledgedAmount(msg.sender, eventId);
        require(pledgedAmt > 0, "zero pledge");

        uint256 weight = sqrt(pledgedAmt * 1e18);

        votes[stream][msg.sender] = Vote({
            commitHash: hashCommit,
            revealed: false,
            choice: false,
            weight: weight
        });

        totalEligibleWeight[stream] += weight;
        emit VoteCommitted(msg.sender, stream);
    }

    /**
     * @notice Donor reveals their vote with salt after commit phase ends.
     * @param decision Boolean decision (true = Yes, false = No)
     * @param salt Secret used in commit hash
     */
    function revealVote(bool decision, bytes32 salt) external atPhase(Phase.Reveal) whenNotPaused {
        require(block.timestamp < revealDeadline, "reveal closed");
        require(isAssigned[msg.sender], "no stream assigned");

        uint8 stream = assignedStream[msg.sender];
        Vote storage v = votes[stream][msg.sender];
        require(v.commitHash != 0, "no commit");
        require(!v.revealed, "already revealed");
        require(keccak256(abi.encodePacked(decision, salt)) == v.commitHash, "invalid reveal");

        v.revealed = true;
        v.choice = decision;

        if (decision) yesWeight[stream] += v.weight;
        else noWeight[stream]  += v.weight;

        emit VoteRevealed(msg.sender, stream, decision, v.weight);
    }

    // ------------------------------------------------------------------------
    // Finalization Logic
    // ------------------------------------------------------------------------

    /**
     * @notice Finalizes all evidence streams and computes verification outcome.
     * @dev Internal function called automatically during phase advancement.
     */
    function _finalize() internal {
        bool[3] memory streamPassed;
        uint8 passCount = 0;

        uint256 currentQuorumBps = governance.globalQuorumBps();

        for (uint8 s = 0; s < 3; s++) {
            bool quorumMet = totalEligibleWeight[s] > 0 &&
                ((yesWeight[s] + noWeight[s]) * 10000 / totalEligibleWeight[s]) >= currentQuorumBps;
            
            bool passed = false;
            if (quorumMet && (yesWeight[s] + noWeight[s] > 0)) {
                passed = (yesWeight[s] * 10000 / (yesWeight[s] + noWeight[s]) >= currentQuorumBps);
            } else {
                passed = quorumMet && (
                    yesWeight[s] + noWeight[s] == 0 
                        ? false 
                        : (yesWeight[s] * 10000 / (yesWeight[s] + noWeight[s]) >= currentQuorumBps)
                );
            }
            
            streamPassed[s] = passed;
            if (passed) passCount++;
        }

        bool overallPassed = (passCount == 3);
        emit Finalized(overallPassed, streamPassed);
    }

    // ------------------------------------------------------------------------
    // Public Read Functions
    // ------------------------------------------------------------------------

    /**
     * @notice Returns current tally for a given evidence stream.
     */
    function streamTally(uint8 stream) external view returns (uint256 yes, uint256 no, uint256 eligible) {
        require(stream <= uint8(Evidence.Photos), "bad stream");
        return (yesWeight[stream], noWeight[stream], totalEligibleWeight[stream]);
    }

    /**
     * @notice Returns decision status for a specific stream.
     * @dev Only meaningful after Finalization phase.
     */
    function streamResult(uint8 stream) public view returns (bool decided, bool passed) {
        require(stream <= uint8(Evidence.Photos), "bad stream");
        if (phase != Phase.Finalized) return (false, false);
        
        uint256 currentQuorumBps = governance.globalQuorumBps();

        bool quorumMet = totalEligibleWeight[stream] > 0 &&
            ((yesWeight[stream] + noWeight[stream]) * 10000 / totalEligibleWeight[stream]) >= currentQuorumBps;
        
        bool ok = quorumMet && (
            (yesWeight[stream] + noWeight[stream]) == 0 
                ? false
                : (yesWeight[stream] * 10000 / (yesWeight[stream] + noWeight[stream]) >= currentQuorumBps)
        );

        return (true, ok);
    }

    /**
     * @notice Aggregates final result across all three evidence streams.
     * @return decided Whether finalization occurred
     * @return passed Whether all three streams passed
     * @return perStream Boolean results per stream
     */
    function overallResult() external view returns (bool decided, bool passed, bool[3] memory perStream) {
        if (phase != Phase.Finalized) return (false, false, perStream);
        uint8 passCount = 0;
        for (uint8 s = 0; s < 3; s++) {
            (, bool ok) = streamResult(s);
            perStream[s] = ok;
            if (ok) passCount++;
        }
        return (true, passCount == 3, perStream);
    }
}
