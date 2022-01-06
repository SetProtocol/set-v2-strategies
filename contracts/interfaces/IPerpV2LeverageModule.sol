/*
    Copyright 2021 Set Labs Inc.

    Licensed under the Apache License, Version 2.0 (the "License");
    you may not use this file except in compliance with the License.
    You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

    Unless required by applicable law or agreed to in writing, software
    distributed under the License is distributed on an "AS IS" BASIS,
    WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
    See the License for the specific language governing permissions and
    limitations under the License.

    SPDX-License-Identifier: Apache License, Version 2.0
*/
pragma solidity 0.6.10;

import { ISetToken } from "./ISetToken.sol";
pragma experimental ABIEncoderV2;

/**
 * @title IPerpV2LeverageModule
 * @author Set Protocol
 *
 * Interface for interacting with Perp V2 leverage module
 */
interface IPerpV2LeverageModule {
    struct PositionInfo {
        address baseToken;              // Virtual token minted by the Perp protocol
        int256 baseBalance;             // Position size in 10**18 decimals. When negative, position is short
        int256 quoteBalance;            // vUSDC "debt" minted to open position. When positive, position is short
    }

    function trade(
        ISetToken _setToken,
        address _baseToken,
        int256 _baseQuantityUnits,
        uint256 _receiveQuoteQuantityUnits
    ) external;

    function getPositionInfo(ISetToken _setToken) external view returns (PositionInfo[] memory);
    function collateralToken() external view returns (address);
}
