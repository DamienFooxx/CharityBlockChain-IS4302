// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "./Governance.sol";

/**
 * @title CharityRegistry
 * @dev Manages charity registration, approval status, and treasury assignment
 * This contract handles the registration of legitimate charities and maintains
 * their approval status for participation in the platform.
 */
contract CharityRegistry {
    
    // --- State Variables ---
    Governance public governance;
    
    // Charity profile structure
    struct CharityProfile {
        string name;
        string metaCID; // IPFS content identifier for metadata
        bool approved;
        address treasury;
        uint256 registrationTime;
        address registrant;
    }
    
    // Mappings
    mapping(uint256 => CharityProfile) public profiles; // orgId => profile
    mapping(address => uint256) public addressToOrgId; // address => orgId
    mapping(uint256 => bool) public approved; // orgId => approval status
    mapping(uint256 => address) public treasuryOf; // orgId => treasury address
    
    // Counters
    uint256 public nextOrgId = 1;
    uint256 public totalRegistered = 0;
    uint256 public totalApproved = 0;
    
    // Events
    event CharityRegistered(uint256 indexed orgId, string name, address registrant);
    event CharityApproved(uint256 indexed orgId, bool approved);
    event ProfileUpdated(uint256 indexed orgId, string metaCID);
    event TreasuryAssigned(uint256 indexed orgId, address treasury);
    
    // Modifiers
    modifier onlyAdmin() {
        require(governance.hasRole(governance.DEFAULT_ADMIN_ROLE(), msg.sender), "Not admin");
        _;
    }
    
    modifier onlyOracle() {
        require(governance.hasRole(governance.ORACLE_ROLE(), msg.sender), "Not oracle");
        _;
    }
    
    modifier charityExists(uint256 orgId) {
        require(profiles[orgId].registrant != address(0), "Charity not found");
        _;
    }
    
    // Constructor
    constructor(address _governance) {
        require(_governance != address(0), "Invalid governance address");
        governance = Governance(_governance);
    }
    
    // --- Registration Functions ---
    
    /**
     * @dev Register a new charity
     * @param name The name of the charity organization
     * @param metaCID IPFS content identifier for charity metadata
     * @return orgId The assigned organization ID
     */
    function registerCharity(string calldata name, string calldata metaCID) 
        external 
        returns (uint256 orgId) 
    {
        require(bytes(name).length > 0, "Name cannot be empty");
        require(bytes(metaCID).length > 0, "MetaCID cannot be empty");
        require(addressToOrgId[msg.sender] == 0, "Address already registered");
        
        orgId = nextOrgId++;
        
        profiles[orgId] = CharityProfile({
            name: name,
            metaCID: metaCID,
            approved: false,
            treasury: address(0),
            registrationTime: block.timestamp,
            registrant: msg.sender
        });
        
        addressToOrgId[msg.sender] = orgId;
        totalRegistered++;
        
        emit CharityRegistered(orgId, name, msg.sender);
        
        return orgId;
    }
    
    /**
     * @dev Update charity profile metadata
     * @param orgId The organization ID
     * @param metaCID New IPFS content identifier for metadata
     */
    function updateProfile(uint256 orgId, string calldata metaCID) 
        external 
        charityExists(orgId) 
    {
        require(bytes(metaCID).length > 0, "MetaCID cannot be empty");
        require(
            profiles[orgId].registrant == msg.sender || 
            governance.hasRole(governance.DEFAULT_ADMIN_ROLE(), msg.sender),
            "Not authorized"
        );
        
        profiles[orgId].metaCID = metaCID;
        
        emit ProfileUpdated(orgId, metaCID);
    }
    
    // --- Approval Functions ---
    
    /**
     * @dev Approve or disapprove a charity
     * @param orgId The organization ID
     * @param isApproved Whether to approve the charity
     */
    function setApproval(uint256 orgId, bool isApproved) 
        external 
        onlyAdmin 
        charityExists(orgId) 
    {
        bool wasApproved = profiles[orgId].approved;
        profiles[orgId].approved = isApproved;
        approved[orgId] = isApproved;
        
        if (isApproved && !wasApproved) {
            totalApproved++;
        } else if (!isApproved && wasApproved) {
            totalApproved--;
        }
        
        emit CharityApproved(orgId, isApproved);
    }
    
    /**
     * @dev Check if a charity is approved
     * @param orgId The organization ID
     * @return Whether the charity is approved
     */
    function isApproved(uint256 orgId) external view returns (bool) {
        return profiles[orgId].approved;
    }
    
    // --- Treasury Management ---
    
    /**
     * @dev Assign a treasury contract to a charity
     * @param orgId The organization ID
     * @param treasury The treasury contract address
     */
    function setTreasury(uint256 orgId, address treasury) 
        external 
        onlyAdmin 
        charityExists(orgId) 
    {
        require(treasury != address(0), "Invalid treasury address");
        
        profiles[orgId].treasury = treasury;
        treasuryOf[orgId] = treasury;
        
        emit TreasuryAssigned(orgId, treasury);
    }
    
    // --- View Functions ---
    
    /**
     * @dev Get charity profile information
     * @param orgId The organization ID
     * @return profile The charity profile
     */
    function getProfile(uint256 orgId) 
        external 
        view 
        charityExists(orgId) 
        returns (CharityProfile memory profile) 
    {
        return profiles[orgId];
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
     * @dev Get treasury address for a charity
     * @param orgId The organization ID
     * @return treasury The treasury contract address
     */
    function getTreasury(uint256 orgId) external view returns (address treasury) {
        return treasuryOf[orgId];
    }
    
    /**
     * @dev Get total statistics
     * @return registered Total registered charities
     * @return approved Total approved charities
     */
    function getStats() external view returns (uint256 registered, uint256 approved) {
        return (totalRegistered, totalApproved);
    }
}
