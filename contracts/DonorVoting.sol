// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/**
 * @title DonorVoting Interface
 * @notice
 * Oracle-facing control/read surface for the DonorVoting module that extends your
 * abstract parent VotingModule (phase machine + generic reads).
 *
 * The Oracle coordinates lifecycle (deadlines, phases) and later reads outcomes to:
 * - settle the Attestor layer against donor “truth”
 * - disburse escrow if all streams pass
 *
 * @dev Implementation guidelines for each function are documented inline.
 * Every mutating function below MUST enforce `onlyOracle` using Governance.
 */
contract DonorVoting {
    /**
     * @notice Assign a donor to exactly one evidence stream.
     * @dev
     * Access control:
     *  - MUST be restricted to `onlyOracle`.
     *
     * Preconditions:
     *  - `stream` MUST be in range [0, NUM_STREAMS).
     *  - The donor MUST NOT already be assigned in this round.
     *  - (Recommended) Donor is registered: `donors.isRegistered(voter) == true`.
     *
     * State changes (expected):
     *  - `isAssigned[voter] = true`
     *  - `assignedStream[voter] = stream`
     *
     * Events (recommended):
     *  - `VoterAssigned(address voter, uint8 stream)`
     */
    function assignVoter(address voter, uint8 stream) external;

    /**
     * @notice Adjust commit and reveal deadlines for this module/round.
     * @dev
     * Access control:
     *  - MUST be `onlyOracle`.
     *
     * Preconditions:
     *  - `commitDeadline < revealDeadline`.
     *  - (Policy) MAY forbid setting deadlines in the past or after finalization.
     *
     * State changes (expected):
     *  - Update `commitDeadline` and `revealDeadline`.
     *
     * Events (recommended):
     *  - `DeadlinesAdjusted(uint256 commitDeadline, uint256 revealDeadline)`
     */
    function adjustDeadline(uint256 commitDeadline, uint256 revealDeadline) external;

    /**
     * @notice Advance the module phase: Commit → Reveal → Finalized.
     * @dev
     * Access control:
     *  - MUST be `onlyOracle`.
     *
     * Preconditions:
     *  - If moving to Reveal: `block.timestamp >= commitDeadline`.
     *  - If moving to Finalized: `block.timestamp >= revealDeadline`.
     *
     * Effects:
     *  - Update `phase`.
     *  - On entering `Finalized`, MUST run internal `_finalize()` to compute tallies.
     *
     * Events (expected):
     *  - `PhaseAdvanced(Phase newPhase)`
     *  - On finalize, emit a result event (e.g., `Finalized(bool overall, bool[3] streams)`).
     */
    function advancePhase() external;

    /**
     * @notice Read the per-stream decision (donor “truth”) once finalized.
     * @param stream The evidence stream index (0..2).
     * @return decided `true` iff module is in `Finalized` phase.
     * @return passed  Donor decision for this stream when `decided == true`.
     *
     * @dev
     * Behavior:
     *  - MUST revert if `stream` out of range.
     *  - MUST return `(false, false)` if not finalized yet.
     *  - When finalized, `passed` SHOULD reflect quorum + majority rules
     *    based on the module’s tallies.
     *  - This function MUST be `view` and have no side effects.
     */
    function streamResult(uint8 stream) external view returns (bool decided, bool passed);

    /**
     * @notice Aggregate decision across all streams for escrow gating.
     * @return decided `true` iff module is in `Finalized` phase.
     * @return passed  `true` iff **all** streams passed.
     * @return perStream Array of length 3, each stream’s pass/fail.
     *
     * @dev
     * Behavior:
     *  - MUST return `(false, false, [false,false,false])` if not finalized.
     *  - When finalized, `passed` MUST be `true` only if each `perStream[i]` is `true`.
     *  - This function MUST be `view` and have no side effects.
     */
    function overallResult() external view returns (bool decided, bool passed, bool[3] memory perStream);
}
