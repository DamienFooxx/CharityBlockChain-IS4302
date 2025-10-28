// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./AttestorLib.sol";
import "./AttestorStaking.sol";
import "./AttestationManager.sol";

/**
 * @title AttestorRegistry
 * @dev Registry contract for managing attestors (certifiers) in a blockchain-based charity system.
 * Uses AttestorLib for modular reputation and attestation handling.
 * Uses AttestorStaking as single source of truth for stake amounts.
 * Attestors are high-stake participants who verify charity proofs before reimbursements.
 */
contract AttestorRegistry {
    using AttestorLib for AttestorLib.Attestor;

    // -----------STATE VARIABLES-----------

    // Roles
    address public admin; // emergency / owner
    address public governance; // DAO/governance address (multisig/DAO)

    // External Smart Contracts
    AttestorStaking public stakingContract;
    AttestationManager public attestationManager;

    // Attestor storage (reputation and activity only, stake is in AttestorStaking)
    mapping(address => AttestorLib.Attestor) public attestors;
    mapping(address => bool) public isRegistered;

    // Parameters
    uint256 public minReputation = 50;
    uint256 public maxReputation = 1000;
    uint256 public slashPenalty = 0.5 ether; // Default penalty for slashing
    uint256 public rewardAmount = 0.1 ether; // Default reward for correct attestation

    // Reward pool funded by slashed stakes
    uint256 public rewardPool;

    // -----------EVENTS-----------

    event AttestorRegistered(address indexed attestor, uint256 stake);
    event AttestorDeactivated(address indexed attestor, string reason);
    event AttestorReactivated(address indexed attestor);
    event AttestationSubmitted(
        address indexed attestor,
        uint256 indexed eventId,
        bool result
    );
    event ConsensusFinalized(uint256 indexed eventId, bool approved);
    event AttestorSlashed(
        address indexed attestor,
        uint256 amount,
        string reason
    );
    event AttestorRewarded(address indexed attestor, uint256 reward);
    event ParametersUpdated(
        uint256 minReputation,
        uint256 slashPenalty,
        uint256 rewardAmount
    );
    event AdminTransferred(address newAdmin);
    event GovernanceSet(address indexed newGovernance);
    event RewardPoolFunded(uint256 amount);

    // -----------MODIFIERS-----------

    modifier onlyAdmin() {
        require(msg.sender == admin, "Not authorized");
        _;
    }

    modifier onlyGovernance() {
        require(msg.sender == governance, "Not governance");
        _;
    }

    modifier onlyAdminOrGovernance() {
        require(
            msg.sender == admin || msg.sender == governance,
            "Not authorized"
        );
        _;
    }

    modifier onlyActiveAttestor() {
        require(isRegistered[msg.sender], "Not registered");
        require(attestors[msg.sender].isActive, "Not active attestor");
        require(
            attestors[msg.sender].reputation >= minReputation,
            "Reputation too low"
        );
        _;
        require(
            stakingContract.getStake(msg.sender) >= stakingContract.minStake(),
            "Stake below minimum"
        );
        _;
    }

    // -----------CONSTRUCTOR-----------

    constructor(
        address _staking,
        address _attestationManager,
        address _governance
    ) {
        require(_staking != address(0), "Invalid staking address");
        require(
            _attestationManager != address(0),
            "Invalid attestationManager address"
        );

        admin = msg.sender;
        governance = _governance;
        stakingContract = AttestorStaking(payable(_staking));
        attestationManager = AttestationManager(_attestationManager);
    }

    // -----------REGISTRATION LOGIC-----------

    /**
     * @dev Register as an attestor by staking ETH.
     */
    function registerAsAttestor() external payable {
        require(!isRegistered[msg.sender], "Already registered");
        require(msg.value >= stakingContract.minStake(), "Insufficient stake");

        // Stake tokens via AttestorStaking contract
        (bool sent, ) = address(stakingContract).call{value: msg.value}(
            abi.encodeWithSignature("stake()")
        );
        require(sent, "Stake failed");

        // Initialize attestor profile using AttestorLib (no stake stored here)
        AttestorLib.Attestor storage newAttestor = attestors[msg.sender];
        newAttestor.initialize(msg.sender);
        isRegistered[msg.sender] = true;

        emit AttestorRegistered(msg.sender, msg.value);
    }

    /**
     * @dev Add more stake to existing registration (allows recovery after slashing)
     */
    function addStake() external payable {
        require(isRegistered[msg.sender], "Not registered");
        require(msg.value > 0, "Must stake non-zero amount");

        // Forward to staking contract
        (bool sent, ) = address(stakingContract).call{value: msg.value}("");
        require(sent, "Stake failed");

        stakingContract.stake(msg.sender); // This will be called by the forwarded function

        // If was inactive due to low stake, check if can reactivate
        if (!attestors[msg.sender].isActive) {
            uint256 currentStake = stakingContract.getStake(msg.sender);
            if (
                currentStake >= stakingContract.minStake() &&
                attestors[msg.sender].reputation >= minReputation
            ) {
                attestors[msg.sender].activate();
                emit AttestorReactivated(msg.sender);
            }
        }
    }

    /**
     * @dev Deactivate attestor (admin/governance only).
     */
    function deactivateAttestor(
        address _attestor,
        string calldata reason
    ) external onlyAdminOrGovernance {
        require(isRegistered[_attestor], "Not registered");
        attestors[_attestor].deactivate();
        emit AttestorDeactivated(_attestor, reason);
    }

    /**
     * @dev Reactivate attestor after meeting requirements.
     */
    function reactivateAttestor(
        address _attestor
    ) external onlyAdminOrGovernance {
        require(isRegistered[_attestor], "Not registered");
        require(!attestors[_attestor].isActive, "Already active");
        require(
            stakingContract.getStake(_attestor) >= stakingContract.minStake(),
            "Insufficient stake"
        );

        attestors[_attestor].activate();
        emit AttestorReactivated(_attestor);
    }

    /**
     * @dev Allows attestor to request withdrawal through staking contract.
     */
    function requestWithdrawal() external {
        require(isRegistered[msg.sender], "Not registered");
        // Deactivate before withdrawal
        if (attestors[msg.sender].isActive) {
            attestors[msg.sender].deactivate();
        }
        stakingContract.requestWithdrawal();
    }

    // -----------ATTESTATION LOGIC-----------

    /**
     * @dev Attestor submits verification result for a charity event.
     * @param eventId ID of the charity event
     * @param result Boolean indicating approval (true) or disapproval (false)
     * @param metadataURI Optional off-chain verification reference
     */
    function submitAttestation(
        uint256 eventId,
        bool result,
        string calldata metadataURI
    ) external onlyActiveAttestor {
        // Check if already attested
        require(
            !attestationManager.hasAttestorAttested(eventId, msg.sender),
            "Already attested to this event"
        );

        // Record attestation through manager
        attestationManager.recordAttestation(
            eventId,
            msg.sender,
            result,
            metadataURI
        );

        emit AttestationSubmitted(msg.sender, eventId, result);
    }

    /**
     * @dev Retrieve all attestations for an event.
     */
    function getEventAttestations(
        uint256 eventId
    ) external view returns (AttestorLib.Attestation[] memory) {
        return attestationManager.getEventAttestations(eventId);
    }

    /**
     * @dev Finalize consensus for an event after attestation phase.
     * Rewards correct attestors and slashes incorrect ones.
     */
    function finalizeEventConsensus(
        uint256 eventId
    ) external onlyAdminOrGovernance returns (bool) {
        bool approved = attestationManager.finalizeConsensus(eventId);

        // Get all attestations
        AttestorLib.Attestation[] memory attestationList = attestationManager
            .getEventAttestations(eventId);

        // Batch data for slashing and rewarding
        address[] memory toSlash = new address[](attestationList.length);
        address[] memory toReward = new address[](attestationList.length);
        uint256 slashCount = 0;
        uint256 rewardCount = 0;

        // Categorize attestors
        for (uint256 i = 0; i < attestationList.length; i++) {
            address attestor = attestationList[i].attestor;
            bool attestorResult = attestationList[i].result;

            if (attestorResult == approved) {
                toReward[rewardCount++] = attestor;
            } else {
                toSlash[slashCount++] = attestor;
            }
        }

        // Batch process slashing
        if (slashCount > 0) {
            for (uint256 i = 0; i < slashCount; i++) {
                _slashAttestor(
                    toSlash[i],
                    slashPenalty,
                    "Incorrect attestation"
                );
                attestors[toSlash[i]].recordAttestation(false);
            }
        }

        // Batch process rewards
        if (rewardCount > 0) {
            for (uint256 i = 0; i < rewardCount; i++) {
                _rewardAttestor(toReward[i]);
                attestors[toReward[i]].recordAttestation(true);
            }
        }

        emit ConsensusFinalized(eventId, approved);
        return approved;
    }

    // -----------SLASHING & REWARD (INTERNAL)-----------

    /**
     * @dev Internal function to slash an attestor.
     */
    function _slashAttestor(
        address attestor,
        uint256 penalty,
        string memory reason
    ) internal {
        uint256 actualPenalty = stakingContract.slash(attestor, penalty);
        attestors[attestor].decreaseReputation(30);

        // Add slashed amount to reward pool
        rewardPool += actualPenalty;

        emit AttestorSlashed(attestor, actualPenalty, reason);
    }

    /**
     * @dev Internal function to reward an attestor.
     */
    function _rewardAttestor(address attestor) internal {
        attestors[attestor].increaseReputation(15);

        // Pay reward from pool if available
        if (rewardPool >= rewardAmount) {
            rewardPool -= rewardAmount;
            // Transfer ETH from this contract to staking contract
            (bool sent, ) = address(stakingContract).call{value: rewardAmount}(
                ""
            );
            require(sent, "Reward transfer failed");
            stakingContract.addStakeReward(attestor, rewardAmount);
            emit AttestorRewarded(attestor, rewardAmount);
        }
    }

    /**
     * @dev Manual slash by admin for extreme cases.
     */
    function manualSlash(
        address attestor,
        uint256 penalty,
        string calldata reason
    ) external onlyAdminOrGovernance {
        require(isRegistered[attestor], "Not registered");
        _slashAttestor(attestor, penalty, reason);
    }

    /**
     * @dev Fund the reward pool with ETH.
     */
    function fundRewardPool() external payable {
        require(msg.value > 0, "Must send ETH");
        rewardPool += msg.value;
        // Keep ETH in this contract, don't forward
        emit RewardPoolFunded(msg.value);
    }

    // -----------GOVERNANCE-----------

    function updateParameters(
        uint256 _minReputation,
        uint256 _maxReputation, // ADD this parameter
        uint256 _slashPenalty,
        uint256 _rewardAmount
    ) external onlyAdminOrGovernance {
        require(_minReputation <= _maxReputation, "Invalid reputation range");
        minReputation = _minReputation;
        maxReputation = _maxReputation; // ADD this line
        slashPenalty = _slashPenalty;
        rewardAmount = _rewardAmount;
        emit ParametersUpdated(_minReputation, _slashPenalty, _rewardAmount);
    }

    function setGovernance(address _governance) external onlyAdmin {
        require(_governance != address(0), "Invalid address");
        governance = _governance;
        emit GovernanceSet(_governance);
    }

    function transferAdmin(address newAdmin) external onlyAdmin {
        require(newAdmin != address(0), "Invalid address");
        admin = newAdmin;
        emit AdminTransferred(newAdmin);
    }

    function updateStakingContract(address newStaking) external onlyAdmin {
        require(newStaking != address(0), "Invalid address");
        stakingContract = AttestorStaking(payable(newStaking));
    }

    function updateAttestationManager(address newManager) external onlyAdmin {
        require(newManager != address(0), "Invalid address");
        attestationManager = AttestationManager(newManager);
    }

    // -----------VIEW HELPERS-----------

    function getAttestor(
        address _attestor
    )
        external
        view
        returns (
            address attestorAddress,
            bool isActive,
            uint256 reputation,
            uint256 lastAttestation,
            uint256 totalAttestations,
            uint256 successfulAttestations,
            uint256 stake
        )
    {
        AttestorLib.Attestor memory attestor = attestors[_attestor];
        uint256 cappedReputation = attestor.reputation > maxReputation
            ? maxReputation
            : attestor.reputation;

        return (
            attestor.attestorAddress,
            attestor.isActive,
            cappedReputation, // Return capped value
            attestor.lastAttestation,
            attestor.totalAttestations,
            attestor.successfulAttestations,
            stakingContract.getStake(_attestor)
        );
    }

    function getReputation(address _attestor) external view returns (uint256) {
        return attestors[_attestor].getReputation();
    }

    function getAccuracy(address _attestor) external view returns (uint256) {
        return attestors[_attestor].getAccuracy();
    }

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
        return attestationManager.getConsensusStatus(eventId);
    }

    receive() external payable {
        // Accept ETH for reward pool
        rewardPool += msg.value;
        emit RewardPoolFunded(msg.value);
    }
}
