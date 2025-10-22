// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
/*
A modular, oracle-controlled voting contract used to verify off-chain charitable work 
across three evidence streams (Receipts, Attendance, Photos). 

This contract enforces decentralized verification logic via a commit–reveal scheme and 
quadratic voting, ensuring that no single donor or colluding group can dominate outcomes.
 
Each `VotingModule` instance corresponds to one `CharityEvent` identified by `eventId`. 

Donors are randomly assigned to review one evidence type (stream) by the Oracle.
 
The Oracle is the sole controller that:
- Assigns voters to evidence streams.
- Advances phases (Commit → Reveal → Finalized).
- Reads the final results to decide whether the CharityEvent passes verification.
*/

import "./DonorPledges.sol";
import "./EscrowVault.sol";
import "./DonorRegistry.sol";
import "./Governance.sol";

contract VotingModule {
    enum Phase { Commit, Reveal, Finalized }
    enum Evidence { Receipts, Attendance, Photos }

    struct Vote {
        bytes32 commitHash;
        bool revealed;
        bool choice; // true=yes, false=no
        uint256 weight; 
        }

    mapping(uint8 => mapping(address => Vote)) public votes;

    uint256[3] public yesWeight;
    uint256[3] public noWeight;
    uint256[3] public totalEligibleWeight;

    uint256 public commitDeadline;
    uint256 public revealDeadline;
    Phase public phase;
    bytes32 public eventId;

    Governance public governance;
    bytes32 public constant ORACLE_ROLE = keccak256("ORACLE_ROLE");

    DonorPledges public pledges;
    EscrowVault public escrow;
    DonorRegistry public donors;

    // Oracle assigns each voter to exactly one evidence stream (0,1,2)
    mapping(address => uint8) public assignedStream;
    mapping(address => bool)  public isAssigned;

    event VoteCommitted(address voter, uint8 stream);
    event VoteRevealed(address voter, uint8 stream, bool choice, uint256 weight); //
    event PhaseAdvanced(Phase newPhase);
    event Finalized(bool passed, bool[3] streamPassed);

    modifier onlyOracle() {
        require(governance.hasRole(ORACLE_ROLE, msg.sender), "not oracle"); //
        _;
    }

    modifier atPhase(Phase p) { 
        require(phase == p, "wrong phase"); //
        _;
    }

    /**
     * @dev Checks that the system-wide pause (in Governance) is not active.
     */
    modifier whenNotPaused() {
        require(!governance.paused(), "system paused");
        _;
    }

    constructor(address _governanceAddress, bytes32 _eventId, uint256 _commitDeadline, uint256 _revealDeadline) {
        require(_governanceAddress != address(0), "zero address");
        governance = Governance(_governanceAddress);
        eventId = _eventId; //

        // Fetch all contract dependencies from the Governance registry
        pledges = DonorPledges(governance.getContractAddress("DonorPledges")); //
        escrow  = EscrowVault(governance.getContractAddress("EscrowVault")); //
        donors  = DonorRegistry(governance.getContractAddress("DonorRegistry")); //
        
        // Check that addresses were actually set in Governance
        require(address(pledges) != address(0), "PledgeBook not set");
        require(address(escrow) != address(0), "EscrowVault not set");
        require(address(donors) != address(0), "DonorRegistry not set");

        phase = Phase.Commit; //
        commitDeadline = _commitDeadline
        revealDeadline = _revealDeadline;
    }

    // ---------- internal: sqrt for quadratic voting weight ----------
    function sqrt(uint256 y) internal pure returns (uint256 z) { //
        if (y > 3) {
            z = y; //
            uint256 x = y / 2 + 1; //
            while (x < z) { 
                z = x; //
                x = (y / x + x) / 2; //
            }
        } else if (y != 0) { 
            z = 1; //
        }
        //
    }

    // ---------- oracle adjust timing ----------
    function adjustDeadline(uint256 _commitDeadline, uint256 _revealDeadline) external onlyOracle {
        require(_commitDeadline < block.timestamp, "Cannot set deadline before now");
        require(_commitDeadline < _revealDeadline, "commit < reveal");
        commitDeadline = _commitDeadline;
        revealDeadline = _revealDeadline;
    }

    function advancePhase() external onlyOracle {
        if (phase == Phase.Commit && block.timestamp >= commitDeadline) {
            phase = Phase.Reveal;
        } else if (phase == Phase.Reveal && block.timestamp >= revealDeadline) { //
            phase = Phase.Finalized;
            _finalize();
        } else {
            revert("invalid phase");
        }
        emit PhaseAdvanced(phase);
    }

    // ---------- oracle controls randomization / assignment ----------
    function assignVoter(address voter, uint8 stream) external onlyOracle {
        require(stream <= uint8(Evidence.Photos), "bad stream");
        require(!isAssigned[voter], "already assigned");
        isAssigned[voter] = true;
        assignedStream[voter] = stream;
    }

    // ---------- donor calls (commit/reveal) ----------
    // commit to the stream chosen by oracle
    function commitVote(bytes32 hashCommit) external atPhase(Phase.Commit) whenNotPaused {
        require(block.timestamp < commitDeadline, "commit closed");
        require(donors.isRegistered(msg.sender), "not donor");
        require(isAssigned[msg.sender], "no stream assigned");
        uint8 stream = assignedStream[msg.sender];
        require(votes[stream][msg.sender].commitHash == 0, "already committed");
        require(pledges.hasPledged(msg.sender, eventId), "not pledged to event");

        // quadratic weight computed from pledged amount
        uint256 pledgedAmt = pledges.getPledgedAmount(msg.sender, eventId);
        require(pledgedAmt > 0, "zero pledge");
        // scale up before sqrt to keep precision
        uint256 weight = sqrt(pledgedAmt * 1e18);

        votes[stream][msg.sender] = Vote({
            commitHash: hashCommit,
            revealed: false,
            choice: false,
            weight: weight
        });
        // eligible weight must match the same scale used in yes/no sums
        totalEligibleWeight[stream] += weight;
        emit VoteCommitted(msg.sender, stream);
    }

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

    // ---------- finalize per-stream, then aggregate ----------
    function _finalize() internal { //
        bool[3] memory streamPassed; //
        uint8 passCount = 0; //

        uint256 currentQuorumBps = governance.globalQuorumBps();

        for (uint8 s = 0; s < 3; s++) {
            // quorum: revealed weight / total eligible weight
            bool quorumMet = totalEligibleWeight[s] > 0 &&
                ( (yesWeight[s] + noWeight[s]) * 10000 / totalEligibleWeight[s] ) >= currentQuorumBps;
            
            bool passed = false;
            if (quorumMet && (yesWeight[s] + noWeight[s] > 0)) {
                 passed = ( yesWeight[s] * 10000 / (yesWeight[s] + noWeight[s]) >= currentQuorumBps );
            } else {
                // This logic handles the edge case of 0/0.
                // If quorumMet is true, totalEligibleWeight > 0 and (yes+no) > 0.
                passed = quorumMet && (
                    yesWeight[s] + noWeight[s] == 0 
                        ? false : 
                        ( yesWeight[s] * 10000 / (yesWeight[s] + noWeight[s]) >= currentQuorumBps )
                    );
            }
            
            streamPassed[s] = passed;
            if (passed) passCount++;
        }

        bool overallPassed = (passCount == 3);
        emit Finalized(overallPassed, streamPassed);
    }

    // ---------- views for oracle / anyone ----------
    function streamTally(uint8 stream) external view returns (uint256 yes, uint256 no, uint256 eligible) {
        require(stream <= uint8(Evidence.Photos), "bad stream");
        return (yesWeight[stream], noWeight[stream], totalEligibleWeight[stream]);
    }

    function streamResult(uint8 stream) public view returns (bool decided, bool passed) {
        require(stream <= uint8(Evidence.Photos), "bad stream");
        if (phase != Phase.Finalized) return (false, false);
        
        uint256 currentQuorumBps = governance.globalQuorumBps();

        bool quorumMet = totalEligibleWeight[stream] > 0 &&
            ( (yesWeight[stream] + noWeight[stream]) * 10000 / totalEligibleWeight[stream] ) >= currentQuorumBps;
        
        bool ok = quorumMet && ( 
            (yesWeight[stream] + noWeight[stream]) == 0 
                ? false :
                ( yesWeight[stream] * 10000 / (yesWeight[stream] + noWeight[stream]) >= currentQuorumBps ) 
            );

        return (true, ok);
    }

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