/*
 * Deploy Hardhat Network State for Subgraph Tests
 * -----------------------------------------------
 * Deploy a test environment to hardhat for subgraph development
 *
 * Setup
 * - Deploy system
 * - Deploy ManagerCore
 * - Deploy DelegatedManagerFactory
 * - Deploy IssuanceExtension with IssuanceModule
 * - Deploy StreamingFeeSplitExtension
 * - Deploy TradeExtension and TradeModule
 * - Initialize ManagerCore
 *
 * Case 1: DelegatedManagerFactory deployed DelegatedManager and SetToken
 * - Deploy DelegatedManager and SetToken through DelegatedManagerFactory
 * - Initialize DelegatedManager through DelegatedManagerFactory
 * - Update owner
 * - Update methodologist
 * - Add operatorTwo
 * - Remove operatorOne
 *
 * Case 2: DelegatedManagerFactory deployed DelegatedManager with migrating SetToken
 * - Deploy SetToken through SetTokenCreator
 * - Deploy DelegatedManager through DelegatedManagerFactory
 * - Initialize DelegatedManager through DelegatedManagerFactory
 *
 * Case 3: DelegatedManagerFactory deployed DelegatedManager and SetToken, migrate to EOA manager
 * - Deploy DelegatedManager and SetToken through DelegatedManagerFactory
 * - Initialize DelegatedManager through DelegatedManagerFactory
 * - Remove extensions from DelegatedManager
 * - Change SetToken manager to EOA manager
 *
 * Case 4: EOA managed SetToken
 * - Deploy SetToken through SetTokenCreator
 */

import "module-alias/register";
import { getSystemFixture, getProtocolUtils } from "@setprotocol/set-protocol-v2/dist/utils/test/index";
import DeployHelper from "@utils/deploys";
import {
  ether,
  getAccounts,
} from "@utils/index";
import { ADDRESS_ZERO, ZERO } from "@utils/constants";
import { StreamingFeeState } from "@utils/types";


