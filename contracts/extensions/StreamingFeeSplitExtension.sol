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

import { Address } from "@openzeppelin/contracts/utils/Address.sol";
import { SafeMath } from "@openzeppelin/contracts/math/SafeMath.sol";

import { PreciseUnitMath } from "@setprotocol/set-protocol-v2/contracts/lib/PreciseUnitMath.sol";
import { ISetToken } from "@setprotocol/set-protocol-v2/contracts/interfaces/ISetToken.sol";

import { BaseGlobalExtension } from "../lib/BaseGlobalExtension.sol";
import { IManagerCore } from "../interfaces/IManagerCore.sol";
import { IDelegatedManager } from "../interfaces/IDelegatedManager.sol";

import { IStreamingFeeModule } from "../interfaces/IStreamingFeeModuleV2.sol";

/**
 * @title StreamingFeeSplitExtension
 * @author Set Protocol
 *
 * Smart contract global extension which provides DelegatedManager owner and 
 * methodologist the ability to accrue and split streaming fees at an mutable percentage.
 */
contract StreamingFeeSplitExtension is BaseGlobalExtension {
    using Address for address;
    using PreciseUnitMath for uint256;
    using SafeMath for uint256;

    /* ============ Events ============ */

    event ExtensionInitialized(
        address _setToken,
        address _delegatedManager
    );

    event ExtensionRemoved(
        address _setToken,
        address _delegatedManager
    );

    event FeesDistributed(
        address _setToken,
        address indexed _ownerFeeRecipient,
        address indexed _methodologist,
        uint256 _ownerTake,
        uint256 _methodologistTake
    );

    /* ============ State Variables ============ */

    // Instance of StreamingFeeModule
    IStreamingFeeModule public immutable streamingFeeModule;

    // Mapping from Set Token to DelegatedManager 
    mapping(ISetToken => IDelegatedManager) public setManagers;

    /* ============ Constructor ============ */

    constructor(
        IManagerCore _managerCore,
        IStreamingFeeModule _streamingFeeModule
    )
        public
        BaseGlobalExtension(_managerCore)
    {
        streamingFeeModule = _streamingFeeModule;
    }

    /* ============ External Functions ============ */

    /**
     * ANYONE CALLABLE: Accrues fees from streaming fee module. Gets resulting balance after fee accrual, calculates fees for
     * owner and methodologist, and sends to owner fee recipient and methodologist respectively.
     */
    function accrueFeesAndDistribute(ISetToken _setToken) public {
        // Emits a FeeActualized event
        streamingFeeModule.accrueFee(_setToken);

        IDelegatedManager delegatedManager = _manager(_setToken);

        uint256 totalFees = _setToken.balanceOf(address(delegatedManager));

        address methodologist = delegatedManager.methodologist();
        address ownerFeeRecipient = delegatedManager.ownerFeeRecipient();

        uint256 ownerTake = totalFees.preciseMul(delegatedManager.ownerFeeSplit());
        uint256 methodologistTake = totalFees.sub(ownerTake);

        if (ownerTake > 0) {
            delegatedManager.transferTokens(address(_setToken), ownerFeeRecipient, ownerTake);
        }

        if (methodologistTake > 0) {
            delegatedManager.transferTokens(address(_setToken), methodologist, methodologistTake);
        }

        emit FeesDistributed(address(_setToken), ownerFeeRecipient, methodologist, ownerTake, methodologistTake);
    }

    /**
     * ONLY OWNER: Initializes StreamingFeeSplitExtension to the DelegatedManager.
     *
     * @param _delegatedManager     Instance of the DelegatedManager to initialize
     */
    function initializeExtension(IDelegatedManager _delegatedManager) external {
        ISetToken setToken = _delegatedManager.setToken();

        require(
            managerCore.isFactory(msg.sender) || 
            address(_delegatedManager) == setToken.manager(),
            "Must be factory or input must be SetToken manager"
        );
        require(msg.sender == _delegatedManager.owner(), "Must be owner");
        require(_delegatedManager.isPendingExtension(address(this)), "Extension must be pending");

        setManagers[setToken] = _delegatedManager;

        _delegatedManager.initializeExtension();

        ExtensionInitialized(address(setToken), address(_delegatedManager));
    }

    /**
     * ONLY OWNER: Initializes StreamingFeeSplitExtension to the DelegatedManager and StreamingFeeModule to the SetToken
     *
     * @param _delegatedManager     Instance of the DelegatedManager to initialize
     * @param _settings             FeeState struct defining fee parameters for StreamingFeeModule initialization
     */
    function initializeModuleAndExtension(
        IDelegatedManager _delegatedManager,
        IStreamingFeeModule.FeeState memory _settings
    ) 
        external 
    {
        require(msg.sender == _delegatedManager.owner(), "Must be owner");
        require(_delegatedManager.isPendingExtension(address(this)), "Extension must be pending");

        ISetToken setToken = _delegatedManager.setToken();

        require(setToken.isPendingModule(address(streamingFeeModule)), "StreamingFeeModule must be pending");

        setManagers[setToken] = _delegatedManager;

        _delegatedManager.initializeExtension();

        bytes memory callData = abi.encodeWithSignature(
            "initialize(address,(address,uint256,uint256,uint256))", 
            setToken,
            _settings);
        _invokeManager(setToken, address(streamingFeeModule), callData);

        ExtensionInitialized(address(setToken), address(_delegatedManager));
    }

    /**
     * ONLY MANAGER: Remove an existing SetToken and DelegatedManager tracked by the TradeExtension 
     */
    function removeExtension() external override {
        IDelegatedManager delegatedManager = IDelegatedManager(msg.sender);
        ISetToken setToken = delegatedManager.setToken();

        require(msg.sender == address(_manager(setToken)), "Must be Manager");

        delete setManagers[setToken];

        ExtensionRemoved(address(setToken), address(delegatedManager));
    }

    /**
     * ONLY OWNER: Updates streaming fee on StreamingFeeModule.
     *
     * NOTE: This will accrue streaming fees though not send to owner fee recipient and methodologist.
     *
     * @param _setToken     Instance of the SetToken to update streaming fee for
     * @param _newFee       Percent of Set accruing to fee extension annually (1% = 1e16, 100% = 1e18)
     */
    function updateStreamingFee(ISetToken _setToken, uint256 _newFee)
        external
        onlyOwner(_setToken)
    {
        bytes memory callData = abi.encodeWithSignature("updateStreamingFee(address,uint256)", _setToken, _newFee);
        _invokeManager(_setToken, address(streamingFeeModule), callData);
    }

    /**
     * ONLY OWNER: Updates fee recipient on StreamingFeeModule
     *
     * @param _setToken         Instance of the SetToken to update fee recipient for
     * @param _newFeeRecipient  Address of new fee recipient. This should be the address of the DelegatedManager
     */
    function updateFeeRecipient(ISetToken _setToken, address _newFeeRecipient)
        external
        onlyOwner(_setToken)
    {
        bytes memory callData = abi.encodeWithSignature("updateFeeRecipient(address,address)", _setToken, _newFeeRecipient);
        _invokeManager(_setToken, address(streamingFeeModule), callData);
    }

    /* ============ Internal Functions ============ */

    /**
     * Internal function to grab manager of passed SetToken from StreamingFeeSplitExtension data structure.
     *
     * @param _setToken         SetToken who's manager is needed 
     */
    function _manager(ISetToken _setToken) internal override view returns (IDelegatedManager) {
        return setManagers[_setToken];
    }
}