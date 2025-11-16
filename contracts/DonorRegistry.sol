// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "./Registry.sol";

/**
 * @title DonorRegistry
 * @dev Manages donor registration and verification
 * Keeps a record of all donors registered in the system
 * Donors use this to interact with charities and the Astraea System
 */
contract DonorRegistry is Registry {
    // Donor profile structure
    struct DonorProfile {
        address donorAddress;
        string name;
        string metaCID; // IPFS content identifier for metadata
        bool isDonorRegistered; // user signs up on the platform, but does not have acess to any functions without a verificatoin
        bool isDonorVerified; // KYC verification status
        uint256 registrationTime;
    }

    // Mappings
    mapping(address => DonorProfile) public profiles;
    mapping(address => bool) public registered;

    // Statistics
    uint256 public totalDonors;
    uint256 public verifiedDonors;

    // Events
    event DonorRegistered(
        address indexed donor,
        string name,
        uint256 timestamp
    );
    event DonorVerified(address indexed donor, bool verified);
    event ProfileUpdated(address indexed donor, string metaCID);

    // Modifiers
    modifier onlyOracle() {
        require(
            governance.hasRole(governance.ORACLE_ROLE(), msg.sender),
            "Not oracle"
        );
        _;
    }

    modifier notRegistered() {
        require(!registered[msg.sender], "Already registered");
        _;
    }

    modifier onlyRegisteredDonor() {
        require(registered[msg.sender], "Not registered");
        _;
    }

    /**
     * @dev Constructor
     */
    constructor(address _governance) Registry(_governance) {
        totalDonors = 0;
        verifiedDonors = 0;
    }

    /**
     * @dev Register as a new donor
     * @param _name Donor's name
     * @param _metaCID IPFS content identifier for donor metadata
     */
    function registerDonor(
        string calldata _name,
        string calldata _metaCID
    ) external notRegistered whenNotPaused whenSystemNotPaused returns (bool) {
        require(bytes(_name).length > 0, "Name cannot be empty");
        require(bytes(_metaCID).length > 0, "MetaCID cannot be empty");

        profiles[msg.sender] = DonorProfile({
            donorAddress: msg.sender,
            name: _name,
            metaCID: _metaCID,
            isDonorRegistered: true,
            isDonorVerified: false,
            registrationTime: block.timestamp
        });

        registered[msg.sender] = true;
        totalDonors++;

        emit DonorRegistered(msg.sender, _name, block.timestamp);

        return true;
    }

    /**
     * @dev Update donor profile metadata
     * @param _metaCID New IPFS content identifier for metadata
     */
    function updateProfile(
        string calldata _metaCID
    ) external onlyRegisteredDonor whenNotPaused whenSystemNotPaused {
        require(bytes(_metaCID).length > 0, "MetaCID cannot be empty");

        profiles[msg.sender].metaCID = _metaCID;

        emit ProfileUpdated(msg.sender, _metaCID);
    }

    /**
     * @dev Verify a donor (KYC process - called by oracle or admin)
     * @param _donor Address of the donor
     * @param _verified Verification status
     */
    function setVerification(
        address _donor,
        bool _verified
    ) external onlyAdmin whenNotPaused whenSystemNotPaused {
        require(registered[_donor], "Donor not registered");

        bool wasVerified = profiles[_donor].isDonorVerified;
        profiles[_donor].isDonorVerified = _verified;

        if (_verified && !wasVerified) {
            verifiedDonors++;
        } else if (!_verified && wasVerified) {
            verifiedDonors--;
        }

        emit DonorVerified(_donor, _verified);
    }

    /**
     * @dev Check if a donor is registered
     * @param donor Address of the donor
     * @return Whether the donor is registered
     */
    function isDonorRegistered(address donor) external view returns (bool) {
        return registered[donor];
    }

    /**
     * @dev Check if a donor is verified
     * @param _donor Address of the donor
     * @return Whether the donor is verified
     */
    function isDonorVerified(address _donor) external view returns (bool) {
        return profiles[_donor].isDonorVerified;
    }

    /**
     * @dev Get donor profile
     * @param _donor Address of the donor
     */
    function getProfile(
        address _donor
    )
        external
        view
        returns (
            address donorAddress,
            string memory name,
            string memory metaCID,
            uint256 registrationTime
        )
    {
        DonorProfile memory profile = profiles[_donor];
        return (
            profile.donorAddress,
            profile.name,
            profile.metaCID,
            profile.registrationTime
        );
    }

    /**
     * @dev Get donor statistics
     */
    function getStats()
        external
        view
        returns (uint256 total, uint256 verified)
    {
        return (totalDonors, verifiedDonors);
    }
}