async function main() {

  console.log("Starting deployment");

  const [
    ownerOne,
    ownerTwo,
    methodologistOne,
    methodologistTwo,
    operatorOne,
    operatorTwo,
    otherManager,
  ] = await getAccounts();

  // Setup
  // -----------------------------------------------

  // Deploy system
  const deployer = new DeployHelper(ownerOne.wallet);
  const protocolUtils = getProtocolUtils();
  const setV2Setup = getSystemFixture(ownerOne.address);
  await setV2Setup.initialize();

  // Deploy ManagerCore
  const managerCore = await deployer.managerCore.deployManagerCore();

  // Deploy DelegatedManagerFactory
  const delegatedManagerFactory = await deployer.factories.deployDelegatedManagerFactory(
    managerCore.address,
    setV2Setup.controller.address,
    setV2Setup.factory.address
  );

  // Deploy IssuanceExtension with IssuanceModule
  const issuanceModule = await deployer.setV2.deployIssuanceModule(setV2Setup.controller.address);
  await setV2Setup.controller.addModule(issuanceModule.address);
  const issuanceExtension = await deployer.globalExtensions.deployIssuanceExtension(
    managerCore.address,
    issuanceModule.address
  );

  // Deploy StreamingFeeSplitExtension
  const streamingFeeSplitExtension = await deployer.globalExtensions.deployStreamingFeeSplitExtension(
    managerCore.address,
    setV2Setup.streamingFeeModule.address
  );

  // Deploy TradeExtension and TradeModule
  const tradeModule = await deployer.setDeployer.modules.deployTradeModule(setV2Setup.controller.address);
  await setV2Setup.controller.addModule(tradeModule.address);
  const tradeExtension = await deployer.globalExtensions.deployTradeExtension(
    managerCore.address,
    tradeModule.address
  );

  // Initialize ManagerCore
  await managerCore.initialize(
    [issuanceExtension.address, streamingFeeSplitExtension.address, tradeExtension.address],
    [delegatedManagerFactory.address]
  );

  // Case 1: DelegatedManagerFactory deployed DelegatedManager and SetToken
  // -----------------------------------------------

  // Deploy DelegatedManager and SetToken through DelegatedManagerFactory
  const txOne = await delegatedManagerFactory.connect(ownerOne.wallet).createSetAndManager(
    [setV2Setup.dai.address, setV2Setup.wbtc.address],
    [ether(1), ether(.1)],
    "TestTokenOne",
    "TT1",
    ownerOne.address,
    methodologistOne.address,
    [issuanceModule.address, setV2Setup.streamingFeeModule.address, tradeModule.address],
    [operatorOne.address],
    [setV2Setup.dai.address, setV2Setup.wbtc.address],
    [issuanceExtension.address, streamingFeeSplitExtension.address, tradeExtension.address]
  );

  const setTokenOneAddress = await protocolUtils.getCreatedSetTokenAddress(txOne.hash);
  const initializeParamsOne = await delegatedManagerFactory.initializeState(setTokenOneAddress);
  const delegatedManagerOne = await deployer.manager.getDelegatedManager(initializeParamsOne.manager);

  // Initialize DelegatedManager through DelegatedManagerFactory
  const issuanceExtensionOneBytecode = issuanceExtension.interface.encodeFunctionData(
    "initializeModuleAndExtension",
    [
      delegatedManagerOne.address,
      ether(0.1),
      ether(0.01),
      ether(0.01),
      delegatedManagerOne.address,
      ADDRESS_ZERO
    ]
  );

  const feeSettingsOne = {
    feeRecipient: delegatedManagerOne.address,
    maxStreamingFeePercentage: ether(0.05),
    streamingFeePercentage: ether(0.01),
    lastStreamingFeeTimestamp: ZERO,
  } as StreamingFeeState;
  const streamingFeeSplitExtensionOneBytecode = streamingFeeSplitExtension.interface.encodeFunctionData(
    "initializeModuleAndExtension",
    [
      delegatedManagerOne.address,
      feeSettingsOne
    ]
  );

  const tradeExtensionOneBytecode = tradeExtension.interface.encodeFunctionData(
    "initializeModuleAndExtension",
    [delegatedManagerOne.address]
  );

  await delegatedManagerFactory.connect(ownerOne.wallet).initialize(
    setTokenOneAddress,
    ether(0.5),
    ownerOne.address,
    [issuanceExtension.address, streamingFeeSplitExtension.address, tradeExtension.address],
    [issuanceExtensionOneBytecode, streamingFeeSplitExtensionOneBytecode, tradeExtensionOneBytecode]
  );

  // Update owner
  await delegatedManagerOne.connect(ownerOne.wallet).transferOwnership(ownerTwo.address);

  // Update methodologist
  await delegatedManagerOne.connect(methodologistOne.wallet).setMethodologist(methodologistTwo.address);

  // Add operatorTwo
  await delegatedManagerOne.connect(ownerTwo.wallet).addOperators([operatorTwo.address]);

  // Remove operatorOne
  await delegatedManagerOne.connect(ownerTwo.wallet).removeOperators([operatorOne.address]);

  // Case 2: DelegatedManagerFactory deployed DelegatedManager with migrating SetToken
  // -----------------------------------------------

  // Deploy SetToken through SetTokenCreator
  const setTokenTwo = await setV2Setup.createSetToken(
    [setV2Setup.dai.address],
    [ether(1)],
    [issuanceModule.address, setV2Setup.streamingFeeModule.address, tradeModule.address],
    ownerOne.address,
    "TestTokenTwo",
    "TT2"
  );

  // Deploy DelegatedManager through DelegatedManagerFactory
  await delegatedManagerFactory.createManager(
    setTokenTwo.address,
    ownerOne.address,
    methodologistOne.address,
    [operatorOne.address],
    [setV2Setup.dai.address, setV2Setup.wbtc.address],
    [issuanceExtension.address, streamingFeeSplitExtension.address, tradeExtension.address]
  );

  const initializeParamsTwo = await delegatedManagerFactory.initializeState(setTokenTwo.address);
  const delegatedManagerTwo = await deployer.manager.getDelegatedManager(initializeParamsTwo.manager);

  // Initialize DelegatedManager through DelegatedManagerFactory
  const issuanceExtensionTwoBytecode = issuanceExtension.interface.encodeFunctionData("initializeExtension", [delegatedManagerTwo.address]);
  const streamingFeeSplitExtensionTwoBytecode = streamingFeeSplitExtension.interface.encodeFunctionData("initializeExtension", [delegatedManagerTwo.address]);
  const tradeExtensionTwoBytecode = tradeExtension.interface.encodeFunctionData("initializeExtension", [delegatedManagerTwo.address]);

  await delegatedManagerFactory.connect(ownerOne.wallet).initialize(
    setTokenTwo.address,
    ether(0.5),
    ownerOne.address,
    [issuanceExtension.address, streamingFeeSplitExtension.address, tradeExtension.address],
    [issuanceExtensionTwoBytecode, streamingFeeSplitExtensionTwoBytecode, tradeExtensionTwoBytecode]
  );

  // Case 3: DelegatedManagerFactory deployed DelegatedManager and SetToken, migrate to EOA manager
  // -----------------------------------------------

  // Deploy DelegatedManager and SetToken through DelegatedManagerFactory
  const txThree = await delegatedManagerFactory.connect(ownerOne.wallet).createSetAndManager(
    [setV2Setup.dai.address, setV2Setup.wbtc.address],
    [ether(1), ether(.1)],
    "TestTokenThree",
    "TT3",
    ownerOne.address,
    methodologistOne.address,
    [issuanceModule.address, setV2Setup.streamingFeeModule.address, tradeModule.address],
    [operatorOne.address],
    [setV2Setup.dai.address, setV2Setup.wbtc.address],
    [issuanceExtension.address, streamingFeeSplitExtension.address, tradeExtension.address]
  );

  const setTokenThreeAddress = await protocolUtils.getCreatedSetTokenAddress(txThree.hash);
  const initializeParamsThree = await delegatedManagerFactory.initializeState(setTokenThreeAddress);
  const delegatedManagerThree = await deployer.manager.getDelegatedManager(initializeParamsThree.manager);

  // Initialize DelegatedManager through DelegatedManagerFactory
  const issuanceExtensionThreeBytecode = issuanceExtension.interface.encodeFunctionData(
    "initializeModuleAndExtension",
    [
      delegatedManagerThree.address,
      ether(0.1),
      ether(0.01),
      ether(0.01),
      delegatedManagerThree.address,
      ADDRESS_ZERO
    ]
  );

  const feeSettingsThree = {
    feeRecipient: delegatedManagerThree.address,
    maxStreamingFeePercentage: ether(0.05),
    streamingFeePercentage: ether(0.01),
    lastStreamingFeeTimestamp: ZERO,
  } as StreamingFeeState;
  const streamingFeeSplitExtensionThreeBytecode = streamingFeeSplitExtension.interface.encodeFunctionData(
    "initializeModuleAndExtension",
    [
      delegatedManagerThree.address,
      feeSettingsThree
    ]
  );

  const tradeExtensionThreeBytecode = tradeExtension.interface.encodeFunctionData(
    "initializeModuleAndExtension",
    [delegatedManagerThree.address]
  );

  await delegatedManagerFactory.connect(ownerOne.wallet).initialize(
    setTokenThreeAddress,
    ether(0.5),
    ownerOne.address,
    [issuanceExtension.address, streamingFeeSplitExtension.address, tradeExtension.address],
    [issuanceExtensionThreeBytecode, streamingFeeSplitExtensionThreeBytecode, tradeExtensionThreeBytecode]
  );

  // Remove extensions from DelegatedManager
  await delegatedManagerThree.connect(ownerOne.wallet).removeExtensions(
    [issuanceExtension.address, streamingFeeSplitExtension.address, tradeExtension.address]
  );

  // Change SetToken manager to EOA manager
  await delegatedManagerThree.connect(ownerOne.wallet).setManager(otherManager.address);

  // Case 4: EOA managed SetToken
  // -----------------------------------------------

  // Deploy SetToken through SetTokenCreator
  await setV2Setup.createSetToken(
    [setV2Setup.dai.address],
    [ether(1)],
    [setV2Setup.issuanceModule.address],
    otherManager.address,
    "TestTokenFour",
    "TT4"
  );
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
