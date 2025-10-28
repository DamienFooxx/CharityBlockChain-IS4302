// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "./Governance.sol";

/**
 * @title CharityReputation
 * @dev Manages charity reputation scores and updates based on event outcomes
 * This contract implements a reputation system similar to Google Reviews,
 * tracking charity performance and providing transparency to donors.
 */
contract CharityReputation {
    
    // --- State Variables ---
    Governance public governance;
    
    // Reputation score structure
    struct ReputationData {
        uint256 score;           // Current reputation score (0-1000)
        uint256 totalEvents;     // Total events participated in
        uint256 successfulEvents; // Successfully completed events
        uint256 failedEvents;    // Failed events
        uint256 lastUpdated;     // Last update timestamp
        uint256 positiveVotes;   // Total positive votes received
        uint256 negativeVotes;   // Total negative votes received
    }
    
    // Mappings
    mapping(uint256 => ReputationData) public reputationScores; // orgId => reputation data
    mapping(uint256 => mapping(uint256 => bool)) public eventOutcomes; // orgId => eventId => success
    
    // Constants
    uint256 public constant MAX_SCORE = 1000;
    uint256 public constant MIN_SCORE = 0;
    uint256 public constant INITIAL_SCORE = 500; // Starting score for new charities
    uint256 public constant SCORE_INCREMENT = 10; // Points added for successful events
    uint256 public constant SCORE_DECREMENT = 20; // Points deducted for failed events
    
    // Events
    event ReputationUpdated(uint256 indexed orgId, uint256 newScore, uint256 change);
    event EventOutcomeRecorded(uint256 indexed orgId, uint256 indexed eventId, bool success);
    event VoteRecorded(uint256 indexed orgId, bool isPositive, uint256 totalPositive, uint256 totalNegative);
    
    // Modifiers
    modifier onlyOracle() {
        require(governance.hasRole(governance.ORACLE_ROLE(), msg.sender), "Not oracle");
        _;
    }
    
    modifier onlyAdmin() {
        require(governance.hasRole(governance.DEFAULT_ADMIN_ROLE(), msg.sender), "Not admin");
        _;
    }
    
    modifier validOrgId(uint256 orgId) {
        require(orgId > 0, "Invalid org ID");
        _;
    }
    
    // Constructor
    constructor(address _governance) {
        require(_governance != address(0), "Invalid governance address");
        governance = Governance(_governance);
    }
    
    // --- Reputation Management ---
    
    /**
     * @dev Initialize reputation for a new charity
     * @param orgId The organization ID
     */
    function initializeReputation(uint256 orgId) 
        external 
        onlyAdmin 
        validOrgId(orgId) 
    {
        require(reputationScores[orgId].lastUpdated == 0, "Reputation already initialized");
        
        reputationScores[orgId] = ReputationData({
            score: INITIAL_SCORE,
            totalEvents: 0,
            successfulEvents: 0,
            failedEvents: 0,
            lastUpdated: block.timestamp,
            positiveVotes: 0,
            negativeVotes: 0
        });
        
        emit ReputationUpdated(orgId, INITIAL_SCORE, 0);
    }
    
    /**
     * @dev Update reputation based on event outcome
     * @param orgId The organization ID
     * @param eventId The event ID
     * @param success Whether the event was successful
     */
    function updateOnEventOutcome(uint256 orgId, uint256 eventId, bool success) 
        external 
        onlyOracle 
        validOrgId(orgId) 
    {
        require(reputationScores[orgId].lastUpdated > 0, "Reputation not initialized");
        require(eventOutcomes[orgId][eventId] == false, "Event already recorded");
        
        ReputationData storage rep = reputationScores[orgId];
        
        // Record the event outcome
        eventOutcomes[orgId][eventId] = success;
        rep.totalEvents++;
        
        if (success) {
            rep.successfulEvents++;
            rep.score = _min(MAX_SCORE, rep.score + SCORE_INCREMENT);
        } else {
            rep.failedEvents++;
            rep.score = _max(MIN_SCORE, rep.score - SCORE_DECREMENT);
        }
        
        rep.lastUpdated = block.timestamp;
        
        emit EventOutcomeRecorded(orgId, eventId, success);
        // emit ReputationUpdated(orgId, rep.score, success ? SCORE_INCREMENT : -SCORE_DECREMENT);
    }
    
    /**
     * @dev Record a vote on charity performance
     * @param orgId The organization ID
     * @param isPositive Whether the vote is positive
     */
    function recordVote(uint256 orgId, bool isPositive) 
        external 
        onlyOracle 
        validOrgId(orgId) 
    {
        require(reputationScores[orgId].lastUpdated > 0, "Reputation not initialized");
        
        ReputationData storage rep = reputationScores[orgId];
        
        if (isPositive) {
            rep.positiveVotes++;
        } else {
            rep.negativeVotes++;
        }
        
        // Adjust score based on vote ratio
        uint256 totalVotes = rep.positiveVotes + rep.negativeVotes;
        if (totalVotes > 0) {
            uint256 positiveRatio = (rep.positiveVotes * 100) / totalVotes;
            
            if (positiveRatio >= 80) {
                rep.score = _min(MAX_SCORE, rep.score + 5);
            } else if (positiveRatio <= 20) {
                rep.score = _max(MIN_SCORE, rep.score - 10);
            }
        }
        
        rep.lastUpdated = block.timestamp;
        
        emit VoteRecorded(orgId, isPositive, rep.positiveVotes, rep.negativeVotes);
        emit ReputationUpdated(orgId, rep.score, 0);
    }
    
    /**
     * @dev Update reputation based on finalization result
     * @param orgId The organization ID
     * @param passed Whether the finalization passed
     */
    function updateOnFinalize(uint256 orgId, bool passed) 
        external 
        onlyOracle 
        validOrgId(orgId) 
    {
        require(reputationScores[orgId].lastUpdated > 0, "Reputation not initialized");
        
        ReputationData storage rep = reputationScores[orgId];
        
        if (passed) {
            rep.score = _min(MAX_SCORE, rep.score + 15);
        } else {
            rep.score = _max(MIN_SCORE, rep.score - 25);
        }
        
        rep.lastUpdated = block.timestamp;
        
        // emit ReputationUpdated(orgId, rep.score, passed ? 15 : -25);
    }
    
    // --- View Functions ---
    
    /**
     * @dev Get reputation score for a charity
     * @param orgId The organization ID
     * @return score The current reputation score
     */
    function scoreOf(uint256 orgId) external view returns (uint256 score) {
        return reputationScores[orgId].score;
    }
    
    /**
     * @dev Get detailed reputation data for a charity
     * @param orgId The organization ID
     * @return data The complete reputation data
     */
    function getReputationData(uint256 orgId) 
        external 
        view 
        returns (ReputationData memory data) 
    {
        return reputationScores[orgId];
    }
    
    /**
     * @dev Get reputation tier based on score
     * @param orgId The organization ID
     * @return tier The reputation tier (1-5)
     */
    function getReputationTier(uint256 orgId) external view returns (uint256 tier) {
        uint256 score = reputationScores[orgId].score;
        
        if (score >= 900) return 5; // Excellent
        if (score >= 750) return 4; // Very Good
        if (score >= 600) return 3; // Good
        if (score >= 400) return 2; // Fair
        return 1; // Poor
    }
    
    /**
     * @dev Check if charity has good reputation
     * @param orgId The organization ID
     * @return hasGoodReputation Whether the charity has good reputation
     */
    function hasGoodReputation(uint256 orgId) external view returns (bool) {
        return reputationScores[orgId].score >= 600;
    }
    
    /**
     * @dev Get success rate for a charity
     * @param orgId The organization ID
     * @return successRate The success rate percentage (0-100)
     */
    function getSuccessRate(uint256 orgId) external view returns (uint256 successRate) {
        ReputationData memory rep = reputationScores[orgId];
        if (rep.totalEvents == 0) return 0;
        return (rep.successfulEvents * 100) / rep.totalEvents;
    }
    
    /**
     * @dev Get vote ratio for a charity
     * @param orgId The organization ID
     * @return positiveRatio The positive vote ratio percentage (0-100)
     */
    function getVoteRatio(uint256 orgId) external view returns (uint256 positiveRatio) {
        ReputationData memory rep = reputationScores[orgId];
        uint256 totalVotes = rep.positiveVotes + rep.negativeVotes;
        if (totalVotes == 0) return 0;
        return (rep.positiveVotes * 100) / totalVotes;
    }
    
    // --- Internal Functions ---
    
    /**
     * @dev Get minimum of two values
     */
    function _min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }
    
    /**
     * @dev Get maximum of two values
     */
    function _max(uint256 a, uint256 b) internal pure returns (uint256) {
        return a > b ? a : b;
    }

    // --- Compatibility Wrapper API ---
    /**
     * @notice Updates reputation by wallet and approved flag (shim).
     */
    function updateReputation(address charityWallet, bool approved_) external onlyOracle {
        require(charityWallet != address(0), "Invalid wallet");
        // In this simplified shim we assume orgId == 1 for first-time mapping if missing
        // Preferably, integrate with CharityRegistry to resolve orgId by wallet.
        // Here, try to read an orgId-like mapping by hashing the wallet for demo purposes.
        uint256 orgId = uint256(uint160(charityWallet));
        if (reputationScores[orgId].lastUpdated == 0) {
            reputationScores[orgId] = ReputationData({
                score: INITIAL_SCORE,
                totalEvents: 0,
                successfulEvents: 0,
                failedEvents: 0,
                lastUpdated: block.timestamp,
                positiveVotes: 0,
                negativeVotes: 0
            });
        }
        ReputationData storage rep = reputationScores[orgId];
        rep.totalEvents++;
        if (approved_) {
            rep.successfulEvents++;
            rep.score = _min(MAX_SCORE, rep.score + 10);
        } else {
            rep.failedEvents++;
            rep.score = _max(MIN_SCORE, rep.score - 20);
        }
        rep.lastUpdated = block.timestamp;
        emit ReputationUpdated(orgId, rep.score, approved_ ? 10 : 20);
    }

    /**
     * @notice Retrieves public score by wallet (shim).
     */
    function getReputation(address charityWallet) external view returns (uint256) {
        uint256 orgId = uint256(uint160(charityWallet));
        return reputationScores[orgId].score;
    }
}