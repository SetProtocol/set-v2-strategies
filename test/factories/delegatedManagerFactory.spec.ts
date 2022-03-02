import "module-alias/register";

import { BigNumber, ContractTransaction } from "ethers";
import { Address, Account } from "@utils/types";
import { ADDRESS_ZERO, /* EXTENSION_STATE, */ ZERO } from "@utils/constants";
import { DelegatedManagerFactory, BaseGlobalExtensionMock } from "@utils/contracts/index";
import DeployHelper from "@utils/deploys";
import {
  addSnapshotBeforeRestoreAfterEach,
  ether,
  getAccounts,
  getWaffleExpect,
} from "@utils/index";

import { ProtocolUtils } from "@utils/common";
import { SystemFixture } from "@setprotocol/set-protocol-v2/utils/fixtures";
import {
  getSystemFixture,
  getProtocolUtils,
} from "@setprotocol/set-protocol-v2/utils/test";
import { SetToken } from "@setprotocol/set-protocol-v2/utils/contracts";

const expect = getWaffleExpect();

describe("DelegatedManagerFactory", () => {
  let owner: Account;
  let methodologist: Account;
  let otherAccount: Account;
  let operatorOne: Account;
  let operatorTwo: Account;
  let EOAManagedSetToken: SetToken;

  let setV2Setup: SystemFixture;

  let deployer: DeployHelper;
  let protocolUtils: ProtocolUtils;

  let delegatedManagerFactory: DelegatedManagerFactory;
  let mockFeeExtension: BaseGlobalExtensionMock;
  let mockIssuanceExtension: BaseGlobalExtensionMock;

  before(async () => {
    [
      owner,
      otherAccount,
      methodologist,
      operatorOne,
      operatorTwo,
    ] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);
    protocolUtils = getProtocolUtils();

    setV2Setup = getSystemFixture(owner.address);
    await setV2Setup.initialize();

    mockFeeExtension = await deployer.mocks.deployBaseGlobalExtensionMock();
    mockIssuanceExtension = await deployer.mocks.deployBaseGlobalExtensionMock();

    delegatedManagerFactory = await deployer.factories.deployDelegatedManagerFactory(
      setV2Setup.factory.address
    );
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#constructor", async () => {
    let subjectSetTokenFactory: Address;

    beforeEach(async () => {
      subjectSetTokenFactory = setV2Setup.factory.address;
    });

    async function subject(): Promise<DelegatedManagerFactory> {
      return await deployer.factories.deployDelegatedManagerFactory(
        subjectSetTokenFactory
      );
    }

    it("should set the correct SetToken factory address", async () => {
      const delegatedManager = await subject();

      const actualFactory = await delegatedManager.setTokenFactory();
      expect (actualFactory).to.eq(subjectSetTokenFactory);
    });
  });

  describe("#createSetAndManager", () => {
    let subjectComponents: Address[];
    let subjectUnits: BigNumber[];
    let subjectName: string;
    let subjectSymbol: string;
    let subjectOwner: Address;
    let subjectMethodologist: Address;
    let subjectModules: Address[];
    let subjectOperators: Address[];
    let subjectAssets: Address[];
    let subjectExtensions: Address[];

    beforeEach(() => {
      subjectComponents = [setV2Setup.dai.address, setV2Setup.wbtc.address],
      subjectUnits = [ether(1), ether(.1)];
      subjectName = "TestToken";
      subjectSymbol = "TT";
      subjectOwner = otherAccount.address;
      subjectMethodologist = methodologist.address;
      subjectModules = [setV2Setup.issuanceModule.address, setV2Setup.streamingFeeModule.address];
      subjectOperators = [operatorOne.address, operatorTwo.address];
      subjectAssets = [setV2Setup.dai.address, setV2Setup.wbtc.address];
      subjectExtensions = [mockIssuanceExtension.address, mockFeeExtension.address];
    });

    async function subject(): Promise<ContractTransaction> {
      return await delegatedManagerFactory.createSetAndManager(
        subjectComponents,
        subjectUnits,
        subjectName,
        subjectSymbol,
        subjectOwner,
        subjectMethodologist,
        subjectModules,
        subjectOperators,
        subjectAssets,
        subjectExtensions
      );
    }

    it("should configure the SetToken correctly", async() => {
      const tx = await subject();

      const setTokenAddress = await protocolUtils.getCreatedSetTokenAddress(tx.hash);
      const setToken = await deployer.setV2.getSetToken(setTokenAddress);

      expect(await setToken.getComponents()).deep.eq(subjectComponents);
      expect(await setToken.name).eq(subjectName);
      expect(await setToken.symbol).eq(subjectSymbol);
    });

    it("should set the manager factory as the SetToken manager", async() => {
      const tx = await subject();

      const setTokenAddress = await protocolUtils.getCreatedSetTokenAddress(tx.hash);
      const setToken = await deployer.setV2.getSetToken(setTokenAddress);

      expect(await setToken.manager).eq(delegatedManagerFactory.address);
    });

    it("should configure the DelegatedBaseManager correctly", async () => {
      const tx = await subject();

      const setTokenAddress = await protocolUtils.getCreatedSetTokenAddress(tx.hash);
      const initializeParams = await delegatedManagerFactory.initializeState(setTokenAddress);

      const delegatedManager = await deployer.manager.getDelegatedManager(initializeParams.manager);

      expect(await delegatedManager.setToken()).eq(setTokenAddress);
      expect(await delegatedManager.factory()).eq(delegatedManagerFactory.address);
      expect(await delegatedManager.methodologist).eq(subjectMethodologist);
      expect(await delegatedManager.useAssetAllowlist).eq(true);
      expect(await delegatedManager.getExtensions()).deep.eq(subjectExtensions);
      expect(await delegatedManager.getOperators()).deep.eq(subjectOperators);
      expect(await delegatedManager.getAllowedAssets()).deep.eq(subjectAssets);
    });

    it("should set the intialization state correctly", async() => {
      const tx = await subject();

      const setTokenAddress = await protocolUtils.getCreatedSetTokenAddress(tx.hash);
      const initializeParams = await delegatedManagerFactory.initializeState(setTokenAddress);

      expect(initializeParams.deployer).eq(owner.address);
      expect(initializeParams.owner).eq(subjectOwner);
      expect(initializeParams.isPending).eq(true);

      // Need a method similar to getCreatedSetTokenAddress here...
      // expect(initializeParams.manager).eq()
    });

    it("should emit a DelegatedManagerDeployed event", async() => {

    });

    describe("when the assets array in non-empty but missing some component elements", async() => {
      beforeEach(async() => {

      });

      it("should revert", async() => {

      });
    });
  });

  describe("#createManager", () => {
    let subjectSetToken: Address;
    let subjectOwner: Address;
    let subjectMethodologist: Address;
    let subjectOperators: Address[];
    let subjectAssets: Address[];
    let subjectExtensions: Address[];

    let components: Address[];
    let units: BigNumber[];
    let modules: Address[];

    beforeEach(async() => {
      components = [setV2Setup.dai.address];
      units = [ether(1)];
      modules = [setV2Setup.issuanceModule.address, setV2Setup.streamingFeeModule.address];

      // Deploy EOA managed SetToken
      EOAManagedSetToken = await setV2Setup.createSetToken(
        components,
        units,
        modules
      );

      // Initialize modules
      await setV2Setup.issuanceModule.initialize(EOAManagedSetToken.address, ADDRESS_ZERO);

      const streamingFeeSettings = {
        feeRecipient: owner.address,
        maxStreamingFeePercentage: ether(1),
        streamingFeePercentage: ether(.02),
        lastStreamingFeeTimestamp: ZERO,
      };

      await setV2Setup.streamingFeeModule.initialize(
        EOAManagedSetToken.address,
        streamingFeeSettings
      );

      // Set subject variables
      subjectSetToken = EOAManagedSetToken.address;
      subjectOwner = otherAccount.address;
      subjectMethodologist = methodologist.address;
      subjectOperators = [operatorOne.address, operatorTwo.address];
      subjectAssets = [setV2Setup.dai.address, setV2Setup.wbtc.address];
      subjectExtensions = [mockIssuanceExtension.address, mockFeeExtension.address];
    });

    async function subject(): Promise<ContractTransaction> {
      return await delegatedManagerFactory.createManager(
        subjectSetToken,
        subjectOwner,
        subjectMethodologist,
        subjectOperators,
        subjectAssets,
        subjectExtensions
      );
    }

    it("should configure the DelegatedBaseManager correctly", async () => {
      await subject();

      const initializeParams = await delegatedManagerFactory.initializeState(subjectSetToken);
      const delegatedManager = await deployer.manager.getDelegatedManager(initializeParams.manager);

      expect(await delegatedManager.setToken()).eq(subjectSetToken);
      expect(await delegatedManager.factory()).eq(delegatedManagerFactory.address);
      expect(await delegatedManager.methodologist).eq(subjectMethodologist);
      expect(await delegatedManager.useAssetAllowlist).eq(true);
      expect(await delegatedManager.getExtensions()).deep.eq(subjectExtensions);
      expect(await delegatedManager.getOperators()).deep.eq(subjectOperators);
      expect(await delegatedManager.getAllowedAssets()).deep.eq(subjectAssets);
    });

    it("should set the intialization state correctly", async() => {
      await subject();

      const initializeParams = await delegatedManagerFactory.initializeState(subjectSetToken);

      expect(initializeParams.deployer).eq(owner.address);
      expect(initializeParams.owner).eq(subjectOwner);
      expect(initializeParams.isPending).eq(true);

      // Need a method similar to getCreatedSetTokenAddress here...
      // expect(initializeParams.manager).eq()
    });

    it("should emit a DelegatedManagerDeployed event", async() => {

    });

    describe("when the assets array in non-empty but missing some component elements", async() => {
      beforeEach(async() => {

      });

      it("should revert", async() => {

      });
    });
  });

  describe("initialize", () => {
    let subjectSetToken: Address;
    let subjectOwnerFeeSplit: BigNumber;
    let subjectOwnerFeeRecipient: Address;
    let subjectInitializeTargets: Address[];
    let subjectInitializeBytecode: string[];

    beforeEach(() => {
      subjectSetToken;
      subjectOwnerFeeSplit = ether(.5);
      subjectOwnerFeeRecipient = otherAccount.address;
      subjectInitializeTargets;
      subjectInitializeBytecode;
    });

    async function subject(): Promise<ContractTransaction> {
      return await delegatedManagerFactory.initialize(
        subjectSetToken,
        subjectOwnerFeeSplit,
        subjectOwnerFeeRecipient,
        subjectInitializeTargets,
        subjectInitializeBytecode
      );
    }

    describe("when the SetToken was created by the factory", () => {
      it("should initialize the modules", async() => {
        await subject();

      });

      it("should initialize the extensions", async() => {

      });

      it("should set the ownerFeeSplit on the DelegatedManager", async() => {

      });

      it("should set the ownerFeeRecipient on the DelegatedManager", async() => {

      });

      it("should set the SetToken's manager to the `manager` specified initializeState", async () => {

      });

      it("should transfer ownership of DelegateManager to the `owner` specified initializeState", async () => {

      });

      it("should delete the initializeState for the SetToken", async () => {

      });

      it("should emit a DelegatedManagerInitialized event", async() => {

      });
    });

    describe("when a SetToken is being migrated to a DelegatedManager", async () => {
      it("should initialize the modules", async() => {

      });

      it("should initialize the extensions", async() => {

      });

      it("should set the ownerFeeSplit on the DelegatedManager", async() => {

      });

      it("should set the ownerFeeRecipient on the DelegatedManager", async() => {

      });

      it("should set the SetToken's manager to the `manager` specified initializeState", async () => {

      });

      it("should transfer ownership of DelegateManager to the `owner` specified initializeState", async () => {

      });

      it("should delete the initializeState for the SetToken", async () => {

      });

      it("should emit a DelegatedManagerInitialized event", async() => {

      });
    });

    describe("when the initialization state is not pending", async() => {
      beforeEach(async () => {

      });

      it("should revert", async() => {

      });
    });

    describe("when the caller is not the deployer", async() => {
      beforeEach(async () => {

      });

      it("should revert", async() => {

      });
    });

    describe("when initializeTargets and initializeBytecodes do not have the same length", async() => {
      beforeEach(async () => {

      });

      it("should revert", async() => {

      });
    });
  });

  describe("#getValidSets", () => {

    beforeEach(async() => {

    });

    async function subject(): Promise<string[]> {
      return await delegatedManagerFactory.getValidSets();
    }

    it("should return valid sets", async() => {
      await subject();
    });
  });
});