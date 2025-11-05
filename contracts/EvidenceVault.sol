// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "./DonorVoting.sol";

/**
 * @title EvidenceVault
 * @dev Simple on-chain registry of IPFS CIDs for evidence per event and per stream.
 * Charities (or their CharityEvent contract) store the IPFS CID for a given event+stream.
 * Voters can then query the vault to read the CID for the stream they were assigned to
 * by passing the DonorVoting module address (the vault reads the `assignedStream` mapping).
 *
 * Notes:
 * - The contract stores only IPFS content hashes (CIDs) as strings to minimize gas vs storing full content.
 * - Currently `storeEvidence` allows the first writer to set a CID for an event+stream and it is immutable thereafter.
 * - For stronger access control you can restrict `storeEvidence` to a registry/oracle/charity contract.
 */
contract EvidenceVault {
    uint8 public constant NUM_STREAMS = 3;

    // eventId => streamId => ipfs cid
    mapping(bytes32 => mapping(uint8 => string)) private evidenceCid;

    event EvidenceStored(
        bytes32 indexed eventId,
        uint8 indexed stream,
        string cid,
        address indexed submittedBy,
        uint256 timestamp
    );

    /**
     * @notice Store IPFS CID for a specific event and stream.
     * @dev Immutable: a CID can only be set once per event+stream.
     * @param eventId The event identifier (matches CharityEvent.eventId)
     * @param stream The stream index (0..NUM_STREAMS-1)
     * @param cid The IPFS CID (as a string)
     */
    function storeEvidence(
        bytes32 eventId,
        uint8 stream,
        string calldata cid
    ) external {
        require(eventId != bytes32(0), "EvidenceVault: zero eventId");
        require(stream < NUM_STREAMS, "EvidenceVault: bad stream");
        require(bytes(cid).length > 0, "EvidenceVault: empty cid");
        require(
            bytes(evidenceCid[eventId][stream]).length == 0,
            "EvidenceVault: evidence exists"
        );

        evidenceCid[eventId][stream] = cid;
        emit EvidenceStored(eventId, stream, cid, msg.sender, block.timestamp);
    }

    /**
     * @notice Read CID for a given event+stream.
     */
    function getEvidence(
        bytes32 eventId,
        uint8 stream
    ) external view returns (string memory) {
        require(stream < NUM_STREAMS, "EvidenceVault: bad stream");
        return evidenceCid[eventId][stream];
    }

    /**
     * @notice Convenience: return the evidence CID for the stream the caller (voter)
     *         was assigned to in the DonorVoting module for this event.
     * @param eventId The event identifier
     * @param donorVotingModule The DonorVoting contract address for that event/round
     * @return cid The IPFS CID string for the assigned stream (or empty string if none set)
     */
    function getEvidenceForVoter(
        bytes32 eventId,
        address donorVotingModule
    ) external view returns (string memory cid) {
        require(
            donorVotingModule != address(0),
            "EvidenceVault: zero donorVoting address"
        );
        uint8 stream = DonorVoting(donorVotingModule).assignedStream(
            msg.sender
        );
        cid = evidenceCid[eventId][stream];
    }

    /**
     * @notice Check whether evidence exists for event+stream
     */
    function hasEvidence(
        bytes32 eventId,
        uint8 stream
    ) external view returns (bool) {
        return bytes(evidenceCid[eventId][stream]).length > 0;
    }
}
