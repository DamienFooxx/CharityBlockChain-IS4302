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
        string calldata _description
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
     * @dev Get the unique event identifier
     */
    function id() external view returns (bytes32) {
        return eventId;
    }
    
    /**
     * @dev Get the beneficiary address for disbursement
     */
    function beneficiary() external view returns (address) {
        return beneficiary;
    }
    
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
    
    /**
     * @dev Check if event has reached its funding goal
     */
    function goalReached() external view returns (bool) {
        return totalRaised >= fundingGoal;
    }
    
    /**
     * @dev Check if funding deadline has passed
     */
    function fundingDeadlinePassed() external view returns (bool) {
        return block.timestamp >= fundingDeadline;
    }
    
    /**
     * @dev Get verification status
     */
    function verified() external view returns (bool) {
        return verified;
    }
    
    /**
     * @dev Get last per-stream verification results
     */
    function getPerStreamLast() external view returns (bool[3] memory) {
        return perStreamLast;
    }
    
    /**
     * @dev Get event summary
     */
    function getEventSummary() 
        external 
        view 
        returns (
            bytes32 id,
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
}