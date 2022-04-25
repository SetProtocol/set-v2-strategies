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
pragma experimental ABIEncoderV2;

import { Address } from "@openzeppelin/contracts/utils/Address.sol";

import { AddressArrayUtils } from "@setprotocol/set-protocol-v2/contracts/lib/AddressArrayUtils.sol";
import { IController } from "@setprotocol/set-protocol-v2/contracts/interfaces/IController.sol";
import { ISetToken } from "@setprotocol/set-protocol-v2/contracts/interfaces/ISetToken.sol";
import { ISetTokenCreator } from "@setprotocol/set-protocol-v2/contracts/interfaces/ISetTokenCreator.sol";

import { DelegatedManager } from "../manager/DelegatedManager.sol";
import { IDelegatedManager } from "../interfaces/IDelegatedManager.sol";
import { IManagerCore } from "../interfaces/IManagerCore.sol";

/**
 * @title DelegatedManagerFactory
 * @author Set Protocol
 *
 * Factory smart contract which gives asset managers the ability to:
 * > create a Set Token managed with a DelegatedManager contract
 * > create a DelegatedManager contract for an existing Set Token to migrate to
 * > initialize extensions and modules for SetTokens using the DelegatedManager system
 */
contract DelegatedManagerFactory {
    using AddressArrayUtils for address[];
    using Address for address;

    /* ============ Structs ============ */

    struct InitializeParams{
        address deployer;
        address owner;
        address methodologist;
        IDelegatedManager manager;
        bool isPending;
    }

    struct SetInitializers {
        address[] _components;
        address[] _modules;
        int256[] _units;
        string _name;
        string _symbol;
    }

    struct ManagerInitializers {
        address[] _operators;
        address[] _assets;
        address[] _extensions;
        bytes[] _initializeBytecode;
    }

    /* ============ Events ============ */

    /**
     * @dev Emitted on DelegatedManager creation
     * @param _setToken             Instance of the SetToken being created
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
     * @param _setToken             Instance of the SetToken being initialized
     * @param _manager              Address of the DelegatedManager owner
    */
    event DelegatedManagerInitialized(
        ISetToken indexed _setToken,
        IDelegatedManager indexed _manager
    );

    /* ============ State Variables ============ */

    // ManagerCore address
    IManagerCore public immutable managerCore;

    // Controller address
    IController public immutable controller;

    // SetTokenFactory address
    ISetTokenCreator public immutable setTokenFactory;

    // Mapping which stores manager creation metadata between creation and initialization steps
    mapping(ISetToken=>InitializeParams) public initializeState;

    /* ============ Constructor ============ */

    /**
     * @dev Sets managerCore and setTokenFactory address.
     * @param _managerCore                      Address of ManagerCore protocol contract
     * @param _controller                       Address of Controller protocol contract
     * @param _setTokenFactory                  Address of SetTokenFactory protocol contract
     */
    constructor(
        IManagerCore _managerCore,
        IController _controller,
        ISetTokenCreator _setTokenFactory
    )
        public
    {
        managerCore = _managerCore;
        controller = _controller;
        setTokenFactory = _setTokenFactory;
    }

    /* ============ External Functions ============ */


    function createSetAndManager(
        SetInitializers memory _setInitializers,
        ManagerInitializers memory _managerInitializers,
        address _owner,
        address _methodologist,
        uint256 _ownerFeeSplit,
        address _ownerFeeRecipient
    )
        external
        returns (ISetToken, address)
    {
        _validateManagerParameters(
            _setInitializers._components,
            _managerInitializers._extensions,
            _managerInitializers._assets
        );

        ISetToken setToken = _deploySet(
            _setInitializers._components,
            _setInitializers._units,
            _setInitializers._modules,
            _setInitializers._name,
            _setInitializers._symbol
        );

        DelegatedManager manager = _deployManager(
            setToken,
            _managerInitializers._extensions,
            _managerInitializers._operators,
            _managerInitializers._assets
        );

        setToken.setManager(address(manager));

        _initializeExtensions(
            manager,
            _managerInitializers._extensions,
            _managerInitializers._initializeBytecode
        );

        _setManagerState(
            manager,
            _owner,
            _methodologist,
            _ownerFeeSplit,
            _ownerFeeRecipient
        );

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
     * @param  _assets           List of assets DelegateManager can trade. When empty, asset allow list is not enforced
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
        require(controller.isSet(address(_setToken)), "Must be controller-enabled SetToken");
        require(msg.sender == _setToken.manager(), "Must be manager");

        _validateManagerParameters(_setToken.getComponents(), _extensions, _assets);

        DelegatedManager manager = _deployManager(
            _setToken,
            _extensions,
            _operators,
            _assets
        );

        _setInitializationState(_setToken, address(manager), _owner, _methodologist);

        return address(manager);
    }

    /* ============ Internal Functions ============ */

    /**
     * Deploys a SetToken, setting this factory as its manager temporarily, pending initialization.
     * Managership is transferred to a newly created DelegatedManager during `initialize`
     *
     * @param _components       List of addresses of components for initial Positions
     * @param _units            List of units. Each unit is the # of components per 10^18 of a SetToken
     * @param _modules          List of modules to enable. All modules must be approved by the Controller
     * @param _name             Name of the SetToken
     * @param _symbol           Symbol of the SetToken
     *
     * @return Address of created SetToken;
     */
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
            address(this),
            _name,
            _symbol
        );

        return ISetToken(setToken);
    }

    /**
     * Deploys a DelegatedManager. Sets owner and methodologist roles to address(this) and the resulting manager address is
     * saved to the ManagerCore.
     *
     * @param  _setToken         Instance of SetToken to migrate to the DelegatedManager system
     * @param  _extensions       List of extensions authorized for the DelegateManager
     * @param  _operators        List of operators authorized for the DelegateManager
     * @param  _assets           List of assets DelegateManager can trade. When empty, asset allow list is not enforced
     *
     * @return Address of created DelegatedManager
     */
    function _deployManager(
        ISetToken _setToken,
        address[] memory _extensions,
        address[] memory _operators,
        address[] memory _assets
    )
        internal
        returns (DelegatedManager)
    {
        // If asset array is empty, manager's useAssetAllowList will be set to false
        // and the asset allow list is not enforced
        bool useAssetAllowlist = _assets.length > 0;

        DelegatedManager newManager = new DelegatedManager(
            _setToken,
            address(this),
            address(this),
            _extensions,
            _operators,
            _assets,
            useAssetAllowlist
        );

        // Registers manager with ManagerCore
        managerCore.addManager(address(newManager));

        emit DelegatedManagerCreated(
            _setToken,
            newManager,
            msg.sender
        );

        return newManager;
    }

    /**
     * Initialize extensions on the DelegatedManager. Checks that extensions are tracked on the ManagerCore and that the
     * provided bytecode targets the input manager.
     *
     * @param  _manager                  Instance of DelegatedManager
     * @param  _extensions               List of addresses of extensions to initialize
     * @param  _initializeBytecode       List of bytecode encoded calls to relevant extensions's initialize function
     */
    function _initializeExtensions(
        DelegatedManager _manager,
        address[] memory _extensions,
        bytes[] memory _initializeBytecode
    ) internal {
        for (uint256 i = 0; i < _extensions.length; i++) {
            address extension = _extensions[i];
            require(managerCore.isExtension(extension), "Target must be ManagerCore-enabled Extension");

            bytes memory initializeBytecode = _initializeBytecode[i];

            // Each input initializeBytecode is a varible length bytes array which consists of a 32 byte prefix for the
            // length parameter, a 4 byte function selector, a 32 byte DelegatedManager address, and any additional parameters
            // as shown below:
            // [32 bytes - length parameter, 4 bytes - function selector, 32 bytes - DelegatedManager address, additional parameters]
            // It is required that the input DelegatedManager address is the DelegatedManager address corresponding to the caller
            address inputManager;
            assembly {
                inputManager := mload(add(initializeBytecode, 36))
            }
            require(inputManager == address(_manager), "Must target correct DelegatedManager");

            // Because we validate uniqueness of _extensions only one transaction can be sent to each extension during this
            // transaction. Due to this no extension can be used for any SetToken transactions other than initializing these contracts
            extension.functionCallWithValue(initializeBytecode, 0);
        }
    }

    /**
     * Stores temporary creation metadata during the contract creation step. Data is retrieved, read and
     * finally deleted during `initialize`.
     *
     * @param  _setToken         Instance of SetToken
     * @param  _manager          Address of DelegatedManager created for SetToken
     * @param  _owner            Address that will be given the `owner` DelegatedManager's role on initialization
     * @param  _methodologist    Address that will be given the `methodologist` DelegatedManager's role on initialization
     */
    function _setInitializationState(
        ISetToken _setToken,
        address _manager,
        address _owner,
        address _methodologist
    ) internal {
        initializeState[_setToken] = InitializeParams({
            deployer: msg.sender,
            owner: _owner,
            methodologist: _methodologist,
            manager: IDelegatedManager(_manager),
            isPending: true
        });
    }

    /**
     * Initialize fee settings on DelegatedManager and transfer `owner` and `methodologist` roles.
     *
     * @param  _manager                 Instance of DelegatedManager
     * @param  _owner                   Address that will be given the `owner` DelegatedManager's role
     * @param  _methodologist           Address that will be given the `methodologist` DelegatedManager's role
     * @param  _ownerFeeSplit           Percent of fees in precise units (10^16 = 1%) sent to owner, rest to methodologist
     * @param  _ownerFeeRecipient       Address which receives owner's share of fees when they're distributed
     */
    function _setManagerState(
        DelegatedManager _manager,
        address _owner,
        address _methodologist,
        uint256 _ownerFeeSplit,
        address _ownerFeeRecipient
    ) internal {
        _manager.updateOwnerFeeSplit(_ownerFeeSplit);
        _manager.updateOwnerFeeRecipient(_ownerFeeRecipient);

        _manager.transferOwnership(_owner);
        _manager.setMethodologist(_methodologist);
    }

    /**
     * Validates that all components currently held by the Set are on the asset allow list. Validate that the manager is
     * deployed with at least one extension in the PENDING state.
     *
     * @param  _components       List of addresses of components for initial/current Set positions
     * @param  _extensions       List of extensions authorized for the DelegateManager
     * @param  _assets           List of assets DelegateManager can trade. When empty, asset allow list is not enforced
     */
    function _validateManagerParameters(
        address[] memory _components,
        address[] memory _extensions,
        address[] memory _assets
    )
        internal
        pure
    {
        require(_extensions.length > 0, "Must have at least 1 extension");

        if (_assets.length != 0) {
            _validateComponentsIncludedInAssetsList(_components, _assets);
        }
    }

    /**
     * Validates that all SetToken components are included in the assets whitelist. This prevents the
     * DelegatedManager from being initialized with some components in an untrade-able state.
     *
     * @param _components       List of addresses of components for initial Positions
     * @param  _assets          List of assets DelegateManager can trade.
     */
    function _validateComponentsIncludedInAssetsList(
        address[] memory _components,
        address[] memory _assets
    ) internal pure {
        for (uint256 i = 0; i < _components.length; i++) {
            require(_assets.contains(_components[i]), "Asset list must include all components");
        }
    }
}