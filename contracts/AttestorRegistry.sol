// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "./Registry.sol";

/**
 * @title AttestorRegistry
 * @dev Manages a list of approved attestors who can participate in voting.
 * This is an on-chain alternative to the Merkle Proof system.
 */
contract AttestorRegistry is Registry {

    // Mapping to track registered attestors
    mapping(address => bool) public isRegistered;

    // Event for tracking
    event AttestorRegistered(address indexed attestor, bool registered);

    /**
     * @dev Constructor
     */
    constructor(address _governance) Registry(_governance) {
        // Constructor is empty, just needs to pass governance to parent
    }

    /**
     * @notice (Admin) Add or remove an attestor from the registry.
     * @param _attestor The address of the attestor.
     * @param _isRegistered True to register, false to remove.
     */
    function setAttestorRegistration(address _attestor, bool _isRegistered)
        external
        onlyAdmin
        whenNotPaused
    {
        require(_attestor != address(0), "AttestorRegistry: Zero address");
        isRegistered[_attestor] = _isRegistered;
        emit AttestorRegistered(_attestor, _isRegistered);
    }
}