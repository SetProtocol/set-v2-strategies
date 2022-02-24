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
pragma experimental ABIEncoderV2;

import { ISetToken } from "@setprotocol/set-protocol-v2/contracts/interfaces/ISetToken.sol";

import { BaseManager } from "../manager/BaseManager.sol";

contract ManagerFactory {
    struct InitializeParams{
        address initializer;
        address owner;
    }
    
    address public factory;
    mapping(ISetToken=>InitializeParams) public initializeState;
    mapping(ISetToken=>bool) public isValidSet;
    address[] internal validSets; 

    modifier onlyInitializer(ISetToken _setToken) {
        require(msg.sender == initializeState[_setToken].initializer);
        _;
    }

    constructor(
        address _setTokenFactory
    ) public {
        factory = _setTokenFactory;
    }

    /* ============ External Functions ============ */

    function create(
        address[] memory _components,
        uint256 _units,
        string memory _name,
        string memory _symbol,
        address _owner,
        address _methodologist,
        address[] memory _modules,
        address[] memory _operators,
        address[] memory _assets,
        address[] memory _extensions
    )
        external
        returns (ISetToken setToken, address managerAddress)
    {
        setToken = ISetToken(_deploySet(
            _components,
            _modules,
            _units,
            _name,
            _symbol
        ));

        managerAddress = _deployManager(
            setToken,
            _methodologist,
            _operators,
            _assets,
            _extensions
        );

        initializeState[setToken] = InitializeParams({
            initializer: msg.sender,
            owner: _owner
        });
        isValidSet[setToken] = true;
        validSets.push(address(setToken));
    }

    function initialize(
        ISetToken _setToken,
        address[] memory _initializeTargets,
        bytes[] memory _initializeBytecode
    )
        external
        onlyInitializer(_setToken)
    {

    }

    /* ============ External View Functions ============ */

    function getValidSets() external view returns (address[] memory) {
        return validSets;
    }

    /* ============ Internal Functions ============ */

    function _deploySet(
        address[] memory _components,
        address[] memory _modules,
        uint256 _units,
        string memory _name,
        string memory _symbol
    )
        internal
        returns (address)
    {}

    function _deployManager(
        ISetToken _setToken,
        address _methodologist,
        address[] memory _operators,
        address[] memory _assets,
        address[] memory _extensions
    )
        internal
        returns (address)
    {
        return address(new BaseManager(_setToken, address(this), _methodologist));
    }
}