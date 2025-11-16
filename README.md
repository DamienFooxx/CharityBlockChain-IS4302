# Charity Staking Platform (IS4302)

This project, created for the NUS course IS4302: Blockchain and Distributed Ledger Technologies, is a comprehensive Charity Staking Platform. [cite_start]It is designed to solve significant challenges in the traditional charity sector, specifically the lack of transparency, accountability, and trust[cite: 15, 16, 17].

[cite_start]This platform enables donors to stake SGD-pegged stablecoins (SGDCoin) into a smart contract-based escrow[cite: 23, 51]. [cite_start]These funds are only released to the charity after a community of donors and a secondary layer of attestors vote to confirm that the charity has successfully provided evidence of completing its goals[cite: 24, 128].

## Project Goals and Purpose

[cite_start]The platform's primary goal is to create a transparent, automated, and community-driven system for charity donations[cite: 20, 28].

[cite_start]The core purpose is to empower donors by giving them the ability to vote on whether a charity's event was successful before funds are released[cite: 29]. [cite_start]This entire process is managed by smart contracts, ensuring all transactions are verifiable and tamper-proof[cite: 25, 28]. [cite_start]The system also integrates a decentralized oracle to manage the process [cite: 30] [cite_start]and a reputation system to assess charity transparency over time[cite: 32].

## Core Ideologies and Design Principles

The platform is built on several key design principles:

* [cite_start]**Pragmatic Trust Model**: The system is a hybrid, not fully trustless[cite: 98]. [cite_start]It relies on a trusted `Admin` role for vetting charities [cite: 101, 103] [cite_start]and a trusted `Oracle` role for process management (liveness)[cite: 107]. [cite_start]However, it is fully **non-custodial**; admins and oracles cannot steal or access user funds held in the escrow[cite: 111, 112].
* [cite_start]**Modularity & Upgradeability**: The architecture is built as a set of "microservices" (individual contracts) rather than one monolithic contract[cite: 116, 1381]. [cite_start]A central `Governance` contract acts as a service registry [cite: 118][cite_start], allowing individual components (like a reputation algorithm) to be upgraded without redeploying the entire system[cite: 121, 1384].
* [cite_start]**Incentive Alignment**: All participants (donors, validators, charities) are rewarded for honest participation through mechanisms like leaderboards, staking rewards, and reputation scores[cite: 1396, 1397, 1398, 1399].
* [cite_start]**Fair Participation**: The system uses quadratic voting, where voting power is calculated as `sqrt(PledgedAmount) * Reputation`[cite: 144, 203, 1402]. This ensures that voting power grows slower than the amount staked, mitigating control by wealthy actors.
* **Hybrid Data Storage**: To balance transparency and cost, the system stores only essential data on-chain. [cite_start]Evidence (e.g., receipts, photos) is stored off-chain on IPFS [cite: 79, 187][cite_start], and the smart contracts only store the immutable IPFS Content Identifier (CID)[cite: 80, 81].

## Contracts

[cite_start]The system is composed of multiple smart contracts, each with a specific responsibility[cite: 313].

### Core Infrastructure & Governance

* [cite_start]**Governance.sol**: The central control contract; manages admin roles and a registry of all other contract addresses[cite: 47, 710].
* [cite_start]**Registry.sol**: A parent abstract contract providing shared admin and pausing functionality[cite: 49, 743].
* [cite_start]**Oracle.sol**: The "process manager" that coordinates the voting lifecycle (e.g., advancing phases, triggering fund release)[cite: 50, 666, 669].
* [cite_start]**SGDCoin.sol**: The ERC20 stablecoin used for all pledges[cite: 51, 983].
* [cite_start]**EscrowVault.sol**: The central "bank" that securely holds all donor-pledged funds until a vote outcome is finalized[cite: 52, 461].

### User & Entity Registries

* [cite_start]**CharityRegistry.sol**: Manages charity registration, approval, and profile management[cite: 54, 790].
* [cite_start]**DonorRegistry.sol**: Manages donor registration and verification[cite: 55, 832].
* [cite_start]**AttestorRegistry.sol**: A whitelist of approved attestors eligible for verification voting[cite: 56, 849].

### Event & Funding Lifecycle

* [cite_start]**CharityEvent.sol**: A contract representing a single fundraising campaign, tracking its status (e.g., `FUNDING`, `VERIFICATION`) and goals[cite: 59, 282, 288].
* [cite_start]**DonorPledges.sol**: Manages the creation of pledges, recording a donor's stake in an event[cite: 60, 180].
* [cite_start]**EvidenceVault.sol**: Stores the IPFS CIDs that link to off-chain evidence submitted by charities[cite: 61, 1055].
* [cite_start]**CharityTreasury.sol**: A dedicated "bank account" for each charity, which receives funds from the `EscrowVault` after a successful event[cite: 63, 1036].

### Verification & Voting

* [cite_start]**DonorVoting.sol**: Manages the commit-reveal voting process for donors, weighting votes by stake and reputation[cite: 67, 194, 196].
* [cite_start]**AttestorVoting.sol**: Manages a secondary voting layer where expert attestors stake tokens to vote on event success, providing an economic check on the donor vote[cite: 68, 69, 615].

### Reputation Systems

* [cite_start]**CharityReputation.sol**: Tracks a charity's score based on successful events and community votes[cite: 73, 904].
* [cite_start]**DonorRanking.sol**: Calculates a donor's reputation score based on their donation history and voting participation[cite: 74, 948].

## Testing Structure

[cite_start]The project was rigorously validated using a combination of unit tests, integration tests, and end-to-end functional tests[cite: 1499].

* [cite_start]**Framework**: Tests are built using the **Hardhat** framework with **Chai** for assertions and **Ethers.js** for blockchain interaction[cite: 1500].
* [cite_start]**Scope**: Over 200 automated test cases were executed[cite: 1512]. [cite_start]These tests confirmed the correctness of core logic [cite: 1513][cite_start], the enforcement of role-based security (e.g., ensuring only an Admin can perform certain actions) [cite: 1514][cite_start], and the full end-to-end interoperability of the pledge-vote-release flow[cite: 1508].
* [cite_start]**Organization**: Tests are organized into modular files corresponding to each contract (e.g., `test_Governance.js`, `test_DonorVoting.js`, `test_Oracle.js`)[cite: 1502].

## Basic Hardhat Commands

Try running some of the following tasks:

```shell
npx hardhat help
npx hardhat test
REPORT_GAS=true npx hardhat test
npx hardhat node
npx hardhat ignition deploy ./ignition/modules/Lock.js
