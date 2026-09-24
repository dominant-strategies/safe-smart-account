// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity >=0.7.0 <0.9.0;

import "./QuaiSafeProxy.sol";

/**
 * @title IQuaiProxyCreationCallback
 * @dev ABI-compatible Quai profile of Safe 1.4.1's IProxyCreationCallback.
 */
interface IQuaiProxyCreationCallback {
    function proxyCreated(
        QuaiSafeProxy proxy,
        address _singleton,
        bytes calldata initializer,
        uint256 saltNonce
    ) external;
}
