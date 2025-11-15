// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "./SGDCoin.sol";
import "./Registry.sol";
import "./EscrowVault.sol";
import "./DonorRegistry.sol";
import "./Oracle.sol";
import "./CharityEvent.sol";

/**
 * @title DonorPledges
 * @dev Manages donor pledges/stakes to charity events
 * Handles staking, tracking, and pledge management
 */
contract DonorPledges is Registry {
    // Structs
    struct Pledge {
        uint256 pledgeId;
        address donor;
        bytes32 eventId;
        uint256 amount;
        uint256 timestamp;
        bool isActive;
        bool hasVoted;
    }

    // State variables
    SGDCoin public sgdToken;
    DonorRegistry public donorRegistry;

    uint256 public pledgeCounter;

    // Mappings
    mapping(uint256 => Pledge) public pledges; // pledgeId => Pledge
    mapping(address => uint256[]) public donorPledges; // donor => pledgeIds[]
    mapping(bytes32 => uint256[]) public eventPledges; // eventId => pledgeIds[]
    mapping(address => mapping(bytes32 => uint256)) public donorEventStake; // donor => eventId => total amount
    mapping(bytes32 => uint256) public totalEventPledges; // eventId => total amount

    // Authorized contracts
    mapping(address => bool) public authorizedContracts;

    // Events
    event PledgeCreated(
        uint256 indexed pledgeId,
        address indexed donor,
        bytes32 indexed eventId,
        uint256 amount,
        uint256 timestamp
    );

    event PledgeWithdrawn(
        uint256 indexed pledgeId,
        address indexed donor,
        uint256 amount
    );

    event VotingStatusUpdated(uint256 indexed pledgeId, bool hasVoted);

    event FundsReleased(
        bytes32 indexed eventId,
        address indexed charity,
        uint256 amount
    );

    event ContractAuthorized(address indexed contractAddr, bool authorized);

    // Modifiers
    modifier validPledge(uint256 _pledgeId) {
        require(
            _pledgeId > 0 && _pledgeId <= pledgeCounter,
            "Invalid pledge ID"
        );
        require(pledges[_pledgeId].isActive, "Pledge not active");
        _;
    }

    modifier onlyAuthorized() {
        require(authorizedContracts[msg.sender], "Not authorized contract");
        _;
    }

    /**
     * @dev Constructor
     */
    constructor(
        address _governance,
        address _sgdToken,
        address _donorRegistry
    ) Registry(_governance) {
        require(_sgdToken != address(0), "Invalid token address");
        require(_donorRegistry != address(0), "Invalid donor registry");
        sgdToken = SGDCoin(_sgdToken);
        donorRegistry = DonorRegistry(_donorRegistry);
        pledgeCounter = 0;
    }

    /**
     * @dev Authorize a contract to interact with pledges (e.g., DonorVoting)
     */
    function authorizeContract(
        address _contract,
        bool _authorized
    ) external onlyAdmin {
        require(_contract != address(0), "Invalid contract address");
        authorizedContracts[_contract] = _authorized;
        emit ContractAuthorized(_contract, _authorized);
    }

    /**
     * @dev Create a new pledge to a charity event
     * @param _eventId The ID of the charity event
     * @param _amount Amount of SGD tokens to pledge
     */
    function createPledge(
        bytes32 _eventId,
        uint256 _amount
    ) external whenNotPaused whenSystemNotPaused returns (uint256) {
        // Donor must be registered and verified in DonorRegistry
        require(
            donorRegistry.isDonorRegistered(msg.sender),
            "DonorPledges: Not registered"
        );
        require(
            donorRegistry.isDonorVerified(msg.sender),
            "DonorPledges: Donor not verified"
        );
        require(_eventId != bytes32(0), "Invalid event ID");
        require(_amount > 0, "Amount must be greater than 0");
        require(
            sgdToken.balanceOf(msg.sender) >= _amount,
            "Insufficient balance"
        );
        require(
            sgdToken.allowance(msg.sender, address(this)) >= _amount,
            "Insufficient allowance"
        );
        // Transfer tokens from donor to the global EscrowVault
        address escrowAddr = governance.getContractAddress("EscrowVault");
        require(escrowAddr != address(0), "Escrow not set");
        require(
            sgdToken.transferFrom(msg.sender, escrowAddr, _amount),
            "Transfer failed"
        );

        // Create pledge
        pledgeCounter++;
        pledges[pledgeCounter] = Pledge({
            pledgeId: pledgeCounter,
            donor: msg.sender,
            eventId: _eventId,
            amount: _amount,
            timestamp: block.timestamp,
            isActive: true,
            hasVoted: false
        });

        // Update mappings
        donorPledges[msg.sender].push(pledgeCounter);
        eventPledges[_eventId].push(pledgeCounter);
        donorEventStake[msg.sender][_eventId] += _amount;
        totalEventPledges[_eventId] += _amount;

        // Record deposit in escrow vault
        EscrowVault(escrowAddr).depositPledge(
            pledgeCounter,
            msg.sender,
            _eventId,
            _amount
        );

        // Find the CharityEvent contract and notify it of the new funds
        address oracleAddr = governance.getContractAddress("Oracle");

        if (oracleAddr != address(0)) {
            // Get the modules struct from the Oracle
            Oracle oracle = Oracle(oracleAddr);
            (
                address donorVoting,
                address attestorVoting,
                address charityEvent
            ) = oracle.modules(_eventId);

            // Call updateRaised on the CharityEvent contract
            if (charityEvent != address(0)) {
                try CharityEvent(charityEvent).updateRaised(_amount) {
                    // Success
                } catch {
                    // Event not yet registered with Oracle, skip update
                }
            }
        }

        emit PledgeCreated(
            pledgeCounter,
            msg.sender,
            _eventId,
            _amount,
            block.timestamp
        );

        return pledgeCounter;
    }

    /**
     * @dev Withdraw pledge if event is cancelled or failed
     * @param _pledgeId The ID of the pledge to withdraw
     */
    function withdrawPledge(
        uint256 _pledgeId
    ) external whenNotPaused validPledge(_pledgeId) {
        Pledge storage pledge = pledges[_pledgeId];
        require(pledge.donor == msg.sender, "Not pledge owner");

        uint256 amount = pledge.amount;
        bytes32 eventId = pledge.eventId;
        // Mark pledge inactive locally first to prevent re-entrancy-style issues
        pledge.isActive = false;

        // Update mappings
        donorEventStake[msg.sender][eventId] -= amount;
        totalEventPledges[eventId] -= amount;

        // Ask EscrowVault to refund the pledge (tokens are held in global escrow)
        address escrowAddr = governance.getContractAddress("EscrowVault");
        require(escrowAddr != address(0), "Escrow not set");
        EscrowVault(escrowAddr).refundPledge(_pledgeId, msg.sender);

        emit PledgeWithdrawn(_pledgeId, msg.sender, amount);
    }

    /**
     * @dev Mark pledge as voted (called by authorized contracts like DonorVoting)
     * @param _pledgeId The ID of the pledge
     */
    function markAsVoted(
        uint256 _pledgeId
    ) external onlyAuthorized validPledge(_pledgeId) {
        pledges[_pledgeId].hasVoted = true;
        emit VotingStatusUpdated(_pledgeId, true);
    }

    /**
     * @dev Get donor's pledge IDs for a specific event
     * @param _donor Address of the donor
     * @param _eventId ID of the event
     */
    function getDonorEventPledgeIds(
        address _donor,
        bytes32 _eventId
    ) external view returns (uint256[] memory) {
        uint256[] memory allPledges = donorPledges[_donor];
        uint256 count = 0;

        // Count matching pledges
        for (uint256 i = 0; i < allPledges.length; i++) {
            if (
                pledges[allPledges[i]].eventId == _eventId &&
                pledges[allPledges[i]].isActive
            ) {
                count++;
            }
        }

        // Create result array
        uint256[] memory eventPledgeIds = new uint256[](count);
        uint256 index = 0;

        for (uint256 i = 0; i < allPledges.length; i++) {
            if (
                pledges[allPledges[i]].eventId == _eventId &&
                pledges[allPledges[i]].isActive
            ) {
                eventPledgeIds[index] = allPledges[i];
                index++;
            }
        }

        return eventPledgeIds;
    }

    /**
     * @dev Get total active pledges for an event
     * @param _eventId ID of the event
     */
    function getEventTotalPledges(
        bytes32 _eventId
    ) external view returns (uint256) {
        return totalEventPledges[_eventId];
    }

    /**
     * @dev Get donor's total stake in an event
     * @param _donor Address of the donor
     * @param _eventId ID of the event
     */
    function getDonorStakeInEvent(
        address _donor,
        bytes32 _eventId
    ) external view returns (uint256) {
        return donorEventStake[_donor][_eventId];
    }

    /**
     * @dev Get all pledge IDs made by a donor
     * @param _donor Address of the donor
     */
    function getDonorAllPledges(
        address _donor
    ) external view returns (uint256[] memory) {
        return donorPledges[_donor];
    }

    /**
     * @dev Get pledge details
     * @param _pledgeId ID of the pledge
     */
    function getPledgeDetails(
        uint256 _pledgeId
    )
        external
        view
        returns (
            address donor,
            bytes32 eventId,
            uint256 amount,
            uint256 timestamp,
            bool isActive,
            bool hasVoted
        )
    {
        Pledge memory pledge = pledges[_pledgeId];
        return (
            pledge.donor,
            pledge.eventId,
            pledge.amount,
            pledge.timestamp,
            pledge.isActive,
            pledge.hasVoted
        );
    }

    /**
     * @dev Release pledged funds to charity (called after successful voting)
     * @param _eventId ID of the event
     * @param _charityAddress Address of the charity
     */
    // function releaseFunds(bytes32 _eventId, address _charityAddress)
    //     external
    //     onlyAuthorized
    //     whenNotPaused
    //     returns (uint256)
    // {
    //     require(_charityAddress != address(0), "Invalid charity address");
    //     // Delegate the actual token transfer to the EscrowVault (global bank)
    //     address escrowAddr = governance.getContractAddress("EscrowVault");
    //     require(escrowAddr != address(0), "Escrow not set");

    //     // Ask escrow to release funds for this event to the charity (onlyOracle or authorized caller allowed in Escrow)
    //     EscrowVault(escrowAddr).releaseIfVerified(_eventId, _charityAddress);

    //     // Locally deactivate pledges and update accounting
    //     uint256[] memory pledgeIds = eventPledges[_eventId];
    //     uint256 totalAmount = 0;
    //     for (uint256 i = 0; i < pledgeIds.length; i++) {
    //         uint256 pid = pledgeIds[i];
    //         if (pledges[pid].isActive) {
    //             uint256 amt = pledges[pid].amount;
    //             totalAmount += amt;
    //             pledges[pid].isActive = false;
    //             // reduce donorEventStake
    //             donorEventStake[pledges[pid].donor][_eventId] -= amt;
    //         }
    //     }

    //     // Update total
    //     totalEventPledges[_eventId] = 0;

    //     emit FundsReleased(_eventId, _charityAddress, totalAmount);
    //     return totalAmount;
    // }

    /**
     * @dev Refund all pledges for a failed event
     * @param _eventId ID of the event
     */
    // function refundEvent(bytes32 _eventId)
    //     external
    //     onlyAuthorized
    //     whenNotPaused
    //     returns (uint256)
    // {
    //     uint256[] memory pledgeIds = eventPledges[_eventId];
    //     uint256 totalRefunded = 0;
    //     address escrowAddr = governance.getContractAddress("EscrowVault");
    //     require(escrowAddr != address(0), "Escrow not set");

    //     for (uint256 i = 0; i < pledgeIds.length; i++) {
    //         Pledge storage pledge = pledges[pledgeIds[i]];

    //         if (pledge.isActive) {
    //             uint256 amount = pledge.amount;
    //             address donor = pledge.donor;

    //             pledge.isActive = false;
    //             donorEventStake[donor][_eventId] -= amount;

    //             // Ask escrow to refund this pledge
    //             EscrowVault(escrowAddr).refundPledge(pledge.pledgeId, donor);
    //             totalRefunded += amount;

    //             emit PledgeWithdrawn(pledge.pledgeId, donor, amount);
    //         }
    //     }

    //     totalEventPledges[_eventId] = 0;

    //     return totalRefunded;
    // }
}
