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

    /* ============ Structs ============ */

    struct InitializeParams{
        address deployer;
        address owner;
        IDelegatedManager manager;
        bool isPending;
    }

    /* ============ Events ============ */

    /**
     * @dev Emitted on DelegatedManager creation
     * @param _setToken             Instance of the SetToken being levered
     * @param _manager              Address of the DelegatedManager
     * @param _deployer             Address of the deployer
    */
    event DelegatedManagerCreated(
        ISetToken indexed _setToken,
        DelegatedManager indexed _manager,
        address _deployer
    );

    /**
     * @dev Emitted on DelegatedManager initialization
     * @param _setToken             Instance of the SetToken being levered
     * @param _manager              Address of the DelegatedManager owner
    */
    event DelegatedManagerInitialized(
        ISetToken indexed _setToken,
        IDelegatedManager indexed _manager
    );

    /* ============ State Variables ============ */

    // SetTokenFactory address
    ISetTokenCreator public setTokenFactory;

    // Mapping which stores manager creation metadata between creation and initialization steps
    mapping(ISetToken=>InitializeParams) public initializeState;

    // Mapping of all sets that have succesfully initialized
    mapping(ISetToken=>bool) public isValidSet;

    // Address array of all sets that have succesfully initialized
    address[] internal validSets;

    /* ============ Constructor ============ */

    /**
     * @dev Sets setTokenFactory address.
     * @param _setTokenFactory                  Address of SetTokenFactory protocol contract
     */
    constructor(ISetTokenCreator _setTokenFactory) public {
        setTokenFactory = _setTokenFactory;
    }

    /* ============ External Functions ============ */

    /**
     * ANYONE CAN CALL: Deploys a new SetToken and DelegatedManager. Sets some temporary metadata about
     * the deployment which will be read during a subsequent intialization step which wires everything
     * together.
     *
     * @param _components       List of addresses of components for initial Positions
     * @param _units            List of units. Each unit is the # of components per 10^18 of a SetToken
     * @param _name             Name of the SetToken
     * @param _symbol           Symbol of the SetToken
     * @param _owner            Address to set as the DelegateManager's `owner` role
     * @param _methodologist    Address to set as the DelegateManager's methodologist role
     * @param _modules          List of modules to enable. All modules must be approved by the Controller
     * @param _operators        List of operators authorized for the DelegateManager
     * @param _assets           List of assets DelegateManager can trade. When empty, manager can trade any asset
     * @param _extensions       List of extensions authorized for the DelegateManager
     *
     * @return (ISetToken, address) The created SetToken and DelegatedManager addresses, respectively
     */
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
        if (_assets.length != 0) {
            _validateComponentsIncludedInAssetsList(_components, _assets);
        }

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

    /**
     * ONLY SETTOKEN MANAGER: Deploys a DelegatedManager and sets some temporary metadata about the
     * deployment which will be read during a subsequent intialization step which wires everything together.
     * This method is used when migrating an existing SetToken to the DelegatedManager system.
     *
     * (Note: This flow should work well for SetTokens managed by an EOA. However, existing
     * contract-managed Sets may need to have their ownership temporarily transferred to an EOA when
     * migrating. We don't anticipate high demand for this migration case though.)
     *
     * @param  _setToken         Instance of SetToken to migrate to the DelegatedManager system
     * @param  _owner            Address to set as the DelegateManager's `owner` role
     * @param  _methodologist    Address to set as the DelegateManager's methodologist role
     * @param  _operators        List of operators authorized for the DelegateManager
     * @param  _assets           List of assets DelegateManager can trade. When empty, manager can trade any asset
     * @param  _extensions       List of extensions authorized for the DelegateManager
     *
     * @return (address) Address of the created DelegatedManager
     */
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
        if (_assets.length != 0) {
            _validateComponentsIncludedInAssetsList(_setToken.getComponents(), _assets);
        }

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

    /**
     * ONLY DEPLOYER: Wires SetToken, DelegatedManager, global manager extensions, and modules together
     * into a functioning package.
     *
     * @param  _setToken                Instance of the SetToken
     * @param  _ownerFeeSplit           Percent of fees in precise units (10^16 = 1%) sent to operator, rest to methodologist
     * @param  _ownerFeeRecipient       Address which receives operator's share of fees when they're distributed
     * @param  _initializeTargets       List of addresses of any extensions or modules which need to be initialized
     * @param  _initializeBytecode      List of bytecode encoded calls to relevant target's initialize function
     */
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

        if (_setToken.manager() == address(this)) {
            _setToken.setManager(address(manager));
        }

        initializeState[_setToken].manager.transferOwnership(initializeState[_setToken].owner);

        delete initializeState[_setToken];
        emit DelegatedManagerInitialized(_setToken, manager);
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

        emit DelegatedManagerCreated(
            _setToken,
            newManager,
            msg.sender
        );

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

    function _validateComponentsIncludedInAssetsList(
        address[] memory _components,
        address[] memory _assets
    ) internal pure {
        for (uint256 i = 0; i < _components.length; i++) {
            require(_assets.contains(_components[i]), "Asset list must include all components");
        }
    }
}