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

contract ManagerFactory {
    struct InitializeParams{
        address initializer;
        address owner;
    }
    
    address public factory;
    mapping(address=>InitializeParams) public initialize;

    constructor(
        address _setTokenFactory
    ) public {
        factory = _setTokenFactory;
    }

    function create(
        address[] memory _components,
        uint256 _units,
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
    {
        address setTokenAddress = _deploySet(
            _components,
            _modules,
            _units,
            _name,
            _symbol
        );

        _deployManager(
            setTokenAddress,
            _methodologist,
            _operators,
            _assets,
            _extensions
        );

        initialize[setTokenAddress] = InitializeParams({
            initializer: msg.sender,
            owner: _owner
        });
    }

    function _deploySet(
        address[] memory _components,
        address[] memory _modules,
        uint256 _units,
        string memory _name,
        string memory _symbol
    )
        internal
        returns (address)
    {}

    function _deployManager(
        address _setTokenAddress,
        address _methodologist,
        address[] memory _operators,
        address[] memory _assets,
        address[] memory _extensions
    )
        internal
        returns (address)
    {}
}