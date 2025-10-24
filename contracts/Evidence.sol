// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./Registry.sol";

/**
 * @title EvidenceVault
 * @dev Stores immutable evidence hashes (e.g., IPFS CIDs) for each charity event.
 * @dev This contract acts as a registry. It is written to by an Admin/Oracle
 * and read by donors during the voting phase.
 */
contract EvidenceVault is Registry {

    /**
     * @dev Holds the hashes for the three required proof types for an event.
     * @param receiptsHash A bytes32 hash (e.g., IPFS) of financial receipts.
     * @param attendanceHash A bytes32 hash of beneficiary/attendance records.
     * @param photosHash A bytes32 hash of photographic evidence.
     * @param submitted Indicates if evidence has been lodged for this event.
     */
    struct EvidenceSet {
        bytes32 receiptsHash;
        bytes32 attendanceHash;
        bytes32 photosHash;
        bool submitted;
    }

    /// @notice Maps an eventId to its set of evidence hashes.
    mapping(bytes32 => EvidenceSet) public evidenceByEvent;

    /// @notice Emitted when evidence is successfully submitted for an event.
    event EvidenceSubmitted(
        bytes32 indexed eventId, 
        bytes32 receipts, 
        bytes32 attendance, 
        bytes32 photos
    );

    /**
     * @dev Links the vault to the central Governance contract.
     * @param _governanceAddress The address of the deployed Governance contract.
     */
    constructor(address _governanceAddress) Registry(_governanceAddress) {
        // Inherits and sets the governance contract address
    }

    /**
     * @notice Submits the evidence hashes for a specific charity event.
     * @dev This function is restricted to admins (like the Oracle).
     * @param eventId The unique identifier for the event.
     * @param receipts The bytes32 hash for the receipts evidence.
     * @param attendance The bytes32 hash for the attendance evidence.
     * @param photos The bytes32 hash for the photos evidence.
     */
    function submitEvidence(
        bytes32 eventId, 
        bytes32 receipts, 
        bytes32 attendance, 
        bytes32 photos
    ) 
        external 
        onlyAdmin         // Ensures only an admin can submit
        whenNotPaused     // Respects local pause
        whenSystemNotPaused // Respects global governance pause
    {
        require(eventId != bytes32(0), "Invalid eventId");
        require(!evidenceByEvent[eventId].submitted, "Evidence already submitted");

        evidenceByEvent[eventId] = EvidenceSet({
            receiptsHash: receipts,
            attendanceHash: attendance,
            photosHash: photos,
            submitted: true
        });

        emit EvidenceSubmitted(eventId, receipts, attendance, photos);
    }

    /**
     * @notice Retrieves the full set of evidence hashes for an event.
     * @param eventId The unique identifier for the event.
     * @return The EvidenceSet struct for that event.
     */
    function getEvidence(bytes32 eventId) 
        external 
        view 
        returns (EvidenceSet memory)
    {
        return evidenceByEvent[eventId];
    }
}