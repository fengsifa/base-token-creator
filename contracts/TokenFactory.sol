// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
contract CreatedToken is ERC20 { uint8 private immutable _tokenDecimals; constructor(string memory n,string memory s,uint8 d,uint256 supply,address recipient) ERC20(n,s){_tokenDecimals=d;_mint(recipient,supply);} function decimals() public view override returns(uint8){return _tokenDecimals;} }
contract TokenFactory { event TokenCreated(address indexed token,address indexed creator,string name,string symbol); function createToken(string calldata n,string calldata s,uint8 d,uint256 supply) external returns(address token){require(bytes(n).length>0&&bytes(n).length<=32,"invalid name");require(bytes(s).length>0&&bytes(s).length<=12,"invalid symbol");require(supply>0,"invalid supply");token=address(new CreatedToken(n,s,d,supply,msg.sender));emit TokenCreated(token,msg.sender,n,s);} }
