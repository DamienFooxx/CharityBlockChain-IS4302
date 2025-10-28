// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./AttestorLib.sol";
import "./AttestorRegistry.sol";

interface IAttestorRegistry {
    function getReputation(address attestor) external view returns (uint256);
}

/**
 * @title AttestationManager
 * @dev Collects and finalizes attestations for charity events.
 * Works alongside AttestorRegistry and CharityEvents.
 */

contract AttestationManager {
    using AttestorLib for AttestorLib.Attestation;

    address public admin;
    address public registry; // Address of AttestorRegistry
    address public charityEvents; // Address of CharityEvents contract

    // eventId → list of attestations
    mapping(uint256 => AttestorLib.Attestation[]) private attestations;

    // eventId → attestor → has attested
    mapping(uint256 => mapping(address => bool)) private hasAttested;

    // eventId → is finalized
    mapping(uint256 => bool) private finalized;

    // eventId → minimum attestors required
    mapping(uint256 => uint256) public minAttestorsRequired;

    // eventId → attestation deadline
    mapping(uint256 => uint256) public attestationDeadlines;

    // Default parameters
    uint256 public defaultMinAttestors = 5;
    uint256 public defaultAttestationWindow = 7 days;

    event AttestationAdded(
        address indexed attestor,
        uint256 indexed eventId,
        bool result
    );
    event ConsensusFinalized(
        uint256 indexed eventId,
        bool approved,
        uint256 approvals,
        uint256 total
    );
    event AdminTransferred(address newAdmin);
    event RegistryUpdated(address newRegistry);
    event CharityEventsUpdated(address newCharityEvents);
    event AttestationWindowOpened(
        uint256 indexed eventId,
        uint256 deadline,
        uint256 minAttestors
    );
    event DefaultParametersUpdated(
        uint256 minAttestors,
        uint256 attestationWindow
    );

    modifier onlyAdmin() {
        require(msg.sender == admin, "Not admin");
        _;
    }

    modifier onlyRegistry() {
        require(msg.sender == registry, "Only registry");
        _;
    }

    modifier onlyCharityEvents() {
        require(msg.sender == charityEvents, "Only charity events");
        _;
    }

    constructor() {
        admin = msg.sender;
    }

    // -----------CORE ATTESTATION LOGIC-----------

    /**
     * @dev Open attestation window for an event (called by CharityEvents).
     * @param eventId The ID of the charity event
     * @param customMinAttestors Minimum attestors required (0 = use default)
     * @param customWindow Attestation window duration in seconds (0 = use default)
     */
    function openAttestationWindow(
        uint256 eventId,
        uint256 customMinAttestors,
        uint256 customWindow
    ) external onlyCharityEvents {
        require(!finalized[eventId], "Event already finalized");
        require(attestationDeadlines[eventId] == 0, "Window already opened");

        uint256 minAttestors = customMinAttestors > 0
            ? customMinAttestors
            : defaultMinAttestors;
        uint256 window = customWindow > 0
            ? customWindow
            : defaultAttestationWindow;

        minAttestorsRequired[eventId] = minAttestors;
        attestationDeadlines[eventId] = block.timestamp + window;

        emit AttestationWindowOpened(
            eventId,
            attestationDeadlines[eventId],
            minAttestors
        );
    }

    /**
     * @dev Called by AttestorRegistry when an attestor submits a result.
     * @param eventId The ID of the charity event
     * @param attestor Address of the attestor
     * @param result Verification result (true = approved, false = rejected)
     * @param metadataURI Optional URI pointing to off-chain verification data
     */
    function recordAttestation(
        uint256 eventId,
        address attestor,
        bool result,
        string calldata metadataURI
    ) external onlyRegistry {
        require(
            attestationDeadlines[eventId] > 0,
            "Attestation window not opened"
        );
        require(
            block.timestamp <= attestationDeadlines[eventId],
            "Attestation window closed"
        );
        require(!hasAttested[eventId][attestor], "Already attested");
        require(!finalized[eventId], "Event already finalized");

        attestations[eventId].push(
            AttestorLib.Attestation({
                eventId: eventId,
                attestor: attestor,
                result: result,
                metadataURI: metadataURI,
                timestamp: block.timestamp
            })
        );

        hasAttested[eventId][attestor] = true;
        emit AttestationAdded(attestor, eventId, result);
    }

    /*
     * @dev Compute consensus on event results with reputation weighting.
     * Returns true if weighted super-majority approved (>66%).
     */
    function finalizeConsensus(
        uint256 eventId
    ) external onlyRegistry returns (bool approved) {
        require(!finalized[eventId], "Already finalized");
        AttestorLib.Attestation[] storage list = attestations[eventId];

        uint256 minRequired = minAttestorsRequired[eventId] > 0
            ? minAttestorsRequired[eventId]
            : defaultMinAttestors;

        require(list.length >= minRequired, "Insufficient attestations");

        // Get reputation-weighted votes
        uint256 totalWeight;
        uint256 approvalWeight;

        for (uint256 i = 0; i < list.length; i++) {
            // Query reputation from registry (need to add interface)
            uint256 reputation = IAttestorRegistry(registry).getReputation(
                list[i].attestor
            );
            totalWeight += reputation;

            if (list[i].result) {
                approvalWeight += reputation;
            }
        }

        // Require weighted super-majority (>66%) for approval
        approved = (approvalWeight * 3 > totalWeight * 2);
        finalized[eventId] = true;

        emit ConsensusFinalized(eventId, approved, approvalWeight, totalWeight);
        return approved;
    }

    // -----------VIEW FUNCTIONS-----------

    /**
     * @dev View all attestations for a charity event.
     * @param eventId The ID of the charity event
     * @return Array of all attestations for the event
     */
    function getEventAttestations(
        uint256 eventId
    ) external view returns (AttestorLib.Attestation[] memory) {
        return attestations[eventId];
    }

    /**
     * @dev Check if attestor has already attested to an event.
     * @param eventId The ID of the charity event
     * @param attestor Address of the attestor to check
     * @return true if attestor has already submitted attestation
     */
    function hasAttestorAttested(
        uint256 eventId,
        address attestor
    ) external view returns (bool) {
        return hasAttested[eventId][attestor];
    }

    /**
     * @dev Check if event is finalized.
     * @param eventId The ID of the charity event
     * @return true if consensus has been finalized
     */
    function isFinalized(uint256 eventId) external view returns (bool) {
        return finalized[eventId];
    }

    /**
     * @dev Get current consensus status without finalizing.
     * @param eventId The ID of the charity event
     * @return approvals Number of attestors who approved
     * @return total Total number of attestations
     * @return wouldPass Whether the event would pass with current attestations
     * @return canFinalize Whether the event can be finalized now
     */
    function getConsensusStatus(
        uint256 eventId
    )
        external
        view
        returns (
            uint256 approvals,
            uint256 total,
            bool wouldPass,
            bool canFinalize
        )
    {
        AttestorLib.Attestation[] storage list = attestations[eventId];
        total = list.length;

        for (uint256 i = 0; i < list.length; i++) {
            if (list[i].result) approvals++;
        }

        wouldPass = (approvals * 3 > total * 2);

        uint256 minRequired = minAttestorsRequired[eventId] > 0
            ? minAttestorsRequired[eventId]
            : defaultMinAttestors;

        canFinalize = total >= minRequired && !finalized[eventId];
    }

    /**
     * @dev Get attestation window details for an event.
     * @param eventId The ID of the charity event
     * @return deadline Timestamp when attestation window closes
     * @return minAttestors Minimum attestors required
     * @return isOpen Whether the window is currently open
     * @return isExpired Whether the deadline has passed
     */
    function getAttestationWindow(
        uint256 eventId
    )
        external
        view
        returns (
            uint256 deadline,
            uint256 minAttestors,
            bool isOpen,
            bool isExpired
        )
    {
        deadline = attestationDeadlines[eventId];
        minAttestors = minAttestorsRequired[eventId] > 0
            ? minAttestorsRequired[eventId]
            : defaultMinAttestors;
        isOpen = deadline > 0 && !finalized[eventId];
        isExpired = deadline > 0 && block.timestamp > deadline;
    }

    /**
     * @dev Get the total number of attestations for an event.
     * @param eventId The ID of the charity event
     * @return count Number of attestations submitted
     */
    function getAttestationCount(
        uint256 eventId
    ) external view returns (uint256 count) {
        return attestations[eventId].length;
    }

    // -----------ADMIN FUNCTIONS-----------

    /**
     * @dev Set the CharityEvents contract address.
     * @param _charityEvents Address of the CharityEvents contract
     */
    function setCharityEvents(address _charityEvents) external onlyAdmin {
        require(_charityEvents != address(0), "Invalid address");
        charityEvents = _charityEvents;
        emit CharityEventsUpdated(_charityEvents);
    }

    /**
     * @dev Update the registry contract address.
     * @param _registry Address of the AttestorRegistry contract
     */
    function setRegistry(address _registry) external onlyAdmin {
        require(_registry != address(0), "Invalid address");
        registry = _registry;
        emit RegistryUpdated(_registry);
    }

    /**
     * @dev Update default parameters for attestation windows.
     * @param _minAttestors Default minimum attestors required
     * @param _attestationWindow Default attestation window duration in seconds
     */
    function setDefaultParameters(
        uint256 _minAttestors,
        uint256 _attestationWindow
    ) external onlyAdmin {
        require(_minAttestors >= 1, "Min attestors must be >= 1");
        require(_attestationWindow > 0, "Window must be > 0");
        defaultMinAttestors = _minAttestors;
        defaultAttestationWindow = _attestationWindow;
        emit DefaultParametersUpdated(_minAttestors, _attestationWindow);
    }

    /**
     * @dev Transfer admin rights to a new address.
     * @param newAdmin Address of the new admin
     */
    function transferAdmin(address newAdmin) external onlyAdmin {
        require(newAdmin != address(0), "Invalid address");
        admin = newAdmin;
        emit AdminTransferred(newAdmin);
    }
}
