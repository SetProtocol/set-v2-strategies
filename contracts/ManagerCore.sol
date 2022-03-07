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

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { AddressArrayUtils } from "./lib/AddressArrayUtils.sol";

contract ManagerCore is Ownable {
    using AddressArrayUtils for address[];

    /* ============ Events ============ */

    event FactoryAdded(address indexed _factory);
    event FactoryRemoved(address indexed _factory);

    /* ============ Modifiers ============ */

    modifier onlyInitialized() {
        require(isInitialized, "Contract must be initialized.");
        _;
    }

    /* ============ State Variables ============ */

    // List of enabled factories of managers
    address[] public factories;

    // Mapping to check whether address is valid Factory
    mapping(address => bool) public isFactory;

    // Return true if the ManagerCore is initialized
    bool public isInitialized;

    /* ============ External Functions ============ */

    /**
     * Initializes any predeployed factories. Note: This function can only be called by
     * the owner once to batch initialize the initial system contracts.
     *
     * @param _factories             List of factories to add
     */
    function initialize(
        address[] memory _factories
    )
        external
        onlyOwner
    {
        require(!isInitialized, "ManagerCore is already initialized");

        factories = _factories;

        // Loop through and initialize isFactory mapping
        for (uint256 i = 0; i < _factories.length; i++) {
            require(_factories[i] != address(0), "Zero address submitted.");
            isFactory[_factories[i]] = true;
        }

        // Set to true to only allow initialization once
        isInitialized = true;
    }

    /**
     * PRIVILEGED GOVERNANCE FUNCTION. Allows governance to add a factory
     *
     * @param _factory               Address of the factory contract to add
     */
    function addFactory(address _factory) external onlyInitialized onlyOwner {
        require(!isFactory[_factory], "Factory already exists");

        isFactory[_factory] = true;

        factories.push(_factory);

        emit FactoryAdded(_factory);
    }

    /**
     * PRIVILEGED GOVERNANCE FUNCTION. Allows governance to remove a factory
     *
     * @param _factory               Address of the factory contract to remove
     */
    function removeFactory(address _factory) external onlyInitialized onlyOwner {
        require(isFactory[_factory], "Factory does not exist");

        factories = factories.remove(_factory);

        isFactory[_factory] = false;

        emit FactoryRemoved(_factory);
    }

    /* ============ External Getter Functions ============ */

    function getFactories() external view returns (address[] memory) {
        return factories;
    }
}