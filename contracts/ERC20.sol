// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

//first need to approve the address of spender 
// Check the allowance
// Finally able to call transferFrom to transfer tokens

contract ERC20 {
    // Indicates whether minting has been finished
    bool public mintingFinished = false;

    // Contract owner
    address public owner = msg.sender;

    // Allowance mapping: owner -> spender -> amount
    mapping(address => mapping(address => uint256)) private allowed;

    // Balance mapping
    mapping(address => uint256) private balances;

    // Token metadata
    string public constant name = "DiceToken"; // Token name
    string public constant symbol = "DT";      // Token symbol
    uint8 public constant decimals = 18;       // Token decimals
    uint256 private totalSupply_;              // Total supply of the token

    // Events
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event Mint(address indexed to, uint256 amount);
    event MintFinished();

    /**
     * @dev Returns the total number of tokens in existence.
     */
    function totalSupply() public view returns (uint256) {
        return totalSupply_;
    }

    /**
     * @dev Gets the balance of the specified address.
     * @param _owner The address to query the balance of.
     * @return An uint256 representing the amount owned by the passed address.
     */
    function balanceOf(address _owner) public view returns (uint256) {
        return balances[_owner];
    }

    /**
     * @dev Transfer tokens to a specified address.
     * @param _to The address to transfer to.
     * @param _value The amount to be transferred.
     * @return True if the operation was successful.
     */
    function transfer(address _to, uint256 _value) public returns (bool) {
        require(_to != address(0), "Invalid address");
        require(_value <= balances[msg.sender], "Insufficient balance");

        balances[msg.sender] -= _value;
        balances[_to] += _value;
        emit Transfer(msg.sender, _to, _value);
        return true;
    }

    /**
     * @dev Transfer tokens from one address to another.
     * @param _from The address you want to send tokens from.
     * @param _to The address you want to transfer to.
     * @param _value The amount of tokens to be transferred.
     * @return True if the operation was successful.
     */
    function transferFrom(address _from, address _to, uint256 _value) public returns (bool) {
        require(_to != address(0), "Invalid address");
        require(_value <= balances[_from], "Insufficient balance");
        require(_value <= allowed[_from][msg.sender], "Allowance exceeded");

        balances[_from] -= _value;
        balances[_to] += _value;
        allowed[_from][msg.sender] -= _value;
        emit Transfer(_from, _to, _value);
        return true;
    }

    /**
     * @dev Approve the passed address to spend the specified amount of tokens on behalf of msg.sender.
     * @param _spender The address which will spend the funds.
     * @param _value The amount of tokens to be spent.
     * @return True if the operation was successful.
     */
    function approve(address _spender, uint256 _value) public returns (bool) {
        allowed[msg.sender][_spender] = _value;
        emit Approval(msg.sender, _spender, _value);
        return true;
    }

    /**
     * @dev Function to check the amount of tokens that an owner allowed to a spender.
     * @param _owner The address which owns the funds.
     * @param _spender The address which will spend the funds.
     * @return A uint256 specifying the amount of tokens still available for the spender.
     */
    function allowance(address _owner, address _spender) public view returns (uint256) {
        return allowed[_owner][_spender];
    }

    /**
     * @dev Function to mint tokens.
     * @param _to The address that will receive the minted tokens.
     * @param _amount The amount of tokens to mint.
     * @return True if the operation was successful.
     */
    function mint(address _to, uint256 _amount) public onlyOwner canMint returns (bool) {
        totalSupply_ += _amount;
        balances[_to] += _amount;
        emit Mint(_to, _amount);
        emit Transfer(address(0), _to, _amount);
        return true;
    }

    /**
     * @dev Function to stop minting new tokens.
     * @return True if the operation was successful.
     */
    function finishMinting() public onlyOwner canMint returns (bool) {
        mintingFinished = true;
        emit MintFinished();
        return true;
    }

    /**
     * @dev Returns the owner of the contract.
     */
    function getOwner() public view returns (address) {
        return owner;
    }

    // Modifiers
    modifier onlyOwner() {
        require(msg.sender == owner, "Caller is not the owner");
        _;
    }

    modifier canMint() {
        require(!mintingFinished, "Minting is finished");
        _;
    }
}
