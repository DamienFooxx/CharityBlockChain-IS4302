// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/*
Holds stakes, tracks phases, handles quorum/thresholds, and triggers payouts or refunds.
This will hold 4 different states: Raising Funds, Closed for funding, After Charity, after approval/disapproval
*/

interface CharityEvent{
    function id() external view returns (bytes32);
    /**
    Purpose
        Expose the destination for escrow disbursement.
    Access
        view.
    Edge cases
        Ensure non-zero, and mutable only by event owner (if you allow changes, record them on-chain).
 */
    function beneficiary() external view returns (address);
    
    /**
    Purpose: Allow the Oracle to mark the event’s verification status and store the last per-stream truth.
    Access: onlyOracle (enforce inside CharityEvent).
    Preconditions: Called only after DonorVoting returns (decided == true).
    For pass: perStream should all be true.
    State changes: Set verified, Save perStreamLast.
    Events: VerifiedSet(verified, perStream).
    Edge cases:If you allow retries, subsequent rounds can call setVerified(true, …) again; store round number if you want history.
     */
    function setVerified(bool verified, bool[3] calldata perStream) external;
    
    /**
     * @notice Charity requests another verification round after updating evidence off-chain.
     * @dev Oracle remains the ultimate gatekeeper; this does not auto-start a retry.
     */
    function requestRetry() external;
}