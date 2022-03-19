/*
    Copyright 2022 Set Labs Inc.

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

/**
 * Mock PerpV2 Price Feed.
 */
contract PerpV2PriceFeedMock {
    uint8 public decimals;
    uint256 internal price;

    constructor(uint8 _decimals) public {
        decimals = _decimals;
    }

    /**
     * Typical usage for setting the BaseToken oracle to 100 is:
     *
     * ```
     *  await mockPriceFeed.setPrice(ethers.utils.parseUnits("100", decimals));
     * ```
     */
    function setPrice(uint256 _price) public {
        price = _price;
    }


    /**
     * Returns the index price of the token.
     */
    function getPrice(uint256 /*interval*/) external view returns (uint256) {
        return price;
    }
}