// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "./Registry.sol";
import "./CharityRegistry.sol";

/**
 * @title CharityEvent
 * @dev Manages individual charity events with funding phases, verification, and payout logic
 * 
 * States:
 * 1. FUNDING - Accepting pledges/donations
 * 2. CLOSED - Funding period ended, charity executes the event
 * 3. VERIFICATION - Evidence submitted, awaiting verification
 * 4. APPROVED - Verification successful, funds can be released
 * 5. REJECTED - Verification failed, funds should be refunded
 */
contract CharityEvent is Registry {
    
    // --- Enums ---
    enum EventPhase {
        FUNDING,
        CLOSED,
        VERIFICATION,
        APPROVED,
        REJECTED,
        CANCELLED
    }
    
    // --- State Variables ---
    bytes32 public immutable eventId;
    uint256 public immutable orgId;
    address public immutable charityOwner;
    address public immutable beneficiary;
    address public charityRegistry;
    
    uint256 public fundingGoal;
    uint256 public fundingDeadline;
    uint256 public totalRaised;
    
    EventPhase public phase;
    bool public verified;
    bool[3] public perStreamLast; // Last verification result per stream
    
    string public eventDescription;
    string public evidenceCID; // IPFS CID for evidence
    
    uint256 public createdAt;
    uint256 public closedAt;
    uint256 public verifiedAt;
    
    uint256 public retryCount;
    
    // --- Events ---
    event EventCreated(
        bytes32 indexed eventId,
        uint256 indexed orgId,
        uint256 fundingGoal,
        uint256 deadline
    );
    
    event PhaseChanged(bytes32 indexed eventId, EventPhase oldPhase, EventPhase newPhase);
    
    event FundsRaised(bytes32 indexed eventId, uint256 totalRaised);
    
    event EvidenceSubmitted(bytes32 indexed eventId, string evidenceCID);
    
    event VerifiedSet(bytes32 indexed eventId, bool verified, bool[3] perStream);
    
    event RetryRequested(bytes32 indexed eventId, string newEvidenceCID);
    
    event Cancelled(bytes32 indexed eventId, uint256 timestamp);
    
    // --- Modifiers ---
    modifier onlyOracle() {
        require(governance.hasRole(governance.ORACLE_ROLE(), msg.sender), "Not oracle");
        _;
    }
    
    modifier onlyCharityOwner() {
        require(msg.sender == charityOwner, "Not charity owner");
        _;
    }
    
    modifier inPhase(EventPhase _phase) {
        require(phase == _phase, "Wrong phase");
        _;
    }
    
    // --- Constructor ---
    constructor(
        address _governance,
        address _charityRegistry,
        bytes32 _eventId,
        uint256 _orgId,
        address _beneficiary,
        uint256 _fundingGoal,
        uint256 _fundingDeadline,
        string memory _description
    ) Registry(_governance) {
        require(_eventId != bytes32(0), "Invalid event ID");
        require(_orgId > 0, "Invalid org ID");
        require(_beneficiary != address(0), "Invalid beneficiary");
        require(_fundingGoal > 0, "Invalid funding goal");
        require(_fundingDeadline > block.timestamp, "Invalid deadline");
        
        eventId = _eventId;
        orgId = _orgId;
        charityRegistry = _charityRegistry;
        charityOwner = msg.sender;
        beneficiary = _beneficiary;
        fundingGoal = _fundingGoal;
        fundingDeadline = _fundingDeadline;
        eventDescription = _description;
        
        phase = EventPhase.FUNDING;
        createdAt = block.timestamp;
        
        emit EventCreated(_eventId, _orgId, _fundingGoal, _fundingDeadline);
    }
    
    // --- Core Functions ---
    
    /**
     * @dev Update total raised amount (called by pledge contract)
     */
    function updateRaised(uint256 amount) 
        external 
        whenNotPaused 
        inPhase(EventPhase.FUNDING) 
    {
        // This should be called by the DonorPledges contract
        totalRaised += amount;
        emit FundsRaised(eventId, totalRaised);
        
        // Auto-close if goal reached
        if (totalRaised >= fundingGoal) {
            _transitionPhase(EventPhase.CLOSED);
        }
    }
    
    /**
     * @dev Charity closes funding period
     */
    function closeFunding() 
        external 
        onlyCharityOwner 
        whenNotPaused 
        inPhase(EventPhase.FUNDING) 
    {
        _transitionPhase(EventPhase.CLOSED);
    }
    
    /**
     * @dev Charity submits evidence after completing the event
     */
    function submitEvidence(string calldata _evidenceCID) 
        external 
        onlyCharityOwner 
        whenNotPaused 
        inPhase(EventPhase.CLOSED) 
    {
        require(bytes(_evidenceCID).length > 0, "Invalid evidence CID");
        
        evidenceCID = _evidenceCID;
        _transitionPhase(EventPhase.VERIFICATION);
        
        emit EvidenceSubmitted(eventId, _evidenceCID);
    }
    
    /**
     * @dev Oracle marks verification status based on voting outcome
     */
    function setVerified(bool _verified, bool[3] calldata perStream) 
        external 
        onlyOracle 
        inPhase(EventPhase.VERIFICATION) 
    {
        verified = _verified;
        perStreamLast = perStream;
        verifiedAt = block.timestamp;
        
        if (_verified) {
            _transitionPhase(EventPhase.APPROVED);
        } else {
            _transitionPhase(EventPhase.REJECTED);
        }
        
        emit VerifiedSet(eventId, _verified, perStream);
    }
    
    /**
     * @dev Charity requests retry after updating evidence
     */
    function requestRetry(string calldata newEvidenceCID) 
        external 
        onlyCharityOwner 
        whenNotPaused 
        inPhase(EventPhase.REJECTED) 
    {
        require(bytes(newEvidenceCID).length > 0, "Invalid evidence CID");
        require(retryCount < 3, "Max retries reached");
        
        evidenceCID = newEvidenceCID;
        retryCount++;
        _transitionPhase(EventPhase.VERIFICATION);
        
        emit RetryRequested(eventId, newEvidenceCID);
    }
    
    /**
     * @dev Cancel event (emergency only)
     */
    function cancel() external onlyAdmin whenNotPaused {
        _transitionPhase(EventPhase.CANCELLED);
        emit Cancelled(eventId, block.timestamp);
    }
    
    // --- View Functions ---
    
    // removed unnecessary getters; rely on public state variables
    
    /**
     * @dev Get event summary
     */
    function getEventSummary() 
        external 
        view 
        returns (
            bytes32 eventIdValue,
            uint256 organizationId,
            EventPhase currentPhase,
            uint256 goal,
            uint256 raised,
            address beneficiaryAddr,
            bool isVerified,
            uint256 deadline
        ) 
    {
        return (
            eventId,
            orgId,
            phase,
            fundingGoal,
            totalRaised,
            beneficiary,
            verified,
            fundingDeadline
        );
    }
    
    // --- Internal Functions ---
    
    /**
     * @dev Transition to a new phase
     */
    function _transitionPhase(EventPhase newPhase) internal {
        EventPhase oldPhase = phase;
        phase = newPhase;
        
        if (newPhase == EventPhase.CLOSED) {
            closedAt = block.timestamp;
        }
        
        emit PhaseChanged(eventId, oldPhase, newPhase);
    }

    // --- Compatibility Wrapper API ---
    /**
     * @notice Initializes a new charity event (shim). This contract is already constructed with its
     *         parameters; this function records a new description hash and adjusts goal/deadline if still in FUNDING.
     */
    function createEvent(string calldata _name, uint256 _goal, uint256 _duration, string calldata _metadataHash) external onlyCharityOwner whenNotPaused inPhase(EventPhase.FUNDING) {
        require(bytes(_metadataHash).length > 0, "Invalid metadata");
        if (_goal > 0) {
            fundingGoal = _goal;
        }
        if (_duration > 0) {
            fundingDeadline = block.timestamp + _duration;
        }
        eventDescription = _name;
        evidenceCID = _metadataHash; // track initial metadata
    }

    /**
     * @notice Locks donor funds (shim). For integration, this increments raised balance.
     */
    function stakeDonation(uint256 amount) external whenNotPaused inPhase(EventPhase.FUNDING) {
        require(amount > 0, "Amount must be > 0");
        totalRaised += amount;
        emit FundsRaised(eventId, totalRaised);
        if (totalRaised >= fundingGoal) {
            _transitionPhase(EventPhase.CLOSED);
        }
    }

    /**
     * @notice Submits post-event proof (shim).
     */
    function submitProof(string calldata proofHash) external onlyCharityOwner whenNotPaused inPhase(EventPhase.CLOSED) {
        require(bytes(proofHash).length > 0, "Invalid proof");
        evidenceCID = proofHash;
        _transitionPhase(EventPhase.VERIFICATION);
        emit EvidenceSubmitted(eventId, proofHash);
    }

    /**
     * @notice Finalizes event (shim). Mirrors setVerified path.
     */
    function finalizeEvent(bool approved_) external onlyOracle whenNotPaused inPhase(EventPhase.VERIFICATION) {
        verified = approved_;
        perStreamLast = [approved_, approved_, approved_];
        verifiedAt = block.timestamp;
        _transitionPhase(approved_ ? EventPhase.APPROVED : EventPhase.REJECTED);
        emit VerifiedSet(eventId, approved_, perStreamLast);
    }

    /**
     * @notice Returns simplified event metadata for front-end display.
     */
    function getSummary() external view returns (
        string memory name_,
        uint256 goal_,
        uint256 durationRemaining_,
        string memory metadataHash_
    ) {
        name_ = eventDescription;
        goal_ = fundingGoal;
        durationRemaining_ = block.timestamp >= fundingDeadline ? 0 : (fundingDeadline - block.timestamp);
        metadataHash_ = evidenceCID;
    }
}