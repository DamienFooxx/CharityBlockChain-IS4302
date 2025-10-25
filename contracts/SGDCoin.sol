// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/**
 * @title SGDCoin
 * @dev SGD-pegged stablecoin for the Charity Staking Platform
 * This contract implements a basic ERC20 token that represents SGD
 */
contract SGDCoin {
    // Token metadata
    string public constant name = "SGD Coin";
    string public constant symbol = "SGD";
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    
    // Owner of the contract
    address public owner;
    
    // Mappings
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    
    // Events
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event Mint(address indexed to, uint256 amount);
    event Burn(address indexed from, uint256 amount);
    
    // Modifiers
    modifier onlyOwner() {
        require(msg.sender == owner, "Only owner");
        _;
    }
    
    // Constructor
    constructor() {
        owner = msg.sender;
        totalSupply = 0;
    }
    
    /**
     * @dev Transfer tokens to a specified address
     * @param to The address to transfer to
     * @param value The amount to be transferred
     * @return success True if the operation was successful
     */
    function transfer(address to, uint256 value) public returns (bool success) {
        require(to != address(0), "Invalid address");
        require(value <= balanceOf[msg.sender], "Insufficient balance");
        
        balanceOf[msg.sender] -= value;
        balanceOf[to] += value;
        emit Transfer(msg.sender, to, value);
        return true;
    }
    
    /**
     * @dev Transfer tokens from one address to another
     * @param from The address to send tokens from
     * @param to The address to transfer to
     * @param value The amount of tokens to be transferred
     * @return success True if the operation was successful
     */
    function transferFrom(address from, address to, uint256 value) public returns (bool success) {
        require(to != address(0), "Invalid address");
        require(value <= balanceOf[from], "Insufficient balance");
        require(value <= allowance[from][msg.sender], "Allowance exceeded");
        
        balanceOf[from] -= value;
        balanceOf[to] += value;
        allowance[from][msg.sender] -= value;
        emit Transfer(from, to, value);
        return true;
    }
    
    /**
     * @dev Approve the passed address to spend the specified amount of tokens
     * @param spender The address which will spend the funds
     * @param value The amount of tokens to be spent
     * @return success True if the operation was successful
     */
    function approve(address spender, uint256 value) public returns (bool success) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }
    
    /**
     * @dev Mint new tokens (only owner)
     * @param to The address that will receive the minted tokens
     * @param amount The amount of tokens to mint
     */
    function mint(address to, uint256 amount) public onlyOwner {
        require(to != address(0), "Invalid address");
        require(amount > 0, "Amount must be positive");
        
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Mint(to, amount);
        emit Transfer(address(0), to, amount);
    }
    
    /**
     * @dev Burn tokens (only owner)
     * @param from The address to burn tokens from
     * @param amount The amount of tokens to burn
     */
    function burn(address from, uint256 amount) public onlyOwner {
        require(from != address(0), "Invalid address");
        require(amount > 0, "Amount must be positive");
        require(amount <= balanceOf[from], "Insufficient balance");
        
        totalSupply -= amount;
        balanceOf[from] -= amount;
        emit Burn(from, amount);
        emit Transfer(from, address(0), amount);
    }
}