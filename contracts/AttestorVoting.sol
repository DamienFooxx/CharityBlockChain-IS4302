// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/**
 * @title AttestorVoting Interface
 * @notice
 * Interface defining all Oracle-facing control functions for the AttestorVoting module
 * under the Astraea verification system.
 *
 * Each function below must be implemented in the concrete AttestorVoting contract.
 * They are called only by the Oracle that coordinates the donor and attestor layers.
 *
 * @dev
 * - DO NOT add heavy logic or randomization in these entrypoints.
 * - Each function should have clear access control: `onlyOracle` (from Governance).
 * - Implement corresponding events to support off-chain audit trails.
 */
contract AttestorVoting {

    /**
     * @notice Sets minimum and maximum stake ("sigma") bounds for attestors.
     * @dev
     * Called by Oracle during configuration or between rounds.
     *
     * Requirements:
     * - Caller must have ORACLE_ROLE.
     * - `maxSigma` must be ≥ `minSigma` (unless maxSigma == 0 for "no cap").
     *
     * State changes:
     * - Update stored `sigmaMin` and `sigmaMax`.
     *
     * Events:
     * - Emit `SigmaBoundsUpdated(uint256 minSigma, uint256 maxSigma)`.
     */
    function setSigmaBounds(uint256 minSigma, uint256 maxSigma) external;

    /**
     * @notice Sets the reward pacing divisor `τ` used to compute each stream's pool slice.
     * @dev
     * Reward per stream = Pool / τ.
     *
     * Requirements:
     * - Caller must have ORACLE_ROLE.
     * - τ must be > 0.
     *
     * State changes:
     * - Update stored `tau`.
     *
     * Events:
     * - Emit `TauUpdated(uint256 oldTau, uint256 newTau)`.
     */
    function setTau(uint256 tau) external;

    /**
     * @notice Increases accounting balances for reward pools RT (True) and RF (False).
     * @dev
     * Typically, the Oracle or DAO funds this before any settlements.
     *
     * Requirements:
     * - Caller must have ORACLE_ROLE.
     * - Contract must already hold sufficient ETH (or ERC20) to cover added balances.
     *
     * State changes:
     * - RT += addRT; RF += addRF.
     *
     * Events:
     * - Emit `PoolsFunded(uint256 newRT, uint256 newRF)`.
     */
    function fundPools(uint256 addRT, uint256 addRF) external;

    /**
     * @notice Defines the Merkle root of eligible attestors for this verification round.
     * @dev
     * Used to restrict commit/reveal participation via off-chain whitelist proofs.
     *
     * Requirements:
     * - Caller must have ORACLE_ROLE.
     *
     * State changes:
     * - Store `eligibilityRoot`.
     *
     * Events:
     * - Emit `EligibilityRootSet(bytes32 root)`.
     */
    function setEligibilityRoot(bytes32 root) external;

    /**
     * @notice Records the attestor's stream assignment determined by the Oracle.
     * @dev
     * Called once per attestor per round.
     *
     * Requirements:
     * - Caller must have ORACLE_ROLE.
     * - Each attestor can be assigned only once.
     *
     * State changes:
     * - Mark `isAssigned[attestor] = true` and store `assignedStream[attestor] = stream`.
     *
     * Events:
     * - Emit `AttestorAssigned(address attestor, uint8 stream)`.
     */
    function recordAttestorAssignment(address attestor, uint8 stream) external;

    /**
     * @notice Adjusts commit and reveal deadlines for the AttestorVoting phase schedule.
     * @dev
     * Mirrors DonorVoting deadlines, but may differ if attestors require extra time.
     *
     * Requirements:
     * - Caller must have ORACLE_ROLE.
     * - `_commitDeadline < _revealDeadline`.
     *
     * State changes:
     * - Update `commitDeadline` and `revealDeadline`.
     *
     * Events:
     * - Emit `DeadlinesAdjusted(uint256 commitDeadline, uint256 revealDeadline)`.
     */
    function adjustDeadline(uint256 commitDeadline, uint256 revealDeadline) external;

    /**
     * @notice Advances the AttestorVoting phase sequentially: Commit → Reveal → Finalized.
     * @dev
     * - Should automatically trigger `_finalize()` when entering `Finalized`.
     * - Called by Oracle according to system schedule.
     *
     * Requirements:
     * - Caller must have ORACLE_ROLE.
     * - Current block.timestamp must be past relevant deadline.
     *
     * State changes:
     * - Update internal `phase`.
     *
     * Events:
     * - Emit `PhaseAdvanced(Phase newPhase)` and, if Finalized, a `Finalized(...)` event.
     */
    function advancePhase() external;

    /**
     * @notice Sets a challenge/appeal window (in seconds) between settlement and claim.
     * @dev
     * Prevents immediate reward withdrawals, allowing disputes or appeals.
     *
     * Requirements:
     * - Caller must have ORACLE_ROLE.
     *
     * State changes:
     * - Store `challengeWindow`.
     *
     * Effects:
     * - Future `claim(stream)` calls must enforce
     *   `block.timestamp >= settledAt[stream] + challengeWindow`.
     *
     * Events:
     * - Emit `ChallengeWindowSet(uint256 seconds_)`.
     */
    function setChallengeWindow(uint256 seconds_) external;

    /**
     * @notice Performs settlement for a specific evidence stream, using donor truth as reference.
     * @dev
     * Called only once per stream, after both Donor and Attestor modules are finalized.
     *
     * Requirements:
     * - Caller must have ORACLE_ROLE.
     * - `stream` in [0, NUM_STREAMS).
     * - `phase == Finalized`.
     * - DonorVoting(donorModule).streamResult(stream) must return (decided = true).
     * - Not already settled.
     *
     * State changes:
     * - Record stream outcome (true/false) according to donor truth.
     * - Compute rewardPerStake for winners and store settlement info.
     * - Deduct pool slice from RT/RF.
     *
     * Events:
     * - Emit `StreamSettled(uint8 stream, bool donorOutcomeTrue, uint256 winnersStake, uint256 losersStake, uint256 poolSlice, uint256 rewardPerStakeRay, bool includePrincipal)`.
     *
     * Failure modes:
     * - Revert if already settled, donor undecided, or invalid stream.
     */
    function settleStream(uint8 stream, address donorModule) external;
}
