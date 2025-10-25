// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/*
Keeps a record of all donors that is registered in the system.
Donors can use this to interact with charities and the Astrea System
*/

interface DonorRegistry{
    // I need help to define these functions for the VotingModule.sol /DamienFooxx
    function isRegistered(address donor) external view returns (bool);
}