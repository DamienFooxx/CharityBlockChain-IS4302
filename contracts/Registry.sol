// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/security/Pausable.sol";
import "./Governance.sol";

/**
 * @title Registry (Simplified Admin)
 * @dev Parent contract for registries, linked to Governance.
 * Uses DEFAULT_ADMIN_ROLE from Governance for administrative actions.
 */
abstract contract Registry is Pausable {

    Governance public immutable governance;


    // --- Events ---
    event EntryAdded(address indexed account, address indexed addedBy);
    event EntryRemoved(address indexed account, address indexed removedBy);

    constructor(address _governanceAddress) {
        require(_governanceAddress != address(0), "Registry: Zero address for governance");
        governance = Governance(_governanceAddress);
    }

    // --- Modifiers ---
    /**
     * @dev Throws if called by any account that does not have the DEFAULT_ADMIN_ROLE
     * granted in the associated Governance contract.
     */
    modifier onlyAdmin() {
        require(governance.hasRole(DEFAULT_ADMIN_ROLE, msg.sender), "Registry: Caller is not admin");
        _;
    }

    /**
     * @dev Only allows accounts with the PAUSER_ROLE (in Governance) to pause.
     */
    function _authorizePause(address /* account */) internal view override {
        require(governance.hasRole(governance.PAUSER_ROLE(), msg.sender), "Registry: Caller cannot pause");
    }

    /**
     * @dev Only allows accounts with the DEFAULT_ADMIN_ROLE (in Governance) to unpause.
     */
    function _authorizeUnpause(address /* account */) internal view override {
        require(governance.hasRole(DEFAULT_ADMIN_ROLE, msg.sender), "Registry: Caller cannot unpause");
    }

    /**
     * @dev Modifier for system-wide pause check.
     */
    modifier whenSystemNotPaused() {
        require(!governance.paused(), "Registry: System is paused");
        _;
    }

    // --- Pause/Unpause Functions ---
    function pause() external {
        _pause();
    }

    function unpause() external {
        _unpause();
    }
}