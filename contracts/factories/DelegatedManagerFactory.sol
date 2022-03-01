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

import { Address } from "@openzeppelin/contracts/utils/Address.sol";
import { ISetToken } from "@setprotocol/set-protocol-v2/contracts/interfaces/ISetToken.sol";

import { AddressArrayUtils } from "../lib/AddressArrayUtils.sol";
import { DelegatedManager } from "../manager/DelegatedManager.sol";
import { IDelegatedManager } from "../interfaces/IDelegatedManager.sol";
import { ISetTokenCreator } from "../interfaces/ISetTokenCreator.sol";

contract DelegatedManagerFactory {
    using AddressArrayUtils for address[];
    using Address for address;

    struct InitializeParams{
        address deployer;
        address owner;
        IDelegatedManager manager;
        bool isPending;
    }
    
    ISetTokenCreator public setTokenFactory;
    mapping(ISetToken=>InitializeParams) public initializeState;
    mapping(ISetToken=>bool) public isValidSet;
    address[] internal validSets; 

    constructor(
        ISetTokenCreator _setTokenFactory
    ) public {
        setTokenFactory = _setTokenFactory;
    }

    /* ============ External Functions ============ */

    function createSetAndManager(
        address[] memory _components,
        int256[] memory _units,
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
        returns (ISetToken, address)
    {
        require(_extensions.length > 0, "Must have at least 1 extension");
        // Require that components of Set are contained in the _assets array
        // Require there be at least one operator?

        ISetToken setToken = _deploySet(
            _components,
            _units,
            _modules,
            _name,
            _symbol
        );

        DelegatedManager manager = _deployManager(
            setToken,
            _methodologist,
            _extensions,
            _operators,
            _assets
        );

        _setInitializationState(setToken, address(manager), _owner);

        return (setToken, address(manager));
    }

    function createManager(
        ISetToken _setToken,
        address _owner,
        address _methodologist,
        address[] memory _operators,
        address[] memory _assets,
        address[] memory _extensions
    )
        external
        returns (address)
    {
        require(msg.sender == _setToken.manager(), "Must be manager");

        DelegatedManager manager = _deployManager(
            _setToken,
            _methodologist,
            _extensions,
            _operators,
            _assets
        );

        _setInitializationState(_setToken, address(manager), _owner);

        return address(manager);
    }

    function initialize(
        ISetToken _setToken,
        uint256 _ownerFeeSplit,
        address _ownerFeeRecipient,
        address[] memory _initializeTargets,
        bytes[] memory _initializeBytecode
    )
        external
    {
        require(initializeState[_setToken].isPending, "Manager must be awaiting initialization");
        require(msg.sender == initializeState[_setToken].deployer, "Only deployer can initialize manager");
        _initializeTargets.validatePairsWithArray(_initializeBytecode);

        IDelegatedManager manager = initializeState[_setToken].manager;
        manager.updateOwnerFeeSplit(_ownerFeeSplit);
        manager.updateOwnerFeeRecipient(_ownerFeeRecipient);

        for (uint256 i = 0; i < _initializeTargets.length; i++) {
            _initializeTargets[i].functionCallWithValue(_initializeBytecode[i], 0);
        }

        _setToken.setManager(address(manager));
        initializeState[_setToken].manager.transferOwnership(initializeState[_setToken].owner);

        delete initializeState[_setToken];
    }

    /* ============ External View Functions ============ */

    function getValidSets() external view returns (address[] memory) {
        return validSets;
    }

    /* ============ Internal Functions ============ */

    function _deploySet(
        address[] memory _components,
        int256[] memory _units,
        address[] memory _modules,
        string memory _name,
        string memory _symbol
    )
        internal
        returns (ISetToken)
    {
        address setToken = setTokenFactory.create(
            _components,
            _units,
            _modules,
            address(this),      // Set Manager to this address so can xfer to manager deployed in next step
            _name,
            _symbol
        );

        return ISetToken(setToken);
    }

    function _deployManager(
        ISetToken _setToken,
        address _methodologist,
        address[] memory _extensions,
        address[] memory _operators,
        address[] memory _assets
    )
        internal
        returns (DelegatedManager)
    {
        bool useAssetAllowlist = _assets.length > 0;
        DelegatedManager newManager = new DelegatedManager(
            _setToken,
            address(this),
            _methodologist,
            _extensions,
            _operators,
            _assets,
            useAssetAllowlist
        );
        // emit ManagerCreated(address(setToken), _manager, _name, _symbol);
        return newManager;
    }

    function _setInitializationState(
        ISetToken _setToken,
        address _manager,
        address _owner
    ) internal {
        initializeState[_setToken] = InitializeParams({
            deployer: msg.sender,
            owner: _owner,
            manager: IDelegatedManager(_manager),
            isPending: true
        });

        isValidSet[_setToken] = true;
        validSets.push(address(_setToken));
    }
}