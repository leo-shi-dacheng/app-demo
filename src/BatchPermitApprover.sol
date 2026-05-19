// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20Permit {
    function permit(
        address owner,
        address spender,
        uint256 value,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;
}

/// @title BatchPermitApprover
/// @dev Relays many EIP-2612 permit approvals in one transaction. It never takes custody of funds.
contract BatchPermitApprover {
    struct PermitData {
        address owner;
        address spender;
        uint256 value;
        uint256 deadline;
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

    event PermitRelayed(address indexed token, address indexed owner, address indexed spender, uint256 value);

    /// @dev Submits a bounded batch of signed permits to the token contract.
    /// @param token ERC20 permit token address.
    /// @param permits Permit signatures and approval parameters.
    function permitMany(address token, PermitData[] calldata permits) external {
        IERC20Permit permitToken = IERC20Permit(token);
        for (uint256 i = 0; i < permits.length; i++) {
            PermitData calldata item = permits[i];
            permitToken.permit(item.owner, item.spender, item.value, item.deadline, item.v, item.r, item.s);
            emit PermitRelayed(token, item.owner, item.spender, item.value);
        }
    }
}
