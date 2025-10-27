// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract EscrowVault{

    // Track which event IDs have been released
    mapping(bytes32 => bool) public released;

    // Track who the funds were released to
    mapping(bytes32 => address) public releaseRecipient;

    /**
     * @dev This is the function Oracle.sol will call.
     * We just record that it was called successfully.
     */
    function releaseIfVerified(bytes32 eventId, address to) external {
        released[eventId] = true;
        releaseRecipient[eventId] = to;
    }
}