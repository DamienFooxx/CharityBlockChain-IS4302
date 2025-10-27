// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "./Governance.sol";
import "./AttestorVoting.sol";
import "./DonorVoting.sol";
import "./EscrowVault.sol";
import "./CharityEvent.sol";

contract Oracle {
    Governance public immutable governance;
    bytes32 public constant ORACLE_ROLE = keccak256("ORACLE_ROLE");
    uint8   public constant NUM_STREAMS = 3;

    struct Modules {
        address donor; // DonorVoting contract
        address attestor; // AttestorVoting contract
        address charity; // CharityEvent metadata controller (wishful)
    }

    // eventId => module addresses
    mapping(bytes32 => Modules) public modules;

    // assignment seeds (deterministic assignment)
    bytes32 public voterAssignmentSeed;
    bytes32 public attestorAssignmentSeed;

    // Keep a record of assignments
    mapping(bytes32 => mapping(address => uint8)) public voterStream; // eventId => voter => stream
    mapping(bytes32 => mapping(address => bool))  public voterIsAssigned;
    mapping(bytes32 => mapping(address => uint8)) public attestorStream; // eventId => attestor => stream
    mapping(bytes32 => mapping(address => bool))  public attestorIsAssigned;
    // Track the active round and module history per event
    mapping(bytes32 => uint256) public currentRound;
    mapping(bytes32 => address[]) public donorRounds; // donorRounds[eventId][round] = DonorVoting addr
    mapping(bytes32 => address[]) public attestorRounds; // attestorRounds[eventId][round] = AttestorVoting addr

    /**
    * Events
    */
    event ModulesSet(bytes32 indexed eventId, address donor, address attestor, address charity);
    event VoterAssigned(bytes32 indexed eventId, address indexed voter, uint8 stream);
    event AttestorAssigned(bytes32 indexed eventId, address indexed attestor, uint8 stream);
    event SeedsUpdated(bytes32 voterSeed, bytes32 attestorSeed);
    event DeadlinesUpdated(bytes32 indexed eventId, uint256 donorCommit, uint256 donorReveal, uint256 attCommit, uint256 attReveal);
    event PhasesAdvanced(bytes32 indexed eventId, string which);
    event StreamSettled(bytes32 indexed eventId, uint8 stream, bool donorOutcomeTrue);
    event Disbursed(bytes32 indexed eventId, address to);
    event RetryRequested(bytes32 indexed eventId, address requestedBy);
    event RetryStarted(bytes32 indexed eventId, uint256 newRound, address donor, address attestor);

    /**
    * Modifiers
     */
    modifier onlyOracle() {
        require(governance.hasRole(ORACLE_ROLE, msg.sender), "OracleAstraea: not oracle");
        _;
    }
    modifier eventExists(bytes32 eventId) {
        require(modules[eventId].donor != address(0), "OracleAstraea: donor module not set");
        require(modules[eventId].attestor != address(0), "OracleAstraea: attestor module not set");
        _;
    }

    constructor(address _governance, bytes32 _voterSeed, bytes32 _attestorSeed) {
        require(_governance != address(0), "OracleAstraea: zero governance");
        governance = Governance(_governance);
        voterAssignmentSeed = _voterSeed;
        attestorAssignmentSeed = _attestorSeed;
    }

    /**
     * @notice Register modules for an event in one go (given CharityEvent already deployed).
     */
    function setModules(bytes32 eventId, address donor, address attestor, address charity)
        external
        onlyOracle
    {
        require(eventId != bytes32(0), "OracleAstraea: empty eventId");
        require(donor != address(0) && attestor != address(0), "OracleAstraea: zero module");
        modules[eventId] = Modules({donor: donor, attestor: attestor, charity: charity});
        emit ModulesSet(eventId, donor, attestor, charity);
    }

    function setSeeds(bytes32 voterSeed, bytes32 attSeed) external onlyOracle {
        voterAssignmentSeed = voterSeed;
        attestorAssignmentSeed = attSeed;
        emit SeedsUpdated(voterSeed, attSeed);
    }

    function startRetry(
        bytes32 eventId,
        address newDonor,
        address newAttestor,
        uint256 donorCommit, uint256 donorReveal,
        uint256 attCommit, uint256 attReveal
    ) external onlyOracle {
        require(canStartRetry(eventId), "OracleAstraea: retry not allowed");

        require(newDonor != address(0) && newAttestor != address(0), "OracleAstraea: zero module");

        // Rotate seeds to reshuffle assignments for the new round
        voterAssignmentSeed = keccak256(abi.encodePacked(voterAssignmentSeed, eventId, blockhash(block.number - 1)));
        attestorAssignmentSeed = keccak256(abi.encodePacked(attestorAssignmentSeed, eventId, blockhash(block.number - 1)));
        emit SeedsUpdated(voterAssignmentSeed, attestorAssignmentSeed);

        // Wire deadlines on the fresh modules
        DonorVoting(newDonor).adjustDeadline(donorCommit, donorReveal);
        AttestorVoting(newAttestor).adjustDeadline(attCommit, attReveal);

        // Record round history
        donorRounds[eventId].push(newDonor);
        attestorRounds[eventId].push(newAttestor);
        uint256 round = donorRounds[eventId].length - 1;
        currentRound[eventId] = round;

        // Switch the "active" modules for this eventId
        address charity = modules[eventId].charity;
        modules[eventId] = Modules({ donor: newDonor, attestor: newAttestor, charity: charity });

        emit DeadlinesUpdated(eventId, donorCommit, donorReveal, attCommit, attReveal);
        emit RetryStarted(eventId, round, newDonor, newAttestor);
    }

    /**
    * Functions for Oracle
    */
    function assignVoter(bytes32 eventId, address voter, uint8 stream)
        public
        onlyOracle
        eventExists(eventId)
    {
        require(stream < NUM_STREAMS, "OracleAstraea: bad stream");
        require(!voterIsAssigned[eventId][voter], "OracleAstraea: voter assigned");
        voterIsAssigned[eventId][voter] = true;
        voterStream[eventId][voter] = stream;

        DonorVoting(modules[eventId].donor).assignVoter(voter, stream);
        emit VoterAssigned(eventId, voter, stream);
    }

    function assignVoterDeterministic(bytes32 eventId, address voter)
        external
        onlyOracle
        eventExists(eventId)
        returns (uint8 stream)
    {
        stream = uint8(uint256(keccak256(abi.encodePacked(voterAssignmentSeed, eventId, voter))) % NUM_STREAMS);
        assignVoter(eventId, voter, stream);
    }

    function assignAttestor(bytes32 eventId, address attestor, uint8 stream)
        public
        onlyOracle
        eventExists(eventId)
    {
        require(stream < NUM_STREAMS, "OracleAstraea: bad stream");
        require(!attestorIsAssigned[eventId][attestor], "OracleAstraea: attestor assigned");
        attestorIsAssigned[eventId][attestor] = true;
        attestorStream[eventId][attestor] = stream;

        // persist mapping in module for enforcement
        AttestorVoting(modules[eventId].attestor).recordAttestorAssignment(attestor, stream);
        emit AttestorAssigned(eventId, attestor, stream);
    }

    function assignAttestorDeterministic(bytes32 eventId, address attestor)
        external
        onlyOracle
        eventExists(eventId)
        returns (uint8 stream)
    {
        stream = uint8(uint256(keccak256(abi.encodePacked(attestorAssignmentSeed, eventId, attestor))) % NUM_STREAMS);
        assignAttestor(eventId, attestor, stream);
    }

    // Functions for Voting Modules
    function setAttestorSigmaBounds(bytes32 eventId, uint256 minSigma, uint256 maxSigma)
        external onlyOracle eventExists(eventId)
    {
        AttestorVoting(modules[eventId].attestor).setSigmaBounds(minSigma, maxSigma);
    }

    function setAttestorTau(bytes32 eventId, uint256 tau)
        external onlyOracle eventExists(eventId)
    {
        AttestorVoting(modules[eventId].attestor).setTau(tau);
    }

    function fundAttestorPools(bytes32 eventId, uint256 addRT, uint256 addRF)
        external onlyOracle eventExists(eventId)
    {
        AttestorVoting(modules[eventId].attestor).fundPools(addRT, addRF);
    }

    function setAttestorEligibilityRoot(bytes32 eventId, bytes32 merkleRoot)
        external onlyOracle eventExists(eventId)
    {
        AttestorVoting(modules[eventId].attestor).setEligibilityRoot(merkleRoot);
    }

    function setAttestorChallengeWindow(bytes32 eventId, uint256 seconds_)
        external onlyOracle eventExists(eventId)
    {
        AttestorVoting(modules[eventId].attestor).setChallengeWindow(seconds_);
    }

    /**
    * Admin functions
     */
    function setDeadlines(
        bytes32 eventId,
        uint256 donorCommit, uint256 donorReveal,
        uint256 attCommit,   uint256 attReveal
    ) external onlyOracle eventExists(eventId) {
        DonorVoting(modules[eventId].donor).adjustDeadline(donorCommit, donorReveal);
        AttestorVoting(modules[eventId].attestor).adjustDeadline(attCommit, attReveal);
        emit DeadlinesUpdated(eventId, donorCommit, donorReveal, attCommit, attReveal);
    }

    function advanceDonorPhase(bytes32 eventId) external onlyOracle eventExists(eventId) {
        DonorVoting(modules[eventId].donor).advancePhase();
        emit PhasesAdvanced(eventId, "donor");
    }

    function advanceAttestorPhase(bytes32 eventId) external onlyOracle eventExists(eventId) {
        AttestorVoting(modules[eventId].attestor).advancePhase();
        emit PhasesAdvanced(eventId, "attestor");
    }

    function advanceBothPhases(bytes32 eventId) external onlyOracle eventExists(eventId) {
        DonorVoting(modules[eventId].donor).advancePhase();
        AttestorVoting(modules[eventId].attestor).advancePhase();
        emit PhasesAdvanced(eventId, "both");
    }

    function canStartRetry(bytes32 eventId) public view returns (bool) {
        Modules memory m = modules[eventId];
        require(m.donor != address(0) && m.attestor != address(0), "OracleAstraea: modules not set");
        (bool decided, bool passed, ) = DonorVoting(m.donor).overallResult();
        return decided && !passed;
    }

    function onRetryRequested(bytes32 eventId, address requester) external onlyOracle {
        emit RetryRequested(eventId, requester);
    }

    /**
    * Settlement & Disbursement
    */

    /**
     * @notice Settle attestors for each stream against the donor truth (must be finalized).
     */
    function settleAttestors(bytes32 eventId) external onlyOracle eventExists(eventId) {
        address donor = modules[eventId].donor;
        address att   = modules[eventId].attestor;

        for (uint8 s = 0; s < NUM_STREAMS; s++) {
            (bool decided, ) = DonorVoting(donor).streamResult(s);
            if (decided) {
                // Attestor module computes payouts and allows winners to claim
                AttestorVoting(att).settleStream(s, donor);
                emit StreamSettled(eventId, s, _donorOutcomeTrue(donor, s));
            }
        }
    }

    function _donorOutcomeTrue(address donor, uint8 stream) internal view returns (bool) {
        (, bool passed) = DonorVoting(donor).streamResult(stream);
        return passed; // interpret "passed" == true outcome
    }

    /**
     * @notice If donor layer says all streams passed, mark event verified and release escrow.
     */
    function disburseIfVerified(bytes32 eventId) external onlyOracle eventExists(eventId) {
        (bool decided, bool passed, bool[3] memory perStream) = DonorVoting(modules[eventId].donor).overallResult();
        require(decided, "OracleAstraea: donor not decided");
        require(passed,  "OracleAstraea: not verified");

        // Mark verified at the project/event contract
        if (modules[eventId].charity != address(0)) {
            CharityEvent(modules[eventId].charity).setVerified(true, perStream);
        }

        // Release funds from Escrow to the event's beneficiary
        address escrow = governance.getContractAddress("EscrowVault");
        require(escrow != address(0), "OracleAstraea: EscrowVault not set");

        address beneficiary = address(0);
        if (modules[eventId].charity != address(0)) {
            beneficiary = CharityEvent(modules[eventId].charity).beneficiary();
        }
        EscrowVault(escrow).releaseIfVerified(eventId, beneficiary);
        emit Disbursed(eventId, beneficiary);
    }
}