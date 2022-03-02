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

import { BaseGlobalExtension } from "../lib/BaseGlobalExtension.sol";
import { IDelegatedManager } from "../interfaces/IDelegatedManager.sol";
import { ISetToken } from "../interfaces/ISetToken.sol";
import { ITradeModule } from "../interfaces/ITradeModule.sol";

/**
 * @title TradeExtension
 * @author Set Protocol
 *
 * Smart contract global extension privileged operator(s) from a DelegatedManager the ability 
 * to trade on a DEX and the owner the ability to restrict operator(s) permissions with an asset whitelist.
 */
contract TradeExtension is BaseGlobalExtension {

    /* ============ Events ============ */

    event ExtensionInitialized(
        address _setToken,
        address _delegatedManager
    );

    /* ============ State Variables ============ */

    // Instance of TradeModule
    ITradeModule public immutable tradeModule;

    // Mapping from Set Token to DelegatedManager 
    mapping(ISetToken => IDelegatedManager) public setManagers;

    /* ============ Constructor ============ */

    constructor(
        ITradeModule _tradeModule
    )
        public
    {
        tradeModule = _tradeModule;
    }

    /* ============ External Functions ============ */

    /**
     * ONLY OWNER: Initializes TradeExtension to the DelegatedManager.
     *
     * @param _delegatedManager     Instance of the DelegatedManager to initialize
     */
    function initializeExtension(IDelegatedManager _delegatedManager) public {
        require(msg.sender == _delegatedManager.owner(), "Must be owner");
        require(_delegatedManager.isPendingExtension(address(this)), "Extension must be pending");

        setManagers[_delegatedManager.setToken()] = _delegatedManager;

        _delegatedManager.initializeExtension();

        ExtensionInitialized(address(_delegatedManager.setToken()), address(_delegatedManager));
    }

    /**
     * ONLY OWNER: Initializes TradeExtension to the DelegatedManager and TradeModule to the SetToken
     *
     * @param _delegatedManager     Instance of the DelegatedManager to initialize
     */
    function initializeModuleAndExtension(IDelegatedManager _delegatedManager) external {
        require(msg.sender == _delegatedManager.owner(), "Must be owner");
        require(_delegatedManager.setToken().isPendingModule(address(tradeModule)), "TradeModule must be pending");
        require(_delegatedManager.isPendingExtension(address(this)), "Extension must be pending");

        initializeExtension(_delegatedManager);

        _delegatedManager.initializeExtension();

        tradeModule.initialize(_delegatedManager.setToken());

        ExtensionInitialized(address(_delegatedManager.setToken()), address(_delegatedManager));
    }

    /**
     * ONLY OWNER: Remove an existing SetToken and DelegatedManager tracked by the TradeExtension 
     *
     * @param _setToken     Instance of the SetToken to remove
     */
    function removeExtension(ISetToken _setToken) external override onlyOwner(_setToken) {
        require(address(setManagers[_setToken]) != address(0), "Must be existing Set Token");
        delete setManagers[_setToken];
    }

    /**
     * ONLY OPERATOR: Executes a trade on a supported DEX.
     * @dev Although the SetToken units are passed in for the send and receive quantities, the total quantity
     * sent and received is the quantity of SetToken units multiplied by the SetToken totalSupply.
     *
     * @param _setToken             Instance of the SetToken to trade
     * @param _exchangeName         Human readable name of the exchange in the integrations registry
     * @param _sendToken            Address of the token to be sent to the exchange
     * @param _sendQuantity         Units of token in SetToken sent to the exchange
     * @param _receiveToken         Address of the token that will be received from the exchange
     * @param _minReceiveQuantity   Min units of token in SetToken to be received from the exchange
     * @param _data                 Arbitrary bytes to be used to construct trade call data
     */
    function trade(
        ISetToken _setToken,
        string memory _exchangeName,
        address _sendToken,
        uint256 _sendQuantity,
        address _receiveToken,
        uint256 _minReceiveQuantity,
        bytes memory _data
    )
        external
        onlyOperator(_setToken)
    {
        tradeModule.trade(
            _setToken,
            _exchangeName,
            _sendToken,
            _sendQuantity,
            _receiveToken,
            _minReceiveQuantity,
            _data
        );
    }

    /* ============ Internal Functions ============ */

    /**
     * Internal function to grab manager of passed SetToken from TradeExtensions data structure.
     *
     * @param _setToken         SetToken who's manager is needed 
     */
    function _manager(ISetToken _setToken) internal override view returns (IDelegatedManager) {
        return setManagers[_setToken];
    }
}