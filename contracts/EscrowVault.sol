// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/*
A reusable token escrow shared by many events.
*/

interface EscrowVault{
    // I need help to define these functions for the VotingModule.sol /DamienFooxx
    /**
    Purpose
        Send locked funds to the beneficiary if and only if the event is verified.
    Access
        Callable by Oracle (or anyone), but the internal check must pass.
    Preconditions (inside EscrowVault)
        to != address(0).
        CharityEvent(eventAddr).verified() == true (direct read or via Governance registry).
        Prevent double release: track released[eventId] == false.
        Enough balance for the event (track deposits per eventId).
    State changes
        Mark released[eventId] = true.
        Transfer assets to to.
    Events
        Released(eventId, to, amount).
    Failure modes
        Revert if not verified, already released, or insufficient funds.
    Security
        Use Checks-Effects-Interactions
        Consider a pull pattern if beneficiaries are contracts.
     */
    function releaseIfVerified(bytes32 eventId, address to) external;
}