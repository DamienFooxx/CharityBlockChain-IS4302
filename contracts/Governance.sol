// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

/**
 * @title Governance
 * @dev This contract is the central control center for the CharityBlockChain ecosystem.
 * It manages all administrative roles, system-wide parameters, and the registry of
 * core contract addresses. It uses OpenZeppelin's AccessControl for role-based
 * permissions and Pausable for an emergency stop mechanism.
 *
 */
contract Governance is AccessControl, Pausable {

    // --- Role Definitions ---
    // DEFAULT_ADMIN_ROLE is the "super admin" who can grant/revoke other roles.
    // ORACLE_ROLE is for the address authorized to manage VotingModule phases and assign voters.
    // ADMIN_ROLE is for day-to-day administration, like updating parameters or registries.
    // PAUSER_ROLE can trigger the emergency pause on this contract and others.
    bytes32 public constant ORACLE_ROLE = keccak256("ORACLE_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    // --- System Parameters ---
    // Stores system-wide variables.
    // Example: The 70% (7000) quorum basis points for the VotingModule.
    uint256 public globalQuorumBps;

    // --- Contract Registry ---
    // Stores the addresses of all other contracts in the system.
    // This allows for easy upgrades.
    mapping(bytes32 => address) public contractAddresses;

    // --- Events ---
    event QuorumUpdated(uint256 newQuorumBps);
    event ContractAddressUpdated(bytes32 indexed name, address newAddress);

    // --- Constructor ---
    constructor(address initialOracle, address initialPauser, uint256 initialQuorumBps) {
        // Grant the deployer the DEFAULT_ADMIN_ROLE.
        // This role can grant/revoke all other roles.
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);

        // Assign initial roles
        _grantRole(ORACLE_ROLE, initialOracle);
        _grantRole(PAUSER_ROLE, initialPauser);
        _grantRole(PAUSER_ROLE, msg.sender); // Deployer can also pause
        
        // Set initial parameters
        globalQuorumBps = initialQuorumBps;
        emit QuorumUpdated(initialQuorumBps);
    }

    // --- Role-Protected Functions (Parameter Management) ---
    /**
     * @dev Updates the global quorum required for voting modules.
     * @param _newQuorumBps The new quorum in basis points (e.g., 7000 for 70%).
     */
    function setGlobalQuorum(uint256 _newQuorumBps)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
        whenNotPaused
    {
        require(_newQuorumBps <= 10000, "Bps > 100%");
        globalQuorumBps = _newQuorumBps;
        emit QuorumUpdated(_newQuorumBps);
    }

    // --- Role-Protected Functions (Contract Registry) ---
    /**
     * @dev Sets or updates the address for a core system contract.
     * @param _name The name of the contract (e.g., "DonorRegistry", "PledgeBook").
     * @param _contractAddress The new address of the contract.
     */
    function setContractAddress(string calldata _name, address _contractAddress)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
        whenNotPaused
    {
        require(_contractAddress != address(0), "Zero address");
        bytes32 nameHash = keccak256(abi.encodePacked(_name));
        contractAddresses[nameHash] = _contractAddress;
        emit ContractAddressUpdated(nameHash, _contractAddress);
    }

    // --- Role-Protected Functions (Emergency Toggles) ---
    /**
     * @dev Triggers an emergency pause on critical functions.
     */
    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    /**
     * @dev Lifts the emergency pause.
     */
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    // --- View Functions (Contract Registry) ---

    /**
     * @dev Helper function to get a contract address by its string name.
     */
    function getContractAddress(string calldata _name) external view returns (address) {
        return contractAddresses[keccak256(abi.encodePacked(_name))];
    }
}