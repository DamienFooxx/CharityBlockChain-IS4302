// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "./Governance.sol";
import "./VotingModule.sol";

/**
 * @title Oracle
 * @notice Orchestrates verification rounds across VotingModule instances.
 * @dev
 * - Authorization: gated by Governance.ORACLE_ROLE.
 * - Responsibilities:
 *   1) Create/register VotingModule per eventId.
 *   2) Assign voters to streams (0: Receipts, 1: Attendance, 2: Photos).
 *   3) Adjust commit/reveal deadlines.
 *   4) Advance phases (Commit → Reveal → Finalized).
 *   5) Provide optional deterministic assignment via a seedable salt.
 *
 * Security notes:
 * - This contract itself does not store funds.
 * - Must be granted ORACLE_ROLE in Governance to operate VotingModules.
 */
contract Oracle {
    // ------------------------------------------------------------------------
    // Storage
    // ------------------------------------------------------------------------
    Governance public immutable governance;

    /// @notice eventId => VotingModule address
    mapping(bytes32 => address) public modules;

    /// @notice eventId => [stream 0 weight, stream 1 weight, stream 2 weight]
    mapping(bytes32 => uint256[3]) public streamAssignedWeight;

    /// @notice Optional assignment seed (can be rotated by an authorized oracle)
    bytes32 public assignmentSeed;

    // Role ID used by Governance/VotingModule
    bytes32 public constant ORACLE_ROLE = keccak256("ORACLE_ROLE");

    // ------------------------------------------------------------------------
    // Events
    // ------------------------------------------------------------------------
    event ModuleCreated(bytes32 indexed eventId, address module, uint256 commitDeadline, uint256 revealDeadline);
    event ModuleRegistered(bytes32 indexed eventId, address module);
    event DeadlinesAdjusted(bytes32 indexed eventId, uint256 commitDeadline, uint256 revealDeadline);
    event PhaseAdvanced(bytes32 indexed eventId, VotingModule.Phase newPhase);
    event VoterAssigned(bytes32 indexed eventId, address indexed voter, uint8 stream);
    event AssignmentSeedUpdated(bytes32 oldSeed, bytes32 newSeed);

    // ------------------------------------------------------------------------
    // Modifiers
    // ------------------------------------------------------------------------
    modifier onlyOracle() {
        require(governance.hasRole(ORACLE_ROLE, msg.sender), "OracleController: not oracle");
        _;
    }

    modifier moduleExists(bytes32 eventId) {
        require(modules[eventId] != address(0), "OracleController: module not set");
        _;
    }

    // ------------------------------------------------------------------------
    // Constructor
    // ------------------------------------------------------------------------
    /**
     * @param _governance Address of the Governance contract.
     * @param _initialSeed Optional initial assignment seed (can be 0).
     */
    constructor(address _governance, bytes32 _initialSeed) {
        require(_governance != address(0), "OracleController: zero governance");
        governance = Governance(_governance);
        assignmentSeed = _initialSeed;
    }

    // ------------------------------------------------------------------------
    // Admin / Setup
    // ------------------------------------------------------------------------

    /**
     * @notice Deploy and record a new VotingModule for an event.
     * @dev Caller must have ORACLE_ROLE in Governance.
     */
    function createModule(bytes32 eventId, uint256 commitDeadline, uint256 revealDeadline)
        external
        onlyOracle
        returns (address module)
    {
        require(eventId != bytes32(0), "Oracle: empty eventId");
        require(modules[eventId] == address(0), "Oracle: exists");

        VotingModule vm = new VotingModule(address(governance), eventId, commitDeadline, revealDeadline);
        modules[eventId] = address(vm);

        emit ModuleCreated(eventId, address(vm), commitDeadline, revealDeadline);
        return address(vm);
    }

    /**
     * @notice Register an already-deployed VotingModule for an event.
     * @dev Useful if modules are deployed elsewhere (e.g., via a factory).
     */
    function registerModule(bytes32 eventId, address module) external onlyOracle {
        require(eventId != bytes32(0), "Oracle: empty eventId");
        require(modules[eventId] == address(0), "Oracle: exists");
        require(module != address(0), "Oracle: zero module");
        // Sanity check that module points to the same Governance
        require(VotingModule(module).governance() == governance, "Oracle: wrong governance");

        modules[eventId] = module;
        emit ModuleRegistered(eventId, module);
    }

    /**
     * @notice Rotate or set the assignment seed used by `computeStream()`.
     * @dev Seed is public but can be combined with eventId and voter for unpredictability.
     */
    function setAssignmentSeed(bytes32 newSeed) external onlyOracle {
        bytes32 old = assignmentSeed;
        assignmentSeed = newSeed;
        emit AssignmentSeedUpdated(old, newSeed);
    }

    // ------------------------------------------------------------------------
    // Oracle Actions → Single Event
    // ------------------------------------------------------------------------

    /**
     * @notice Assign a single voter to a specified stream.
     */
    function assignVoter(bytes32 eventId, address voter, uint8 stream)
        external
        onlyOracle
        moduleExists(eventId)
    {
        VotingModule(modules[eventId]).assignVoter(voter, stream);
        emit VoterAssigned(eventId, voter, stream);
    }

    /**
     * @notice Batch-assign voters to specified streams.
     * @dev `voters.length` must equal `streams.length`.
     */
    function batchAssignVoters(bytes32 eventId, address[] calldata voters, uint8[] calldata streams)
        external
        onlyOracle
        moduleExists(eventId)
    {
        require(voters.length == streams.length, "Oracle: length mismatch");
        VotingModule vm = VotingModule(modules[eventId]);

        for (uint256 i = 0; i < voters.length; i++) {
            vm.assignVoter(voters[i], streams[i]);
            emit VoterAssigned(eventId, voters[i], streams[i]);
        }
    }

    /**
     * @notice Deterministically assign a voter to {0,1,2} using seed+eventId+voter.
    */
    function assignVoterDeterministic(bytes32 eventId, address voter)
        external
        onlyOracle
        moduleExists(eventId)
        returns (uint8 stream)
    {
        stream = computeStream(voter, eventId);
        VotingModule(modules[eventId]).assignVoter(voter, stream);
        emit VoterAssigned(eventId, voter, stream);
    }

    /**
     * @notice Assign a voter to the stream with the current **lowest total assigned quadratic weight**.
     * @dev
     * - Uses the same weight formula as VotingModule: sqrt(pledged * 1e18).
     * - Reads pledge via Governance registry key "DonorPledges".
     * - Tie-breaking is deterministic using assignmentSeed.
     * - Updates local `streamAssignedWeight` tracker, then assigns in the VotingModule.
     *
     * Reverts if the DonorPledges contract is not registered.
     */
    function assignVoterLeastWeight(bytes32 eventId, address voter)
        external
        onlyOracle
        moduleExists(eventId)
        returns (uint8 chosen)
    {
        address pledgesAddr = governance.getContractAddress("DonorPledges");
        require(pledgesAddr != address(0), "Oracle: DonorPledges not set");

        // 1) Read pledged amount and compute quadratic weight
        uint256 pledged = DonorPledges(pledgesAddr).getPledgedAmount(voter, eventId);
        uint256 w = sqrt(pledged * 1e18); 

        // 2) Choose stream with minimum assigned weight; break ties with deterministic seed
        uint8 best = _minWeightStream(eventId);
        // If exact ties exist, stable tie-break with keccak(seed,eventId,voter) % 3
        uint256[3] storage sums = streamAssignedWeight[eventId];
        bool tie01 = (sums[0] == sums[1]) && (sums[0] <= sums[2]);
        bool tie02 = (sums[0] == sums[2]) && (sums[0] <= sums[1]);
        bool tie12 = (sums[1] == sums[2]) && (sums[1] <= sums[0]);
        if (tie01 || tie02 || tie12) {
            uint8 tiebreak = uint8(uint256(keccak256(abi.encodePacked(assignmentSeed, eventId, voter))) % 3);
            // Only accept tiebreak if that stream is among the tied minima
            uint256 minv = sums[best];
            if (sums[tiebreak] == minv) {
                best = tiebreak;
            }
        }

        // 3) Update local weight accumulator and assign in module
        streamAssignedWeight[eventId][best] += w;
        VotingModule(modules[eventId]).assignVoter(voter, best);
        emit VoterAssigned(eventId, voter, best);

        return best;
    }

    /// @dev Returns the index s ∈ {0,1,2} with the lowest assigned weight for the event.
    function _minWeightStream(bytes32 eventId) internal view returns (uint8 s) {
        uint256[3] storage sums = streamAssignedWeight[eventId];
        s = 0;
        if (sums[1] < sums[s]) s = 1;
        if (sums[2] < sums[s]) s = 2;
    }

    /// @dev Integer sqrt (same as VotingModule) for consistent weight calculation.
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

    /**
     * @notice Adjust commit/reveal deadlines for the event’s module.
     */
    function adjustDeadlines(bytes32 eventId, uint256 commitDeadline, uint256 revealDeadline)
        external
        onlyOracle
        moduleExists(eventId)
    {
        VotingModule(modules[eventId]).adjustDeadline(commitDeadline, revealDeadline);
        emit DeadlinesAdjusted(eventId, commitDeadline, revealDeadline);
    }

    /**
     * @notice Advance the phase of a single event’s VotingModule (Commit→Reveal→Finalized).
     */
    function advancePhase(bytes32 eventId)
        external
        onlyOracle
        moduleExists(eventId)
    {
        VotingModule vm = VotingModule(modules[eventId]);
        vm.advancePhase();
        emit PhaseAdvanced(eventId, vm.phase());
    }

    // ------------------------------------------------------------------------
    // Oracle Actions → Batch Helpers
    // ------------------------------------------------------------------------

    /**
     * @notice Batch advance phases across multiple eventIds.
     */
    function batchAdvancePhases(bytes32[] calldata eventIds) external onlyOracle {
        for (uint256 i = 0; i < eventIds.length; i++) {
            bytes32 id = eventIds[i];
            if (modules[id] != address(0)) {
                VotingModule vm = VotingModule(modules[id]);
                // try/catch to keep others proceeding even if one reverts for timing
                try vm.advancePhase() {
                    emit PhaseAdvanced(id, vm.phase());
                } catch {
                    // skip if not ready; no revert to avoid halting batch
                }
            }
        }
    }

    // ------------------------------------------------------------------------
    // Views (Convenience Proxies)
    // ------------------------------------------------------------------------

    function getModule(bytes32 eventId) external view returns (address) {
        return modules[eventId];
    }

    function streamTally(bytes32 eventId, uint8 stream)
        external
        view
        moduleExists(eventId)
        returns (uint256 yes, uint256 no, uint256 eligible)
    {
        return VotingModule(modules[eventId]).streamTally(stream);
    }

    function streamResult(bytes32 eventId, uint8 stream)
        external
        view
        moduleExists(eventId)
        returns (bool decided, bool passed)
    {
        return VotingModule(modules[eventId]).streamResult(stream);
    }

    function overallResult(bytes32 eventId)
        external
        view
        moduleExists(eventId)
        returns (bool decided, bool passed, bool[3] memory perStream)
    {
        return VotingModule(modules[eventId]).overallResult();
    }

    // ------------------------------------------------------------------------
    // Deterministic Assignment Helper
    // ------------------------------------------------------------------------

    /**
     * @notice Compute a stream index in {0,1,2} for (voter,eventId) under current seed.
     * @dev Purely deterministic; rotate `assignmentSeed` to reshuffle policy.
     */
    function computeStream(address voter, bytes32 eventId) public view returns (uint8) {
        // Mod 3 to map into Evidence enum {Receipts, Attendance, Photos}
        return uint8(uint256(keccak256(abi.encodePacked(assignmentSeed, eventId, voter))) % 3);
    }
}
