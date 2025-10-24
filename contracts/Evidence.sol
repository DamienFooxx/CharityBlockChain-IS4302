// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;
/*
Used by Oracle to store the Evidence that the Charities has uploaded.
Once uploded, cannot be altered.
 *     Each CharityEvent requires *three* types of verifiable proofs stored on-chain 
 *     by reference (typically as IPFS/Arweave hashes):
 *        - Receipts Evidence (financial)
 *        - Attendance Evidence (beneficiary verification)
 *        - Photos Evidence (visual confirmation)
 * 
 *     A suggested structure:
 * 
 *     contract EvidenceRegistry {
 *         struct EvidenceSet {
 *             bytes32 receiptsHash;
 *             bytes32 attendanceHash;
 *             bytes32 photosHash;
 *             bool submitted;
 *         }
 * 
 *         mapping(bytes32 => EvidenceSet) public evidenceByEvent;
 * 
 *         event EvidenceSubmitted(bytes32 indexed eventId, bytes32 receipts, bytes32 attendance, bytes32 photos);
 * 
 *         function submitEvidence(
 *             bytes32 eventId, 
 *             bytes32 receipts, 
 *             bytes32 attendance, 
 *             bytes32 photos
 *         ) external {
 *             evidenceByEvent[eventId] = EvidenceSet(receipts, attendance, photos, true);
 *             emit EvidenceSubmitted(eventId, receipts, attendance, photos);
 *         }
 *     }
*/

contract Evidence{
    
}