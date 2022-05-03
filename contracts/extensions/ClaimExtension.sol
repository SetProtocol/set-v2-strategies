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

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { ISetToken } from "@setprotocol/set-protocol-v2/contracts/interfaces/ISetToken.sol";
import { IAirdropModule } from "../interfaces/IAirdropModule.sol";
import { IClaimModule } from "../interfaces/IClaimModule.sol";
import { IClaimAdapter } from "@setprotocol/set-protocol-v2/contracts/interfaces/IClaimAdapter.sol";
import { IIntegrationRegistry } from "@setprotocol/set-protocol-v2/contracts/interfaces/IIntegrationRegistry.sol";

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

    /* ============ Modifiers ============ */

    modifier onlyAllowedAssets(ISetToken _setToken, address[] memory _assets) {
        IDelegatedManager manager = _manager(_setToken);
        if (!manager.useAssetAllowlist()) {
            _;
        }
        else {
            uint256 assetsLength = _assets.length;
            for (uint i = 0; i < assetsLength; i++) {
                require(manager.assetAllowlist(_assets[i]), "Must be allowed asset");
            }
            _;
        }
    }

    /**
     * Throws if anyoneAbsorb on the AirdropModule is false and caller is not the operator
     */
    modifier onlyValidAbsorbCaller(ISetToken _setToken) {
        require(_isValidAbsorbCaller(_setToken), "Must be valid AirdropModule absorb caller");
        _;
    }

    /**
     * Throws if caller is not the operator and either anyoneAbsorb on the AirdropModule or anyoneClaim on the ClaimModule is false
     */
    modifier onlyValidClaimAndAbsorbCaller(ISetToken _setToken) {
        require(_isValidClaimAndAbsorbCaller(_setToken), "Must be valid AirdropModule absorb and ClaimModule claim caller");
        _;
    }

    /* ============ State Variables ============ */

    // Instance of AirdropModule
    IAirdropModule public immutable airdropModule;

    // Instance of ClaimModule
    IClaimModule public immutable claimModule;

    // Instance of IntegrationRegistry
    IIntegrationRegistry public immutable integrationRegistry;

    /* ============ Constructor ============ */

    /**
     * Instantiate with ManagerCore, AirdropModule, ClaimModule, and Controller addresses.
     *
     * @param _managerCore              Address of ManagerCore contract
     * @param _airdropModule            Address of AirdropModule contract
     * @param _claimModule              Address of ClaimModule contract
     * @param _integrationRegistry      Address of IntegrationRegistry contract
     */
    constructor(
        IManagerCore _managerCore,
        IAirdropModule _airdropModule,
        IClaimModule _claimModule,
        IIntegrationRegistry _integrationRegistry
    )
        public
        BaseGlobalExtension(_managerCore)
    {
        airdropModule = _airdropModule;
        claimModule = _claimModule;
        integrationRegistry = _integrationRegistry;
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

    /**
     * ONLY VALID ABSORB CALLER: Absorb passed tokens into respective positions. If airdropFee defined, send portion to feeRecipient
     * and portion to protocol feeRecipient address. Callable only by operator unless set anyoneAbsorb is true on the AirdropModule.
     *
     * @param _setToken                 Address of SetToken
     * @param _tokens                   Array of tokens to absorb
     */
    function batchAbsorb(
        ISetToken _setToken,
        address[] memory _tokens
    )
        external
        onlyValidAbsorbCaller(_setToken)
        onlyAllowedAssets(_setToken, _tokens)
    {
        bytes memory callData = abi.encodeWithSelector(
            IAirdropModule.batchAbsorb.selector,
            _setToken,
            _tokens
        );
        _invokeManager(_manager(_setToken), address(airdropModule), callData);
    }

    /**
     * ONLY VALID ABSORB CALLER: Absorb specified token into position. If airdropFee defined, send portion to feeRecipient and portion to
     * protocol feeRecipient address. Callable only by operator unless anyoneAbsorb is true on the AirdropModule.
     *
     * @param _setToken                 Address of SetToken
     * @param _token                    Address of token to absorb
     */
    function absorb(
        ISetToken _setToken,
        IERC20 _token
    )
        external
        onlyValidAbsorbCaller(_setToken)
        onlyAllowedAsset(_setToken, address(_token))
    {
        bytes memory callData = abi.encodeWithSelector(
            IAirdropModule.absorb.selector,
            _setToken,
            _token
        );
        _invokeManager(_manager(_setToken), address(airdropModule), callData);
    }

    /**
     * ONLY OWNER: Adds new tokens to be added to positions when absorb is called.
     *
     * @param _setToken                 Address of SetToken
     * @param _airdrop                  Component to add to airdrop list
     */
    function addAirdrop(
        ISetToken _setToken,
        IERC20 _airdrop
    )
        external
        onlyOwner(_setToken)
    {
        bytes memory callData = abi.encodeWithSelector(
            IAirdropModule.addAirdrop.selector,
            _setToken,
            _airdrop
        );
        _invokeManager(_manager(_setToken), address(airdropModule), callData);
    }

    /**
     * ONLY OWNER: Removes tokens from list to be absorbed.
     *
     * @param _setToken                 Address of SetToken
     * @param _airdrop                  Component to remove from airdrop list
     */
    function removeAirdrop(
        ISetToken _setToken,
        IERC20 _airdrop
    )
        external
        onlyOwner(_setToken)
    {
        bytes memory callData = abi.encodeWithSelector(
            IAirdropModule.removeAirdrop.selector,
            _setToken,
            _airdrop
        );
        _invokeManager(_manager(_setToken), address(airdropModule), callData);
    }

    /**
     * ONLY OWNER: Update whether manager allows other addresses to call absorb.
     *
     * @param _setToken                 Address of SetToken
     */
    function updateAnyoneAbsorb(
        ISetToken _setToken,
        bool _anyoneAbsorb
    )
        external
        onlyOwner(_setToken)
    {
        bytes memory callData = abi.encodeWithSelector(
            IAirdropModule.updateAnyoneAbsorb.selector,
            _setToken,
            _anyoneAbsorb
        );
        _invokeManager(_manager(_setToken), address(airdropModule), callData);
    }

    /**
     * ONLY OWNER: Update address AirdropModule manager fees are sent to.
     *
     * @param _setToken             Address of SetToken
     * @param _newFeeRecipient      Address of new fee recipient
     */
    function updateAirdropFeeRecipient(
        ISetToken _setToken,
        address _newFeeRecipient
    )
        external
        onlyOwner(_setToken)
    {
        bytes memory callData = abi.encodeWithSelector(
            IAirdropModule.updateFeeRecipient.selector,
            _setToken,
            _newFeeRecipient
        );
        _invokeManager(_manager(_setToken), address(airdropModule), callData);
    }

    /**
     * ONLY OWNER: Update airdrop fee percentage.
     *
     * @param _setToken         Address of SetToken
     * @param _newFee           Percentage, in preciseUnits, of new airdrop fee (1e16 = 1%)
     */
    function updateAirdropFee(
        ISetToken _setToken,
        uint256 _newFee
    )
        external
        onlyOwner(_setToken)
    {
        bytes memory callData = abi.encodeWithSelector(
            IAirdropModule.updateAirdropFee.selector,
            _setToken,
            _newFee
        );
        _invokeManager(_manager(_setToken), address(airdropModule), callData);
    }

    /**
     * ONLY VALID CLAIM AND ABSORB CALLER: Claim the rewards available on the rewardPool for the specified claim integration and absorb
     * the reward token into position. If airdropFee defined, send portion to feeRecipient and portion to protocol feeRecipient address.
     * Callable only by operator unless anyoneAbsorb on the AirdropModule and anyoneClaim on the ClaimModule are true.
     *
     * @param _setToken                 Address of SetToken
     * @param _rewardPool               Address of the rewardPool that identifies the contract governing claims
     * @param _integrationName          ID of claim module integration (mapping on integration registry)
     */
    function claimAndAbsorb(
        ISetToken _setToken,
        address _rewardPool,
        string calldata _integrationName
    )
        external
        onlyValidClaimAndAbsorbCaller(_setToken)
    {
        IClaimAdapter adapter = IClaimAdapter(integrationRegistry.getIntegrationAdapter(address(claimModule), _integrationName));
        IERC20 rewardsToken = adapter.getTokenAddress(_rewardPool);

        require(_manager(_setToken).isAllowedAsset(address(rewardsToken)), "Must be allowed asset");

        bytes memory claimCallData = abi.encodeWithSelector(
            IClaimModule.claim.selector,
            _setToken,
            _rewardPool,
            _integrationName
        );
        _invokeManager(_manager(_setToken), address(claimModule), claimCallData);

        bytes memory absorbCallData = abi.encodeWithSelector(
            IAirdropModule.absorb.selector,
            _setToken,
            rewardsToken
        );
        _invokeManager(_manager(_setToken), address(airdropModule), absorbCallData);
    }

    /**
     * ONLY VALID CLAIM AND ABSORB CALLER: Claims rewards on all the passed rewardPool/claim integration pairs and absorb the reward tokens
     * into positions. If airdropFee defined, send portion of each reward token to feeRecipient and a portion to protocol feeRecipient address.
     * Callable only by operator unless anyoneAbsorb on the AirdropModule and anyoneClaim on the ClaimModule are true.
     *
     * @param _setToken                 Address of SetToken
     * @param _rewardPools          Addresses of rewardPools that identifies the contract governing claims. Maps to same index integrationNames
     * @param _integrationNames     Human-readable names matching adapter used to collect claim on pool. Maps to same index in rewardPools
     */
    function batchClaimAndAbsorb(
        ISetToken _setToken,
        address[] calldata _rewardPools,
        string[] calldata _integrationNames
    )
        external
        onlyValidClaimAndAbsorbCaller(_setToken)
    {
        bytes memory claimCallData = abi.encodeWithSelector(
            IClaimModule.batchClaim.selector,
            _setToken,
            _rewardPools,
            _integrationNames
        );
        _invokeManager(_manager(_setToken), address(claimModule), claimCallData);

        address[] storage uniqueRewardsTokens;
        uint256 numPools = _rewardPools.length;
        for (uint256 i = 0; i < numPools; i++) {
            IClaimAdapter adapter = IClaimAdapter(integrationRegistry.getIntegrationAdapter(address(claimModule), _integrationNames[i]));
            address rewardsToken = address(adapter.getTokenAddress(_rewardPools[i]));
            require(_manager(_setToken).isAllowedAsset(rewardsToken), "Must be allowed asset");
            uniqueRewardsTokens.push(rewardsToken);
        }

        bytes memory absorbCallData = abi.encodeWithSelector(
            IAirdropModule.batchAbsorb.selector,
            _setToken,
            uniqueRewardsTokens
        );
        _invokeManager(_manager(_setToken), address(airdropModule), absorbCallData);
    }

    /**
     * ONLY OWNER: Update whether manager allows other addresses to call claim.
     *
     * @param _setToken             Address of SetToken
     */
    function updateAnyoneClaim(
        ISetToken _setToken,
        bool _anyoneClaim
    )
        external
        onlyOwner(_setToken)
    {
        bytes memory callData = abi.encodeWithSelector(
            IClaimModule.updateAnyoneClaim.selector,
            _setToken,
            _anyoneClaim
        );
        _invokeManager(_manager(_setToken), address(claimModule), callData);
    }

    /**
     * ONLY OWNER: Adds a new claim integration for an existent rewardPool. If rewardPool doesn't have existing
     * claims then rewardPool is added to rewardPoolLiost. The claim integration is associated to an adapter that
     * provides the functionality to claim the rewards for a specific token.
     *
     * @param _setToken             Address of SetToken
     * @param _rewardPool           Address of the rewardPool that identifies the contract governing claims
     * @param _integrationName      ID of claim module integration (mapping on integration registry)
     */
    function addClaim(
        ISetToken _setToken,
        address _rewardPool,
        string calldata _integrationName
    )
        external
        onlyOwner(_setToken)
    {
        bytes memory callData = abi.encodeWithSelector(
            IClaimModule.addClaim.selector,
            _setToken,
            _rewardPool,
            _integrationName
        );
        _invokeManager(_manager(_setToken), address(claimModule), callData);
    }

    /**
     * ONLY OWNER: Adds a new rewardPool to the list to perform claims for the SetToken indicating the list of
     * claim integrations. Each claim integration is associated to an adapter that provides the functionality to claim
     * the rewards for a specific token.
     *
     * @param _setToken             Address of SetToken
     * @param _rewardPools          Addresses of rewardPools that identifies the contract governing claims. Maps to same
     *                                  index integrationNames
     * @param _integrationNames     Human-readable names matching adapter used to collect claim on pool. Maps to same index
     *                                  in rewardPools
     */
    function batchAddClaim(
        ISetToken _setToken,
        address[] calldata _rewardPools,
        string[] calldata _integrationNames
    )
        external
        onlyOwner(_setToken)
    {
        bytes memory callData = abi.encodeWithSelector(
            IClaimModule.batchAddClaim.selector,
            _setToken,
            _rewardPools,
            _integrationNames
        );
        _invokeManager(_manager(_setToken), address(claimModule), callData);
    }

    /**
     * ONLY OWNER: Removes a claim integration from an existent rewardPool. If no claim remains for reward pool then
     * reward pool is removed from rewardPoolList.
     *
     * @param _setToken             Address of SetToken
     * @param _rewardPool           Address of the rewardPool that identifies the contract governing claims
     * @param _integrationName      ID of claim module integration (mapping on integration registry)
     */
    function removeClaim(
        ISetToken _setToken,
        address _rewardPool,
        string calldata _integrationName
    )
        external
        onlyOwner(_setToken)
    {
        bytes memory callData = abi.encodeWithSelector(
            IClaimModule.removeClaim.selector,
            _setToken,
            _rewardPool,
            _integrationName
        );
        _invokeManager(_manager(_setToken), address(claimModule), callData);
    }

    /**
     * ONLY OWNER: Batch removes claims from SetToken's settings.
     *
     * @param _setToken             Address of SetToken
     * @param _rewardPools          Addresses of rewardPools that identifies the contract governing claims. Maps to same index
     *                                  integrationNames
     * @param _integrationNames     Human-readable names matching adapter used to collect claim on pool. Maps to same index in
     *                                  rewardPools
     */
    function batchRemoveClaim(
        ISetToken _setToken,
        address[] calldata _rewardPools,
        string[] calldata _integrationNames
    )
        external
        onlyOwner(_setToken)
    {
        bytes memory callData = abi.encodeWithSelector(
            IClaimModule.batchRemoveClaim.selector,
            _setToken,
            _rewardPools,
            _integrationNames
        );
        _invokeManager(_manager(_setToken), address(claimModule), callData);
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

    function _isValidAbsorbCaller(ISetToken _setToken) internal view returns(bool) {
        return airdropModule.airdropSettings(_setToken).anyoneAbsorb || _manager(_setToken).operatorAllowlist(msg.sender);
    }

    function _isValidClaimAndAbsorbCaller(ISetToken _setToken) internal view returns(bool) {
        return (
            (claimModule.anyoneClaim(_setToken) && airdropModule.airdropSettings(_setToken).anyoneAbsorb)
            || _manager(_setToken).operatorAllowlist(msg.sender)
        );
    }
}