// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "./Registry.sol";
import "./SGDCoin.sol";

/**
 * @title EscrowVault
 * @dev Central escrow that holds pledged SGD tokens. DonorPledges deposits tokens here.
 * DonorPledges and Oracle (or other authorized contracts) can instruct the vault
 * to refund or release funds. This keeps funds in a single global bank.
 */
contract EscrowVault is Registry {
    SGDCoin public sgdToken;

    // Authorized contracts (e.g., DonorPledges) that can call deposit/refund/release helpers
    mapping(address => bool) public authorizedContracts;

    // Pledge accounting
    mapping(uint256 => uint256) public pledgeAmount; // pledgeId => amount
    mapping(uint256 => address) public pledgeDonor; // pledgeId => donor
    mapping(uint256 => bytes32) public pledgeEvent; // pledgeId => eventId
    mapping(uint256 => bool) public pledgeActive; // pledgeId => active

    // event => list of pledgeIds stored here for release/refund operations
    mapping(bytes32 => uint256[]) public eventPledgeIds;

    // Track which event IDs have been released
    mapping(bytes32 => bool) public released;
    // Track who the funds were released to
    mapping(bytes32 => address) public releaseRecipient;

    // --- Events ---
    event ContractAuthorized(address indexed contractAddr, bool authorized);
    event PledgeDeposited(uint256 indexed pledgeId, bytes32 indexed eventId, address indexed donor, uint256 amount);
    event PledgeRefunded(uint256 indexed pledgeId, address indexed to, uint256 amount);
    event EventReleased(bytes32 indexed eventId, address indexed to, uint256 amount);

    modifier onlyAuthorized() {
        require(authorizedContracts[msg.sender], "EscrowVault: Not authorized");
        _;
    }

    constructor(address _governance, address _sgdToken) Registry(_governance) {
        require(_sgdToken != address(0), "EscrowVault: zero token");
        sgdToken = SGDCoin(_sgdToken);
    }

    function authorizeContract(address _contract, bool _authorized) external onlyAdmin {
        require(_contract != address(0), "EscrowVault: zero addr");
        authorizedContracts[_contract] = _authorized;
        emit ContractAuthorized(_contract, _authorized);
    }

    /**
     * @notice Record a pledge deposit. The ERC20 tokens should already have been transferred
     * to this contract via transferFrom in the caller before calling this method.
     */
    function depositPledge(uint256 _pledgeId, address _donor, bytes32 _eventId, uint256 _amount) external onlyAuthorized whenNotPaused {
        require(_pledgeId > 0, "EscrowVault: bad pledgeId");
        require(_donor != address(0), "EscrowVault: zero donor");
        require(_eventId != bytes32(0), "EscrowVault: zero eventId");
        require(_amount > 0, "EscrowVault: zero amount");
        require(pledgeAmount[_pledgeId] == 0, "EscrowVault: pledge exists");

        pledgeAmount[_pledgeId] = _amount;
        pledgeDonor[_pledgeId] = _donor;
        pledgeEvent[_pledgeId] = _eventId;
        pledgeActive[_pledgeId] = true;
        eventPledgeIds[_eventId].push(_pledgeId);

        emit PledgeDeposited(_pledgeId, _eventId, _donor, _amount);
    }

    /**
     * @notice Refund a single pledge back to the donor. Callable by authorized contracts
     * (e.g., DonorPledges) when a pledge is withdrawn or an event is refunded.
     */
    function refundPledge(uint256 _pledgeId, address _to) external onlyAuthorized whenNotPaused returns (uint256) {
        require(_to != address(0), "EscrowVault: zero to");
        require(pledgeActive[_pledgeId], "EscrowVault: pledge inactive");

        uint256 amt = pledgeAmount[_pledgeId];
        require(amt > 0, "EscrowVault: zero amt");

        pledgeActive[_pledgeId] = false;
        pledgeAmount[_pledgeId] = 0;

        require(sgdToken.transfer(_to, amt), "EscrowVault: transfer failed");
        emit PledgeRefunded(_pledgeId, _to, amt);
        return amt;
    }

    /**
     * @notice Release all active pledges for an event to the beneficiary. Callable by Oracle (via governance role)
     * or by authorized contracts.
     */
    function releaseIfVerified(bytes32 eventId, address to) external whenNotPaused {
        // allow Oracle role OR authorized contracts to call
        if (!authorizedContracts[msg.sender]) {
            require(governance.hasRole(governance.ORACLE_ROLE(), msg.sender), "EscrowVault: not oracle");
        }

        require(eventId != bytes32(0), "EscrowVault: zero eventId");
        require(to != address(0), "EscrowVault: zero to");
        require(!released[eventId], "EscrowVault: already released");

        uint256 total = 0;
        uint256[] storage pids = eventPledgeIds[eventId];
        for (uint256 i = 0; i < pids.length; i++) {
            uint256 pid = pids[i];
            if (pledgeActive[pid]) {
                uint256 amt = pledgeAmount[pid];
                if (amt > 0) {
                    total += amt;
                    pledgeActive[pid] = false;
                    pledgeAmount[pid] = 0;
                }
            }
        }

        require(total > 0, "EscrowVault: no funds");
        released[eventId] = true;
        releaseRecipient[eventId] = to;

        require(sgdToken.transfer(to, total), "EscrowVault: transfer failed");
        emit EventReleased(eventId, to, total);
    }
}