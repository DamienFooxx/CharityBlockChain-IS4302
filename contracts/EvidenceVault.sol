// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/*
Used by Oracle to store the Evidence that the Charities has uploaded.
Once uploded, cannot be altered.
*/

interface EvidenceVault{
    

    // Should return the evidence to show the Donor/Attestor
    function getEvidence() external view;
}