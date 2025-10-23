// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "./SGDCoin.sol";
import "./Governance.sol";

/**
 * @title CharityTreasury
 * @dev Manages the financial balances and operations for each registered charity
 * This contract acts as the bank account for each charity, handling fund
 * disbursements, withdrawals, and balance tracking.
 */
contract CharityTreasury {
    
    // --- State Variables ---
    SGDCoin public stablecoin;
    Governance public governance;
    
    // Treasury structure for each charity
    struct TreasuryData {
        uint256 orgId;              // Organization ID
        uint256 totalBalance;       // Total balance in the treasury
        uint256 availableBalance;   // Available balance for withdrawal
        uint256 lockedBalance;      // Locked balance for events
        address owner;              // Charity owner address
        bool active;                // Whether treasury is active
        uint256 lastActivity;       // Last activity timestamp
    }
    
    // Event-specific balance tracking
    struct EventBalance {
        uint256 eventId;
        uint256 amount;
        bool released;
        uint256 releaseTime;
    }
    
    // Mappings
    mapping(uint256 => TreasuryData) public treasuries; // orgId => treasury data
    mapping(uint256 => mapping(uint256 => EventBalance)) public eventBalances; // orgId => eventId => balance
    mapping(address => uint256) public addressToOrgId; // address => orgId
    
    // Events
    event TreasuryCreated(uint256 indexed orgId, address owner);
    event FundsReceived(uint256 indexed orgId, uint256 amount, uint256 eventId);
    event FundsReleased(uint256 indexed orgId, uint256 eventId, uint256 amount);
    event FundsWithdrawn(uint256 indexed orgId, address to, uint256 amount);
    event DisbursementRequested(uint256 indexed orgId, uint256 eventId, uint256 amount);
    event TreasuryDeactivated(uint256 indexed orgId);
    
    // Modifiers
    modifier onlyAdmin() {
        require(governance.hasRole(governance.DEFAULT_ADMIN_ROLE(), msg.sender), "Not admin");
        _;
    }
    
    modifier onlyOracle() {
        require(governance.hasRole(governance.ORACLE_ROLE(), msg.sender), "Not oracle");
        _;
    }
    
    modifier onlyTreasuryOwner(uint256 orgId) {
        require(treasuries[orgId].owner == msg.sender, "Not treasury owner");
        _;
    }
    
    modifier treasuryExists(uint256 orgId) {
        require(treasuries[orgId].owner != address(0), "Treasury not found");
        _;
    }
    
    modifier treasuryActive(uint256 orgId) {
        require(treasuries[orgId].active, "Treasury not active");
        _;
    }
    
    // Constructor
    constructor(address _stablecoin, address _governance) {
        require(_stablecoin != address(0), "Invalid stablecoin address");
        require(_governance != address(0), "Invalid governance address");
        
        stablecoin = SGDCoin(_stablecoin);
        governance = Governance(_governance);
    }
    
    // --- Treasury Management ---
    
    /**
     * @dev Create a new treasury for a charity
     * @param orgId The organization ID
     * @param owner The charity owner address
     */
    function createTreasury(uint256 orgId, address owner) 
        external 
        onlyAdmin 
    {
        require(orgId > 0, "Invalid org ID");
        require(owner != address(0), "Invalid owner address");
        require(treasuries[orgId].owner == address(0), "Treasury already exists");
        
        treasuries[orgId] = TreasuryData({
            orgId: orgId,
            totalBalance: 0,
            availableBalance: 0,
            lockedBalance: 0,
            owner: owner,
            active: true,
            lastActivity: block.timestamp
        });
        
        addressToOrgId[owner] = orgId;
        
        emit TreasuryCreated(orgId, owner);
    }
    
    /**
     * @dev Deactivate a treasury
     * @param orgId The organization ID
     */
    function deactivateTreasury(uint256 orgId) 
        external 
        onlyAdmin 
        treasuryExists(orgId) 
    {
        treasuries[orgId].active = false;
        emit TreasuryDeactivated(orgId);
    }
    
    // --- Fund Management ---
    
    /**
     * @dev Receive funds for a specific event
     * @param orgId The organization ID
     * @param eventId The event ID
     * @param amount The amount to receive
     */
    function receiveRelease(uint256 orgId, uint256 eventId, uint256 amount) 
        external 
        onlyOracle 
        treasuryExists(orgId) 
        treasuryActive(orgId) 
    {
        require(amount > 0, "Amount must be positive");
        require(!eventBalances[orgId][eventId].released, "Event already released");
        
        // Transfer tokens from caller to this contract
        require(stablecoin.transferFrom(msg.sender, address(this), amount), "Transfer failed");
        
        // Update treasury balances
        TreasuryData storage treasury = treasuries[orgId];
        treasury.totalBalance += amount;
        treasury.availableBalance += amount;
        treasury.lastActivity = block.timestamp;
        
        // Record event balance
        eventBalances[orgId][eventId] = EventBalance({
            eventId: eventId,
            amount: amount,
            released: false,
            releaseTime: block.timestamp
        });
        
        emit FundsReceived(orgId, amount, eventId);
    }
    
    /**
     * @dev Request disbursement for an event
     * @param eventId The event ID
     * @param amount The amount to disburse
     */
    function requestDisbursement(uint256 eventId, uint256 amount) 
        external 
        treasuryExists(addressToOrgId[msg.sender]) 
        treasuryActive(addressToOrgId[msg.sender]) 
        onlyTreasuryOwner(addressToOrgId[msg.sender]) 
    {
        uint256 orgId = addressToOrgId[msg.sender];
        TreasuryData storage treasury = treasuries[orgId];
        
        require(amount > 0, "Amount must be positive");
        require(amount <= treasury.availableBalance, "Insufficient available balance");
        
        // Lock the funds for this event
        treasury.availableBalance -= amount;
        treasury.lockedBalance += amount;
        
        emit DisbursementRequested(orgId, eventId, amount);
    }
    
    /**
     * @dev Withdraw funds from treasury
     * @param to The address to withdraw to
     * @param amount The amount to withdraw
     */
    function withdraw(address to, uint256 amount) 
        external 
        treasuryExists(addressToOrgId[msg.sender]) 
        treasuryActive(addressToOrgId[msg.sender]) 
        onlyTreasuryOwner(addressToOrgId[msg.sender]) 
    {
        uint256 orgId = addressToOrgId[msg.sender];
        TreasuryData storage treasury = treasuries[orgId];
        
        require(to != address(0), "Invalid recipient address");
        require(amount > 0, "Amount must be positive");
        require(amount <= treasury.availableBalance, "Insufficient available balance");
        
        // Update balances
        treasury.totalBalance -= amount;
        treasury.availableBalance -= amount;
        treasury.lastActivity = block.timestamp;
        
        // Transfer tokens
        require(stablecoin.transfer(to, amount), "Transfer failed");
        
        emit FundsWithdrawn(orgId, to, amount);
    }
    
    /**
     * @dev Release locked funds for an event (called by oracle)
     * @param orgId The organization ID
     * @param eventId The event ID
     * @param approved Whether the event was approved
     */
    function releaseEventFunds(uint256 orgId, uint256 eventId, bool approved) 
        external 
        onlyOracle 
        treasuryExists(orgId) 
        treasuryActive(orgId) 
    {
        TreasuryData storage treasury = treasuries[orgId];
        EventBalance storage eventBalance = eventBalances[orgId][eventId];
        
        require(eventBalance.amount > 0, "No funds for this event");
        require(!eventBalance.released, "Event already processed");
        
        if (approved) {
            // Release funds to charity
            treasury.lockedBalance -= eventBalance.amount;
            treasury.availableBalance += eventBalance.amount;
            
            emit FundsReleased(orgId, eventId, eventBalance.amount);
        } else {
            // Refund funds (this would typically go back to donors)
            treasury.lockedBalance -= eventBalance.amount;
            // Note: In a real implementation, you might want to track refunds separately
        }
        
        eventBalance.released = true;
        eventBalance.releaseTime = block.timestamp;
        treasury.lastActivity = block.timestamp;
    }
    
    // --- View Functions ---
    
    /**
     * @dev Get treasury balance
     * @param orgId The organization ID
     * @return totalBalance Total balance in the treasury
     * @return availableBalance Available balance for withdrawal
     * @return lockedBalance Locked balance for events
     */
    function balanceOf(uint256 orgId) 
        external 
        view 
        treasuryExists(orgId) 
        returns (uint256 totalBalance, uint256 availableBalance, uint256 lockedBalance) 
    {
        TreasuryData memory treasury = treasuries[orgId];
        return (treasury.totalBalance, treasury.availableBalance, treasury.lockedBalance);
    }
    
    /**
     * @dev Get treasury data
     * @param orgId The organization ID
     * @return data The complete treasury data
     */
    function getTreasuryData(uint256 orgId) 
        external 
        view 
        treasuryExists(orgId) 
        returns (TreasuryData memory data) 
    {
        return treasuries[orgId];
    }
    
    /**
     * @dev Get event balance information
     * @param orgId The organization ID
     * @param eventId The event ID
     * @return balance The event balance data
     */
    function getEventBalance(uint256 orgId, uint256 eventId) 
        external 
        view 
        returns (EventBalance memory balance) 
    {
        return eventBalances[orgId][eventId];
    }
    
    /**
     * @dev Get organization ID by address
     * @param addr The address to look up
     * @return orgId The organization ID (0 if not found)
     */
    function getOrgIdByAddress(address addr) external view returns (uint256 orgId) {
        return addressToOrgId[addr];
    }
    
    /**
     * @dev Check if treasury is active
     * @param orgId The organization ID
     * @return isActive Whether the treasury is active
     */
    function isTreasuryActive(uint256 orgId) external view returns (bool isActive) {
        return treasuries[orgId].active;
    }
    
    /**
     * @dev Get treasury owner
     * @param orgId The organization ID
     * @return owner The treasury owner address
     */
    function getTreasuryOwner(uint256 orgId) external view returns (address owner) {
        return treasuries[orgId].owner;
    }
}