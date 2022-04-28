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
pragma experimental "ABIEncoderV2";

import { ISetToken } from "@setprotocol/set-protocol-v2/contracts/interfaces/ISetToken.sol";
// import { IAirdropModule } from "@setprotocol/set-protocol-v2/contracts/interfaces/IAirdropModule.sol"; // need to add this to set-protocol-v2
import { IAirdropModule } from "../interfaces/IAirdropModule.sol";
// import { IClaimModule } from "@setprotocol/set-protocol-v2/contracts/interfaces/IClaimModule.sol"; // need to add this to set-protocol-v2
import { IClaimModule } from "../interfaces/IClaimModule.sol";

import { BaseGlobalExtension } from "../lib/BaseGlobalExtension.sol";
import { IDelegatedManager } from "../interfaces/IDelegatedManager.sol";
import { IManagerCore } from "../interfaces/IManagerCore.sol";

/**
 * @title ClaimExtension
 * @author Set Protocol
 *
 * Smart contract global extension which provides DelegatedManager operator(s) the ability to
 * - claim tokens from external protocols given to a Set as part of participating in incentivized activities of other protocols
 * - absorb tokens sent to the SetToken into the token's positions
 */
contract ClaimExtension is BaseGlobalExtension {

    /* ============ Events ============ */

    event ClaimExtensionInitialized(
        address indexed _setToken,
        address indexed _delegatedManager
    );

    /* ============ State Variables ============ */

    // Instance of AirdropModule
    IAirdropModule public immutable airdropModule;

    // Instance of ClaimModule
    IClaimModule public immutable claimModule;

    /* ============ Constructor ============ */

    /**
     * Instantiate with ManagerCore, AirdropModule, and ClaimModule addresses.
     *
     * @param _managerCore              Address of ManagerCore contract
     * @param _airdropModule            Address of AirdropModule contract
     * @param _claimModule              Address of ClaimModule contract
     */
    constructor(
        IManagerCore _managerCore,
        IAirdropModule _airdropModule,
        IClaimModule _claimModule
    )
        public
        BaseGlobalExtension(_managerCore)
    {
        airdropModule = _airdropModule;
        claimModule = _claimModule;
    }

    /* ============ External Functions ============ */

    /**
     * ONLY OWNER: Initializes AirdropModule on the SetToken associated with the DelegatedManager.
     *
     * @param _delegatedManager     Instance of the DelegatedManager to initialize the AirdropModule for
     * @param _airdropSettings      Struct of airdrop setting for Set including accepted airdrops, feeRecipient,
     *                              airdropFee, and indicating if anyone can call an absorb
     */
    function initializeAirdropModule(
        IDelegatedManager _delegatedManager,
        IAirdropModule.AirdropSettings memory _airdropSettings
    )
        external
        onlyOwnerAndValidManager(_delegatedManager)
    {
        _initializeAirdropModule(_delegatedManager.setToken(), _delegatedManager, _airdropSettings);
    }

    /**
     * ONLY OWNER: Initializes ClaimModule on the SetToken associated with the DelegatedManager.
     *
     * @param _delegatedManager     Instance of the DelegatedManager to initialize the ClaimModule for
     * @param _anyoneClaim          Boolean indicating if anyone can claim or just manager
     * @param _rewardPools          Addresses of rewardPools that identifies the contract governing claims. Maps to same index integrationNames
     * @param _integrationNames     Human-readable names matching adapter used to collect claim on pool. Maps to same index in rewardPools
     */
    function initializeClaimModule(
        IDelegatedManager _delegatedManager,
        bool _anyoneClaim,
        address[] calldata _rewardPools,
        string[] calldata _integrationNames
    )
        external
        onlyOwnerAndValidManager(_delegatedManager)
    {
        _initializeClaimModule(_delegatedManager.setToken(), _delegatedManager, _anyoneClaim, _rewardPools, _integrationNames);
    }

    /**
     * ONLY OWNER: Initializes ClaimExtension to the DelegatedManager.
     *
     * @param _delegatedManager     Instance of the DelegatedManager to initialize
     */
    function initializeExtension(IDelegatedManager _delegatedManager) external onlyOwnerAndValidManager(_delegatedManager) {
        ISetToken setToken = _delegatedManager.setToken();

        _initializeExtension(setToken, _delegatedManager);

        emit ClaimExtensionInitialized(address(setToken), address(_delegatedManager));
    }

    /**
     * ONLY OWNER: Initializes ClaimExtension to the DelegatedManager and AirdropModule and ClaimModule to the SetToken
     *
     * @param _delegatedManager     Instance of the DelegatedManager to initialize
     * @param _airdropSettings      Struct of airdrop setting for Set including accepted airdrops, feeRecipient,
     *                              airdropFee, and indicating if anyone can call an absorb
     * @param _anyoneClaim          Boolean indicating if anyone can claim or just manager
     * @param _rewardPools          Addresses of rewardPools that identifies the contract governing claims. Maps to same index integrationNames
     * @param _integrationNames     Human-readable names matching adapter used to collect claim on pool. Maps to same index in rewardPools
     */
    function initializeModulesAndExtension(
        IDelegatedManager _delegatedManager,
        IAirdropModule.AirdropSettings memory _airdropSettings,
        bool _anyoneClaim,
        address[] calldata _rewardPools,
        string[] calldata _integrationNames
    )
        external
        onlyOwnerAndValidManager(_delegatedManager)
    {
        ISetToken setToken = _delegatedManager.setToken();

        _initializeExtension(setToken, _delegatedManager);
        _initializeAirdropModule(_delegatedManager.setToken(), _delegatedManager, _airdropSettings);
        _initializeClaimModule(_delegatedManager.setToken(), _delegatedManager, _anyoneClaim, _rewardPools, _integrationNames);

        emit ClaimExtensionInitialized(address(setToken), address(_delegatedManager));
    }

    /**
     * ONLY MANAGER: Remove an existing SetToken and DelegatedManager tracked by the ClaimExtension
     */
    function removeExtension() external override {
        IDelegatedManager delegatedManager = IDelegatedManager(msg.sender);
        ISetToken setToken = delegatedManager.setToken();

        _removeExtension(setToken, delegatedManager);
    }

    /* ============ Internal Functions ============ */

    /**
     * Internal function to initialize AirdropModule on the SetToken associated with the DelegatedManager.
     *
     * @param _setToken             Instance of the SetToken corresponding to the DelegatedManager
     * @param _delegatedManager     Instance of the DelegatedManager to initialize the AirdropModule for
     * @param _airdropSettings      Struct of airdrop setting for Set including accepted airdrops, feeRecipient,
     *                              airdropFee, and indicating if anyone can call an absorb
     */
    function _initializeAirdropModule(
        ISetToken _setToken,
        IDelegatedManager _delegatedManager,
        IAirdropModule.AirdropSettings memory _airdropSettings
    )
        internal
    {
        bytes memory callData = abi.encodeWithSelector(
            IAirdropModule.initialize.selector,
            _setToken,
            _airdropSettings
        );
        _invokeManager(_delegatedManager, address(airdropModule), callData);
    }

    /**
     * Internal function to initialize ClaimModule on the SetToken associated with the DelegatedManager.
     *
     * @param _setToken             Instance of the SetToken corresponding to the DelegatedManager
     * @param _delegatedManager     Instance of the DelegatedManager to initialize the ClaimModule for
     * @param _anyoneClaim          Boolean indicating if anyone can claim or just manager
     * @param _rewardPools          Addresses of rewardPools that identifies the contract governing claims. Maps to same index integrationNames
     * @param _integrationNames     Human-readable names matching adapter used to collect claim on pool. Maps to same index in rewardPools
     */
    function _initializeClaimModule(
        ISetToken _setToken,
        IDelegatedManager _delegatedManager,
        bool _anyoneClaim,
        address[] calldata _rewardPools,
        string[] calldata _integrationNames
    )
        internal
    {
        bytes memory callData = abi.encodeWithSelector(
            IClaimModule.initialize.selector,
            _setToken,
            _anyoneClaim,
            _rewardPools,
            _integrationNames
        );
        _invokeManager(_delegatedManager, address(claimModule), callData);
    }
}