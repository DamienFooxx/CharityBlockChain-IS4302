# Charity Staking Platform (IS4302)

This project, created for the NUS course IS4302: Blockchain and Distributed Ledger Technologies, is a comprehensive Charity Staking Platform. It is designed to solve significant challenges in the traditional charity sector, specifically the lack of transparency, accountability, and trust.

This platform enables donors to stake SGD-pegged stablecoins (SGDCoin) into a smart contract-based escrow. These funds are only released to the charity after a community of donors and a secondary layer of attestors vote to confirm that the charity has successfully provided evidence of completing its goals.

## Project Goals and Purpose

The platform's primary goal is to create a transparent, automated, and community-driven system for charity donations.

The core purpose is to empower donors by giving them the ability to vote on whether a charity's event was successful before funds are released. This entire process is managed by smart contracts, ensuring all transactions are verifiable and tamper-proof. The system also integrates a decentralized oracle to manage the process and a reputation system to assess charity transparency over time.

## Core Ideologies and Design Principles

The platform is built on several key design principles:

* **Pragmatic Trust Model**: The system is a hybrid, not fully trustless. It relies on a trusted `Admin` role for vetting charities and a trusted `Oracle` role for process management (liveness). However, it is fully **non-custodial**; admins and oracles cannot steal or access user funds held in the escrow.
* **Modularity & Upgradeability**: The architecture is built as a set of "microservices" (individual contracts) rather than one monolithic contract. A central `Governance` contract acts as a service registry, allowing individual components (like a reputation algorithm) to be upgraded without redeploying the entire system.
* **Incentive Alignment**: All participants (donors, validators, charities) are rewarded for honest participation through mechanisms like leaderboards, staking rewards, and reputation scores.
* **Fair Participation**: The system uses quadratic voting, where voting power is calculated as `sqrt(PledgedAmount) * Reputation`. This ensures that voting power grows slower than the amount staked, mitigating control by wealthy actors.
* **Hybrid Data Storage**: To balance transparency and cost, the system stores only essential data on-chain. Evidence (e.g., receipts, photos) is stored off-chain on IPFS, and the smart contracts only store the immutable IPFS Content Identifier (CID).

## Contracts

The system is composed of multiple smart contracts, each with a specific responsibility.

### Core Infrastructure & Governance

* **Governance.sol**: The central control contract; manages admin roles and a registry of all other contract addresses.
* **Registry.sol**: A parent abstract contract providing shared admin and pausing functionality.
* **Oracle.sol**: The "process manager" that coordinates the voting lifecycle (e.g., advancing phases, triggering fund release).
* **SGDCoin.sol**: The ERC20 stablecoin used for all pledges.
* **EscrowVault.sol**: The central "bank" that securely holds all donor-pledged funds until a vote outcome is finalized.

### User & Entity Registries

* **CharityRegistry.sol**: Manages charity registration, approval, and profile management.
* **DonorRegistry.sol**: Manages donor registration and verification.
* **AttestorRegistry.sol**: A whitelist of approved attestors eligible for verification voting.

### Event & Funding Lifecycle

* **CharityEvent.sol**: A contract representing a single fundraising campaign, tracking its status (e.g., `FUNDING`, `VERIFICATION`) and goals.
* **DonorPledges.sol**: Manages the creation of pledges, recording a donor's stake in an event.
* **EvidenceVault.sol**: Stores the IPFS CIDs that link to off-chain evidence submitted by charities.
* **CharityTreasury.sol**: A dedicated "bank account" for each charity, which receives funds from the `EscrowVault` after a successful event.

### Verification & Voting

* **DonorVoting.sol**: Manages the commit-reveal voting process for donors, weighting votes by stake and reputation.
* **AttestorVoting.sol**: Manages a secondary voting layer where expert attestors stake tokens to vote on event success, providing an economic check on the donor vote.

### Reputation Systems

* **CharityReputation.sol**: Tracks a charity's score based on successful events and community votes.
* **DonorRanking.sol**: Calculates a donor's reputation score based on their donation history and voting participation.

## Testing Structure

The project was rigorously validated using a combination of unit tests, integration tests, and end-to-end functional tests.

* **Framework**: Tests are built using the **Hardhat** framework with **Chai** for assertions and **Ethers.js** for blockchain interaction.
* **Scope**: Over 200 automated test cases were executed. These tests confirmed the correctness of core logic, the enforcement of role-based security (e.g., ensuring only an Admin can perform certain actions), and the full end-to-end interoperability of the pledge-vote-release flow.
* **Organization**: Tests are organized into modular files corresponding to each contract (e.g., `test_Governance.js`, `test_DonorVoting.js`, `test_Oracle.js`).
