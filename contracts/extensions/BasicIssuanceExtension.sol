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
import { IIssuanceModule } from "../interfaces/IIssuanceModule.sol";

/**
 * @title BasicIssuanceExtension
 * @author Set Protocol
 *
 * Smart contract global extension which provides DelegatedManager owner and 
 * methodologist the ability to accrue and split issuance and redemption fees.
 * Owner may configure the fee split percentages.
 */
contract BasicIssuanceExtension is BaseGlobalExtension {
    using Address for address;
    using PreciseUnitMath for uint256;
    using SafeMath for uint256;

    /* ============ Events ============ */

    event BasicIssuanceExtensionInitialized(
        address indexed _setToken,
        address indexed _delegatedManager
    );

    event BasicIssuanceExtensionRemoved(
        address indexed _setToken,
        address indexed _delegatedManager
    );

    event FeesDistributed(
        address _setToken,
        address indexed _ownerFeeRecipient,
        address indexed _methodologist,
        uint256 _ownerTake,
        uint256 _methodologistTake
    );

    /* ============ State Variables ============ */

    // Instance of BasicIssuanceModule
    IIssuanceModule public immutable issuanceModule;

    // Mapping from Set Token to DelegatedManager 
    mapping(ISetToken => IDelegatedManager) public setManagers;

    /* ============ Constructor ============ */

    constructor(
        IManagerCore _managerCore,
        IIssuanceModule _issuanceModule
    )
        public
        BaseGlobalExtension(_managerCore)
    {
        issuanceModule = _issuanceModule;
    }

    /* ============ External Functions ============ */

    /**
     * ANYONE CALLABLE: Distributes fees accrued to the DelegatedManager. Calculates fees for
     * owner and methodologist, and sends to owner fee recipient and methodologist respectively.
     */
    function distributeFees(ISetToken _setToken) public {
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
     * ONLY OWNER: Initializes BasicIssuanceExtension to the DelegatedManager.
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

        BasicIssuanceExtensionInitialized(address(setToken), address(_delegatedManager));
    }

    /**
     * ONLY OWNER: Initializes BasicIssuanceExtension to the DelegatedManager and BasicIssuanceModule to the SetToken
     *
     * @param _delegatedManager             Instance of the DelegatedManager to initialize
     * @param _maxManagerFee                Maximum fee that can be charged on issue and redeem
     * @param _managerIssueFee              Fee to charge on issuance
     * @param _managerRedeemFee             Fee to charge on redemption
     * @param _feeRecipient                 Address to send fees to
     * @param _managerIssuanceHook          Instance of the Manager Contract with the Pre-Issuance Hook function
     */
    function initializeModuleAndExtension(
        IDelegatedManager _delegatedManager,
        uint256 _maxManagerFee,
        uint256 _managerIssueFee,
        uint256 _managerRedeemFee,
        address _feeRecipient,
        address _managerIssuanceHook
    ) 
        external 
    {
        require(msg.sender == _delegatedManager.owner(), "Must be owner");
        require(_delegatedManager.isPendingExtension(address(this)), "Extension must be pending");

        ISetToken setToken = _delegatedManager.setToken();

        setManagers[setToken] = _delegatedManager;

        _delegatedManager.initializeExtension();

        bytes memory callData = abi.encodeWithSignature(
            "initialize(address,uint256,uint256,uint256,address,address)", 
            setToken,
            _maxManagerFee,
            _managerIssueFee,
            _managerRedeemFee,
            _feeRecipient,
            _managerIssuanceHook
        );
        _invokeManager(setToken, address(issuanceModule), callData);

        BasicIssuanceExtensionInitialized(address(setToken), address(_delegatedManager));
    }

    /**
     * ONLY MANAGER: Remove an existing SetToken and DelegatedManager tracked by the TradeExtension 
     */
    function removeExtension() external override {
        IDelegatedManager delegatedManager = IDelegatedManager(msg.sender);
        ISetToken setToken = delegatedManager.setToken();

        require(msg.sender == address(_manager(setToken)), "Must be Manager");

        delete setManagers[setToken];

        BasicIssuanceExtensionRemoved(address(setToken), address(delegatedManager));
    }

    /**
     * ONLY OWNER: Updates issuance fee on BasicIssuanceModule.
     *
     * @param _setToken     Instance of the SetToken to update issue fee for
     * @param _newFee       New issue fee percentage in precise units (1% = 1e16, 100% = 1e18)
     */
    function updateIssueFee(ISetToken _setToken, uint256 _newFee)
        external
        onlyOwner(_setToken)
    {
        bytes memory callData = abi.encodeWithSignature("updateIssueFee(address,uint256)", _setToken, _newFee);
        _invokeManager(_setToken, address(issuanceModule), callData);
    }

    /**
     * ONLY OWNER: Updates redemption fee on BasicIssuanceModule.
     *
     * @param _setToken     Instance of the SetToken to update redeem fee for
     * @param _newFee       New redeem fee percentage in precise units (1% = 1e16, 100% = 1e18)
     */
    function updateRedeemFee(ISetToken _setToken, uint256 _newFee)
        external
        onlyOwner(_setToken)
    {
        bytes memory callData = abi.encodeWithSignature("updateRedeemFee(address,uint256)", _setToken, _newFee);
        _invokeManager(_setToken, address(issuanceModule), callData);
    }

    /**
     * ONLY OWNER: Updates fee recipient on BasicIssuanceModule
     *
     * @param _setToken         Instance of the SetToken to update fee recipient for
     * @param _newFeeRecipient  Address of new fee recipient. This should be the address of the DelegatedManager
     */
    function updateFeeRecipient(ISetToken _setToken, address _newFeeRecipient)
        external
        onlyOwner(_setToken)
    {
        bytes memory callData = abi.encodeWithSignature("updateFeeRecipient(address,address)", _setToken, _newFeeRecipient);
        _invokeManager(_setToken, address(issuanceModule), callData);
    }

    /* ============ Internal Functions ============ */

    /**
     * Internal function to grab manager of passed SetToken from BasicIssuanceExtension data structure.
     *
     * @param _setToken         SetToken who's manager is needed 
     */
    function _manager(ISetToken _setToken) internal override view returns (IDelegatedManager) {
        return setManagers[_setToken];
    }
}