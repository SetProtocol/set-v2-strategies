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
import { ITradeModule } from "@setprotocol/set-protocol-v2/contracts/interfaces/ITradeModule.sol";

import { BaseGlobalExtension } from "../lib/BaseGlobalExtension.sol";
import { IDelegatedManager } from "../interfaces/IDelegatedManager.sol";
import { IManagerCore } from "../interfaces/IManagerCore.sol";

/**
 * @title BatchTradeExtension
 * @author Set Protocol
 *
 * Smart contract global extension which provides DelegatedManager operator(s) the ability to execute a batch of trades
 * on a DEX and the owner the ability to restrict operator(s) permissions with an asset whitelist.
 */
contract BatchTradeExtension is BaseGlobalExtension {

    /* ============ Structs ============ */

    struct TradeInfo {
        string exchangeName;             // Human readable name of the exchange in the integrations registry
        address sendToken;               // Address of the token to be sent to the exchange
        uint256 sendQuantity;            // Max units of `sendToken` sent to the exchange
        address receiveToken;            // Address of the token that will be received from the exchange
        uint256 receiveQuantity;         // Min units of `receiveToken` to be received from the exchange
        bytes data;                      // Arbitrary bytes to be used to construct trade call data
    }

    /* ============ Events ============ */

    event BatchTradeExtensionInitialized(
        address indexed _setToken,                 // Address of the SetToken which had BatchTradeExtension initialized on their manager
        address indexed _delegatedManager          // Address of the DelegatedManager which initialized the BatchTradeExtension
    );

    event StringTradeFailed(
        address indexed _setToken,       // Address of the SetToken which the failed trade targeted
        uint256 indexed _index,          // Index of trade that failed in _trades parameter of batchTrade call
        string _reason,                  // String reason for the trade failure
        string exchangeName,             // Human readable name of the exchange in the integrations registry
        address sendToken,               // Address of the token to be sent to the exchange
        uint256 sendQuantity,            // Max units of `sendToken` sent to the exchange
        address receiveToken,            // Address of the token that will be received from the exchange
        uint256 receiveQuantity,         // Min units of `receiveToken` to be received from the exchange
        bytes data                       // Arbitrary bytes to be used to construct trade call data
    );

    event BytesTradeFailed(
        address indexed _setToken,       // Address of the SetToken which the failed trade targeted
        uint256 indexed _index,          // Index of trade that failed in _trades parameter of batchTrade call
        bytes _lowLevelData,             // Bytes low level data reason for the trade failure
        string exchangeName,             // Human readable name of the exchange in the integrations registry
        address sendToken,               // Address of the token to be sent to the exchange
        uint256 sendQuantity,            // Max units of `sendToken` sent to the exchange
        address receiveToken,            // Address of the token that will be received from the exchange
        uint256 receiveQuantity,         // Min units of `receiveToken` to be received from the exchange
        bytes data                       // Arbitrary bytes to be used to construct trade call data
    );

    /* ============ State Variables ============ */

    // Instance of TradeModule
    ITradeModule public immutable tradeModule;

    /* ============ Constructor ============ */

    /**
     * Instantiate with ManagerCore and TradeModule addresses.
     *
     * @param _managerCore              Address of ManagerCore contract
     * @param _tradeModule              Address of TradeModule contract
     */
    constructor(
        IManagerCore _managerCore,
        ITradeModule _tradeModule
    )
        public
        BaseGlobalExtension(_managerCore)
    {
        tradeModule = _tradeModule;
    }

    /* ============ External Functions ============ */

    /**
     * ONLY OWNER: Initializes TradeModule on the SetToken associated with the DelegatedManager.
     *
     * @param _delegatedManager     Instance of the DelegatedManager to initialize the TradeModule for
     */
    function initializeModule(IDelegatedManager _delegatedManager) external onlyOwnerAndValidManager(_delegatedManager) {
        _initializeModule(_delegatedManager.setToken(), _delegatedManager);
    }

    /**
     * ONLY OWNER: Initializes BatchTradeExtension to the DelegatedManager.
     *
     * @param _delegatedManager     Instance of the DelegatedManager to initialize
     */
    function initializeExtension(IDelegatedManager _delegatedManager) external onlyOwnerAndValidManager(_delegatedManager) {
        ISetToken setToken = _delegatedManager.setToken();

        _initializeExtension(setToken, _delegatedManager);

        emit BatchTradeExtensionInitialized(address(setToken), address(_delegatedManager));
    }

    /**
     * ONLY OWNER: Initializes BatchTradeExtension to the DelegatedManager and TradeModule to the SetToken
     *
     * @param _delegatedManager     Instance of the DelegatedManager to initialize
     */
    function initializeModuleAndExtension(IDelegatedManager _delegatedManager) external onlyOwnerAndValidManager(_delegatedManager){
        ISetToken setToken = _delegatedManager.setToken();

        _initializeExtension(setToken, _delegatedManager);
        _initializeModule(setToken, _delegatedManager);

        emit BatchTradeExtensionInitialized(address(setToken), address(_delegatedManager));
    }

    /**
     * ONLY MANAGER: Remove an existing SetToken and DelegatedManager tracked by the BatchTradeExtension
     */
    function removeExtension() external override {
        IDelegatedManager delegatedManager = IDelegatedManager(msg.sender);
        ISetToken setToken = delegatedManager.setToken();

        _removeExtension(setToken, delegatedManager);
    }

    /**
     * ONLY OPERATOR: Executes a batch of trades on a supported DEX. If any individual trades fail, events are emitted.
     * @dev Although the SetToken units are passed in for the send and receive quantities, the total quantity
     * sent and received is the quantity of component units multiplied by the SetToken totalSupply.
     *
     * @param _setToken             Instance of the SetToken to trade
     * @param _trades               Array of TradeInfo structs containing information about trades
     */
    function batchTrade(
        ISetToken _setToken,
        TradeInfo[] memory _trades
    )
        external
        onlyOperator(_setToken)
    {
        uint256 tradesLength = _trades.length;
        IDelegatedManager manager = _manager(_setToken);
        for(uint256 i = 0; i < tradesLength; i++) {
            require(manager.isAllowedAsset(_trades[i].receiveToken), "Must be allowed asset");

            bytes memory callData = abi.encodeWithSelector(
                ITradeModule.trade.selector,
                _setToken,
                _trades[i].exchangeName,
                _trades[i].sendToken,
                _trades[i].sendQuantity,
                _trades[i].receiveToken,
                _trades[i].receiveQuantity,
                _trades[i].data
            );

            // ZeroEx (for example) throws custom errors which slip through OpenZeppelin's
            // functionCallWithValue error management and surface here as `bytes`. These should be
            // decode-able off-chain given enough context about protocol targeted by the adapter.
            try manager.interactManager(address(tradeModule), callData) {}
            catch Error(string memory reason) {
                emit StringTradeFailed(
                    address(_setToken),
                    i,
                    reason,
                    _trades[i].exchangeName,
                    _trades[i].sendToken,
                    _trades[i].sendQuantity,
                    _trades[i].receiveToken,
                    _trades[i].receiveQuantity,
                    _trades[i].data
                );
            } catch (bytes memory lowLevelData) {
                emit BytesTradeFailed(
                    address(_setToken),
                    i,
                    lowLevelData,
                    _trades[i].exchangeName,
                    _trades[i].sendToken,
                    _trades[i].sendQuantity,
                    _trades[i].receiveToken,
                    _trades[i].receiveQuantity,
                    _trades[i].data
                );
            }
        }
    }

    /* ============ Internal Functions ============ */

    /**
     * Internal function to initialize TradeModule on the SetToken associated with the DelegatedManager.
     *
     * @param _setToken             Instance of the SetToken corresponding to the DelegatedManager
     * @param _delegatedManager     Instance of the DelegatedManager to initialize the TradeModule for
     */
    function _initializeModule(ISetToken _setToken, IDelegatedManager _delegatedManager) internal {
        bytes memory callData = abi.encodeWithSelector(ITradeModule.initialize.selector, _setToken);
        _invokeManager(_delegatedManager, address(tradeModule), callData);
    }
}