pragma solidity ^0.8.0;
/*
A reusable token escrow shared by many events.
*/

contract EscrowVault{
    // I need help to define these functions for the VotingModule.sol /DamienFooxx
    function release(bytes32 eventId) external;
    function refund(bytes32 eventId) external;
}