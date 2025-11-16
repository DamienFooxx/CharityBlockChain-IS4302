// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "./Registry.sol";

/**
 * @title DonorRanking
 * @dev Manages donor reputation scores and ranking system
 * Tracks contribution history, voting participation, and calculates reputation
 */
contract DonorRanking is Registry {
    
    // Structs
    struct DonorStats {
        uint256 totalDonated;
        uint256 totalEvents;
        uint256 successfulEvents;
        uint256 votingParticipation;
        uint256 reputationScore;
        uint256 lastUpdateTimestamp;
    }

    struct RankingTier {
        string name;
        uint256 minScore;
        uint256 votingWeight; // Multiplier in basis points (100 = 1x, 150 = 1.5x)
    }

    // State variables
    address public donorPledgesContract;
    
    // Reputation parameters (adjustable by governance)
    uint256 public donationWeight = 40; // 40% weight on donation amount
    uint256 public participationWeight = 30; // 30% weight on voting participation
    uint256 public successWeight = 30; // 30% weight on successful events
    
    uint256 public constant MAX_SCORE = 1000; // Maximum reputation score
    uint256 public constant SCORE_DECIMALS = 100; // For precision in calculations
    
    // Authorized contracts that can update stats
    mapping(address => bool) public authorizedUpdaters;
    
    // Mappings
    mapping(address => DonorStats) public donorStats;
    mapping(uint256 => RankingTier) public rankingTiers;
    mapping(address => uint256) public donorTier;
    
    uint256 public tierCount;
    
    // Leaderboard
    address[] public leaderboard;
    mapping(address => uint256) public leaderboardPosition;
    
    // Events
    event ReputationUpdated(
        address indexed donor,
        uint256 newScore,
        uint256 timestamp
    );
    
    event DonorTierChanged(
        address indexed donor,
        uint256 oldTier,
        uint256 newTier
    );
    
    event StatsUpdated(
        address indexed donor,
        uint256 totalDonated,
        uint256 totalEvents,
        uint256 successfulEvents
    );
    
    event UpdaterAuthorized(address indexed updater, bool authorized);

    // Modifiers
    modifier onlyAuthorized() {
        require(authorizedUpdaters[msg.sender], "Not authorized");
        _;
    }

    /**
     * @dev Constructor - Initialize ranking tiers
     */
    constructor(address _governance) Registry(_governance) {
        // Initialize ranking tiers
        _initializeTiers();
    }

    /**
     * @dev Initialize default ranking tiers
     */
    function _initializeTiers() internal {
        rankingTiers[0] = RankingTier("Bronze", 0, 100);      // 1x voting weight
        rankingTiers[1] = RankingTier("Silver", 200, 110);    // 1.1x voting weight
        rankingTiers[2] = RankingTier("Gold", 400, 125);      // 1.25x voting weight
        rankingTiers[3] = RankingTier("Platinum", 600, 150);  // 1.5x voting weight
        rankingTiers[4] = RankingTier("Diamond", 800, 175);   // 1.75x voting weight
        tierCount = 5;
    }

    /**
     * @dev Authorize a contract to update donor stats
     */
    function authorizeUpdater(address _updater, bool _authorized) 
        external 
        onlyAdmin 
    {
        require(_updater != address(0), "Invalid updater address");
        authorizedUpdaters[_updater] = _authorized;
        emit UpdaterAuthorized(_updater, _authorized);
    }

    /**
     * @dev Record a new donation and update stats
     * @param _donor Address of the donor
     * @param _amount Amount donated
     */
    function recordDonation(
        address _donor,
        uint256 _amount
    ) 
        external 
        onlyAuthorized
        whenNotPaused
        whenSystemNotPaused
    {
        require(_donor != address(0), "Invalid donor address");
        require(_amount > 0, "Invalid amount");
        
        DonorStats storage stats = donorStats[_donor];
        
        stats.totalDonated += _amount;
        stats.totalEvents++;
        stats.lastUpdateTimestamp = block.timestamp;
        
        // Update reputation score
        _updateReputationScore(_donor);
        
        emit StatsUpdated(_donor, stats.totalDonated, stats.totalEvents, stats.successfulEvents);
    }

    /**
     * @dev Record voting participation
     * @param _donor Address of the donor
     */
    function recordVoting(address _donor) 
        external 
        onlyAuthorized
        whenNotPaused
        whenSystemNotPaused
    {
        require(_donor != address(0), "Invalid donor address");
        
        DonorStats storage stats = donorStats[_donor];
        stats.votingParticipation++;
        stats.lastUpdateTimestamp = block.timestamp;
        
        _updateReputationScore(_donor);
    }

    /**
     * @dev Record successful event outcome
     * @param _donor Address of the donor
     */
    function recordSuccessfulEvent(address _donor) 
        external 
        onlyAuthorized
        whenNotPaused
        whenSystemNotPaused
    {
        require(_donor != address(0), "Invalid donor address");
        
        DonorStats storage stats = donorStats[_donor];
        stats.successfulEvents++;
        stats.lastUpdateTimestamp = block.timestamp;
        
        _updateReputationScore(_donor);
    }

    /**
     * @dev Calculate and update reputation score
     * @param _donor Address of the donor
     */
    function _updateReputationScore(address _donor) internal {
        DonorStats storage stats = donorStats[_donor];
        
        // Calculate donation score (normalized with diminishing returns)
        uint256 donationScore = _calculateDonationScore(stats.totalDonated);
        
        // Calculate participation score
        uint256 participationScore = stats.totalEvents > 0 
            ? (stats.votingParticipation * MAX_SCORE * SCORE_DECIMALS) / stats.totalEvents 
            : 0;
        
        // Calculate success rate score
        uint256 successScore = stats.totalEvents > 0 
            ? (stats.successfulEvents * MAX_SCORE * SCORE_DECIMALS) / stats.totalEvents 
            : 0;
        
        // Weighted average
        uint256 newScore = (
            (donationScore * donationWeight) +
            (participationScore * participationWeight / SCORE_DECIMALS) +
            (successScore * successWeight / SCORE_DECIMALS)
        ) / 100;
        
        // Cap at MAX_SCORE
        if (newScore > MAX_SCORE) {
            newScore = MAX_SCORE;
        }
        
        stats.reputationScore = newScore;
        
        // Update tier if needed
        _updateDonorTier(_donor, newScore);
        
        // Update leaderboard
        _updateLeaderboard(_donor);
        
        emit ReputationUpdated(_donor, newScore, block.timestamp);
    }

    /**
     * @dev Calculate donation score with diminishing returns
     * @param _totalDonated Total amount donated
     */
    function _calculateDonationScore(uint256 _totalDonated) 
        internal 
        pure 
        returns (uint256) 
    {
        // Use logarithmic scale for fairness
        // Score = min(1000, sqrt(totalDonated/1000))
        if (_totalDonated == 0) return 0;
        
        uint256 normalized = _totalDonated / 1e18; // Normalize by 1 token (18 decimals)
        uint256 score = _sqrt(normalized);
        
        return score > MAX_SCORE ? MAX_SCORE : score;
    }

    /**
     * @dev Square root function (Babylonian method)
     */
    function _sqrt(uint256 x) internal pure returns (uint256) {
        if (x == 0) return 0;
        uint256 z = (x + 1) / 2;
        uint256 y = x;
        while (z < y) {
            y = z;
            z = (x / z + z) / 2;
        }
        return y;
    }

    /**
     * @dev Update donor's tier based on reputation score
     * @param _donor Address of the donor
     * @param _newScore New reputation score
     */
    function _updateDonorTier(
        address _donor,
        uint256 _newScore
    ) internal {
        uint256 oldTier = donorTier[_donor];
        uint256 newTier = oldTier;
        
        // Find appropriate tier
        for (uint256 i = tierCount; i > 0; i--) {
            if (_newScore >= rankingTiers[i - 1].minScore) {
                newTier = i - 1;
                break;
            }
        }
        
        if (newTier != oldTier) {
            donorTier[_donor] = newTier;
            emit DonorTierChanged(_donor, oldTier, newTier);
        }
    }

    /**
     * @dev Update leaderboard position
     * @param _donor Address of the donor
     */
    function _updateLeaderboard(address _donor) internal {
        // Add donor to leaderboard if not present
        if (leaderboardPosition[_donor] == 0) {
            leaderboard.push(_donor);
            leaderboardPosition[_donor] = leaderboard.length;
        }
        
        // Sort leaderboard (simple bubble sort for small lists)
        // For production with many donors, consider using a more efficient structure
        if (leaderboard.length > 1) {
            _sortLeaderboard();
        }
    }

    /**
     * @dev Sort leaderboard by reputation score (descending)
     */
    function _sortLeaderboard() internal {
        uint256 n = leaderboard.length;
        if (n <= 1) return;
        
        // Bubble sort (simple but works for moderate sizes)
        for (uint256 i = 0; i < n - 1; i++) {
            for (uint256 j = 0; j < n - i - 1; j++) {
                if (donorStats[leaderboard[j]].reputationScore < 
                    donorStats[leaderboard[j + 1]].reputationScore) {
                    // Swap
                    address temp = leaderboard[j];
                    leaderboard[j] = leaderboard[j + 1];
                    leaderboard[j + 1] = temp;
                }
            }
        }
        
        // Update positions
        for (uint256 i = 0; i < leaderboard.length; i++) {
            leaderboardPosition[leaderboard[i]] = i + 1;
        }
    }

    /**
     * @dev Get donor statistics
     * @param _donor Address of the donor
     */
    function getDonorStats(address _donor) 
        external 
        view 
        returns (
            uint256 totalDonated,
            uint256 totalEvents,
            uint256 successfulEvents,
            uint256 votingParticipation,
            uint256 reputationScore,
            uint256 tier,
            uint256 position
        ) 
    {
        DonorStats memory stats = donorStats[_donor];
        return (
            stats.totalDonated,
            stats.totalEvents,
            stats.successfulEvents,
            stats.votingParticipation,
            stats.reputationScore,
            donorTier[_donor],
            leaderboardPosition[_donor]
        );
    }

    /**
     * @dev Get voting weight multiplier for a donor
     * @param _donor Address of the donor
     */
    function getVotingWeight(address _donor) 
        external 
        view 
        returns (uint256) 
    {
        uint256 tier = donorTier[_donor];
        return rankingTiers[tier].votingWeight;
    }

    /**
     * @dev Get top N donors from leaderboard
     * @param _count Number of top donors to return
     */
    function getTopDonors(uint256 _count) 
        external 
        view 
        returns (address[] memory, uint256[] memory) 
    {
        uint256 count = _count > leaderboard.length ? leaderboard.length : _count;
        address[] memory topDonors = new address[](count);
        uint256[] memory scores = new uint256[](count);
        
        for (uint256 i = 0; i < count; i++) {
            topDonors[i] = leaderboard[i];
            scores[i] = donorStats[leaderboard[i]].reputationScore;
        }
        
        return (topDonors, scores);
    }

    /**
     * @dev Get tier information
     * @param _tierId ID of the tier
     */
    function getTierInfo(uint256 _tierId) 
        external 
        view 
        returns (
            string memory name,
            uint256 minScore,
            uint256 votingWeight
        ) 
    {
        require(_tierId < tierCount, "Invalid tier ID");
        RankingTier memory tier = rankingTiers[_tierId];
        return (tier.name, tier.minScore, tier.votingWeight);
    }

    /**
     * @dev Update reputation weights (governance function)
     * @param _donationWeight Weight for donation amount
     * @param _participationWeight Weight for voting participation
     * @param _successWeight Weight for successful events
     */
    function updateWeights(
        uint256 _donationWeight,
        uint256 _participationWeight,
        uint256 _successWeight
    ) 
        external 
        onlyAdmin 
    {
        require(_donationWeight + _participationWeight + _successWeight == 100, "Weights must sum to 100");
        
        donationWeight = _donationWeight;
        participationWeight = _participationWeight;
        successWeight = _successWeight;
    }

    /**
     * @dev Get leaderboard size
     */
    function getLeaderboardSize() external view returns (uint256) {
        return leaderboard.length;
    }
}