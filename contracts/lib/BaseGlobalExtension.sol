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

import { AddressArrayUtils } from "../lib/AddressArrayUtils.sol";
import { IDelegatedManager } from "../interfaces/IDelegatedManager.sol";
import { ISetToken } from "../interfaces/ISetToken.sol";

/**
 * @title BaseExtension
 * @author Set Protocol
 *
 * Abstract class that houses common global extension-related functions. Global extensions must
 * also have their own initializeExtension function.
 */
abstract contract BaseGlobalExtension {
    using AddressArrayUtils for address[];

    /* ============ Modifiers ============ */

    /**
     * Throws if the sender is not the SetToken operator
     */
    modifier onlyOwner(ISetToken _setToken) {
        require(msg.sender == _manager(_setToken).owner(), "Must be owner");
        _;
    }

    /**
     * Throws if the sender is not the SetToken methodologist
     */
    modifier onlyMethodologist(ISetToken _setToken) {
        require(msg.sender == _manager(_setToken).methodologist(), "Must be methodologist");
        _;
    }

    /**
     * Throws if the sender is not the SetToken operator
     */
    modifier onlyOperator(ISetToken _setToken) {
        require(_manager(_setToken).operatorAllowlist(msg.sender), "Must be approved operator");
        _;
    }

    /**
     * Throws if the sender is not the SetToken manager contract
     */
    modifier onlyManager(ISetToken _setToken) {
        require(address(_manager(_setToken)) == msg.sender, "Must be manager");
        _;
    }

    /**
     * Throws if asset is not allowed to be held by the Set
     */
    modifier onlyAllowedAsset(ISetToken _setToken, address _asset) {
        require(_manager(_setToken).isAllowedAsset(_asset), "Must be allowed asset");
        _;
    }

    /**
     * ONLY MANAGER: Deletes SetToken/Manager state from extension. Must only be callable by manager!
     */
    function removeExtension(ISetToken _setToken) external virtual;

    /* ============ Internal Functions ============ */

    /**
     * Invoke call from manager
     *
     * @param _module           Module to interact with
     * @param _encoded          Encoded byte data
     */
    function invokeManager(ISetToken _setToken, address _module, bytes memory _encoded) internal {
        _manager(_setToken).interactManager(_module, _encoded);
    }

    /**
     * Internal function to grab manager of passed SetToken from extensions data structure.
     *
     * @param _setToken         SetToken who's manager is needed 
     */
    function _manager(ISetToken _setToken) internal virtual view returns (IDelegatedManager);
}