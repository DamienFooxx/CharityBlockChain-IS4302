// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title AttestorLib
 * @dev Library for managing Attestor data and behavior within the charity verification ecosystem.
 * This library provides reusable helper functions to handle reputation and attestation tracking
 * in a gas-efficient and modular way.
 * Note: Stake management is handled by AttestorStaking contract to avoid double accounting.
 */

library AttestorLib {
    /// @notice Struct representing an attestor (certifier) in the system.
    struct Attestor {
        address attestorAddress; // Attestor's wallet or smart contract address
        bool isActive; // Whether this attestor is currently authorized
        uint256 reputation; // Reputation score (used for weighting decisions)
        uint256 lastAttestation; // Timestamp of last attestation submission
        uint256 totalAttestations; // Count of all attestations made
        uint256 successfulAttestations; // Number of successful/approved attestations
    }

    /// @notice Struct for recording a specific attestation submission
    struct Attestation {
        uint256 eventId; // Charity event being attested
        address attestor; // Attestor submitting the proof
        bool result; // Verification result (true = valid proof)
        string metadataURI; // Optional link to off-chain verification evidence
        uint256 timestamp; // When attestation occurred
    }

    // -----------ATTESTOR LIFECYCLE MANAGEMENT-----------

    /**
     * @dev Initializes a new attestor.
     * @param _self Reference to storage mapping or struct
     * @param _addr Address of the new attestor
     */
    function initialize(Attestor storage _self, address _addr) internal {
        _self.attestorAddress = _addr;
        _self.isActive = true;
        _self.reputation = 100; // start with a neutral reputation
        _self.lastAttestation = block.timestamp;
        _self.totalAttestations = 0;
        _self.successfulAttestations = 0;
    }

    /**
     * @dev Deactivates an attestor, used if slashed or voluntarily withdrawing.
     */
    function deactivate(Attestor storage _self) internal {
        _self.isActive = false;
    }

    /**
     * @dev Reactivates an attestor.
     */
    function activate(Attestor storage _self) internal {
        _self.isActive = true;
    }

    // -----------REPUTATION MANAGEMENT-----------

    /**
     * @dev Increases the reputation score of the attestor.
     */
    function increaseReputation(
        Attestor storage _self,
        uint256 _amount
    ) internal {
        _self.reputation += _amount;
        if (_self.reputation > 1000) {
            _self.reputation = 1000; // Cap reputation
        }
    }

    /**
     * @dev Decreases the reputation score of the attestor.
     */
    function decreaseReputation(
        Attestor storage _self,
        uint256 _amount
    ) internal {
        if (_self.reputation > _amount) {
            _self.reputation -= _amount;
        } else {
            _self.reputation = 0;
        }
    }

    /**
     * @dev Returns the reputation score of the attestor.
     */
    function getReputation(
        Attestor storage _self
    ) internal view returns (uint256) {
        return _self.reputation;
    }

    /**
     * @dev Cap reputation at maximum value
     */
    function capReputation(
        Attestor storage _self
    ) internal view returns (uint256) {
        return _self.reputation > 1000 ? 1000 : _self.reputation;
    }

    // -----------ATTESTATION ACTIVITY TRACKING-----------

    /**
     * @dev Records a new attestation activity.
     */
    function recordAttestation(
        Attestor storage _self,
        bool successful
    ) internal {
        _self.totalAttestations++;
        if (successful) {
            _self.successfulAttestations++;
            increaseReputation(_self, 10);
        } else {
            decreaseReputation(_self, 20);
        }
        _self.lastAttestation = block.timestamp;
    }

    /**
     * @dev Computes attestor accuracy as a percentage (0–100).
     */
    function getAccuracy(
        Attestor storage _self
    ) internal view returns (uint256) {
        if (_self.totalAttestations == 0) return 0;
        return (_self.successfulAttestations * 100) / _self.totalAttestations;
    }
}
