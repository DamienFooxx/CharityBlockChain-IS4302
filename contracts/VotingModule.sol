// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/*
Used by Oracle
Plug-in that tallies “yes/no” by quadratic weight, with commit-reveal.
Supports three evidence streams per event: Receipts, Attendance, Photos.
Oracle is the sole controller for phase transitions and assignments.
*/
import "./PledgeBook.sol";
import "./DonationEscrow.sol";
import "./DonorRegistry.sol";

contract VotingModule {
    enum Phase { Commit, Reveal, Finalized }
    enum Evidence { Receipts, Attendance, Photos } // 0,1,2

    struct Vote {
        bytes32 commitHash;
        bool revealed;
        bool choice;      // true=yes, false=no
        uint256 weight;   // quadratic weight (sqrt of pledged amount, scaled)
    }

    // votes[stream][voter] => Vote
    mapping(uint8 => mapping(address => Vote)) public votes;

    // per-stream tallies
    uint256[3] public yesWeight;
    uint256[3] public noWeight;
    uint256[3] public totalEligibleWeight;

    uint256 public commitDeadline;
    uint256 public revealDeadline;
    Phase public phase;
    bytes32 public eventId;                // charity event identifier
    uint256 public quorumBps = 7000;       // 70% (in basis points)

    PledgeBook public pledges;
    DonationEscrow public escrow;
    DonorRegistry public donors;
    address public oracle;                 // controller

    // Oracle assigns each voter to exactly one stream (0..2)
    mapping(address => uint8) public assignedStream;     // defaults to 255 if unassigned
    mapping(address => bool)  public isAssigned;

    event VoteCommitted(address voter, uint8 stream);
    event VoteRevealed(address voter, uint8 stream, bool choice, uint256 weight);
    event PhaseAdvanced(Phase newPhase);
    event Finalized(bool passed, bool[3] streamPassed);

    modifier onlyOracle() { require(msg.sender == oracle, "not oracle"); _; }
    modifier atPhase(Phase p) { require(phase == p, "wrong phase"); _; }

    constructor(address _pledgeBook, address _escrow, address _donors, address _oracle, bytes32 _eventId) {
        pledges = PledgeBook(_pledgeBook);
        escrow  = DonationEscrow(_escrow);
        donors  = DonorRegistry(_donors);
        oracle  = _oracle;
        eventId = _eventId;

        phase = Phase.Commit;
        commitDeadline = block.timestamp + 14 days;
        revealDeadline = commitDeadline + 2 days;
    }

    // ---------- math ----------
    function sqrt(uint256 y) internal pure returns (uint256 z) {
        if (y > 3) {
            z = y;
            uint256 x = y / 2 + 1;
            while (x < z) { z = x; x = (y / x + x) / 2; }
        } else if (y != 0) { z = 1; }
    }

    // ---------- oracle controls timing ----------
    function setDeadlines(uint256 _commitDeadline, uint256 _revealDeadline) external onlyOracle {
        require(_commitDeadline < _revealDeadline, "commit < reveal");
        commitDeadline = _commitDeadline;
        revealDeadline = _revealDeadline;
    }

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

    // ---------- oracle controls randomization / assignment ----------
    function assignVoter(address voter, uint8 stream) external onlyOracle {
        require(stream <= uint8(Evidence.Photos), "bad stream");
        require(!isAssigned[voter], "already assigned");
        isAssigned[voter] = true;
        assignedStream[voter] = stream;
    }

    // ---------- donor calls (commit/reveal) ----------
    // commit to the stream chosen by oracle
    function commitVote(bytes32 hashCommit) external atPhase(Phase.Commit) {
        require(block.timestamp < commitDeadline, "commit closed");
        require(donors.isRegistered(msg.sender), "not donor");
        require(isAssigned[msg.sender], "no stream assigned");
        uint8 stream = assignedStream[msg.sender];
        require(votes[stream][msg.sender].commitHash == 0, "already committed");
        require(pledges.hasPledged(msg.sender, eventId), "not pledged to event");

        // quadratic weight computed from pledged amount
        uint256 pledgedAmt = pledges.getPledgedAmount(msg.sender, eventId);
        require(pledgedAmt > 0, "zero pledge");
        // scale up before sqrt to keep precision (optional)
        uint256 weight = sqrt(pledgedAmt * 1e18);

        votes[stream][msg.sender] = Vote({
            commitHash: hashCommit,
            revealed: false,
            choice: false,
            weight: weight
        });

        // NOTE: eligible weight must match the same scale used in yes/no sums
        totalEligibleWeight[stream] += weight;
        emit VoteCommitted(msg.sender, stream);
    }

    function revealVote(bool decision, bytes32 salt) external atPhase(Phase.Reveal) {
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
    function _finalize() internal {
        bool[3] memory streamPassed;
        uint8 passCount = 0;

        for (uint8 s = 0; s < 3; s++) {
            // quorum: revealed weight / total eligible weight
            bool quorumMet = totalEligibleWeight[s] > 0 &&
                ( (yesWeight[s] + noWeight[s]) * 10000 / totalEligibleWeight[s] ) >= quorumBps;

            bool passed = quorumMet &&
                ( yesWeight[s] * 10000 / (yesWeight[s] + noWeight[s]) >= quorumBps );

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
        bool quorumMet = totalEligibleWeight[stream] > 0 &&
            ( (yesWeight[stream] + noWeight[stream]) * 10000 / totalEligibleWeight[stream] ) >= quorumBps;
        bool ok = quorumMet &&
            ( yesWeight[stream] * 10000 / (yesWeight[stream] + noWeight[stream]) >= quorumBps );
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
