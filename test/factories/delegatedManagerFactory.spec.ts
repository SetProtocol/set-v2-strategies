import "module-alias/register";

import { BigNumber, ContractTransaction } from "ethers";
import { Address, Account } from "@utils/types";
import { ADDRESS_ZERO, ZERO } from "@utils/constants";
import {
  DelegatedManagerFactory,
  DelegatedManager,
  BaseGlobalExtensionMock
} from "@utils/contracts/index";
import DeployHelper from "@utils/deploys";
import {
  cacheBeforeEach,
  ether,
  getAccounts,
  getWaffleExpect,
  getRandomAddress,
} from "@utils/index";

import { ProtocolUtils } from "@utils/common";
import { SystemFixture } from "@setprotocol/set-protocol-v2/utils/fixtures";
import { MODULE_STATE } from "@setprotocol/set-protocol-v2/utils/constants";

import {
  getSystemFixture,
  getProtocolUtils
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

  cacheBeforeEach(async () => {
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

  // Helper function to run a setup execution of either `createSetAndManager` or `createManager`
  async function create(module: Address, extension: Address, existingSetToken?: Address): Promise<ContractTransaction> {
    const tokens = [setV2Setup.dai.address, setV2Setup.wbtc.address];
    const operators = [operatorOne.address, operatorTwo.address];
    const otherAccountAddress = otherAccount.address;
    const methodologistAddress = methodologist.address;

    if (existingSetToken === undefined) {
      return await delegatedManagerFactory.createSetAndManager(
        tokens,
        [ether(1), ether(.1)],
        "TestToken",
        "TT",
        otherAccountAddress,
        methodologistAddress,
        [module],
        operators,
        tokens,
        [extension]
      );
    }

    return await delegatedManagerFactory.createManager(
      existingSetToken as string,
      otherAccountAddress,
      methodologistAddress,
      operators,
      tokens,
      [extension]
    );
  }

  // Helper function to generate bytecode packets for factory initialization call
  async function generateBytecode(setToken: Address, manager: Address): Promise<string[]> {
    const moduleBytecode = setV2Setup.issuanceModule.interface.encodeFunctionData("initialize", [
      setToken,
      await getRandomAddress()
    ]);

    const extensionBytecode = mockIssuanceExtension.interface.encodeFunctionData("initializeExtension", [
      setToken,
      manager
    ]);

    return [moduleBytecode, extensionBytecode];
  }

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
      expect(await setToken.name()).eq(subjectName);
      expect(await setToken.symbol()).eq(subjectSymbol);
    });

    it("should set the manager factory as the SetToken manager", async() => {
      const tx = await subject();

      const setTokenAddress = await protocolUtils.getCreatedSetTokenAddress(tx.hash);
      const setToken = await deployer.setV2.getSetToken(setTokenAddress);

      expect(await setToken.manager()).eq(delegatedManagerFactory.address);
    });

    it("should configure the DelegatedBaseManager correctly", async () => {
      const tx = await subject();

      const setTokenAddress = await protocolUtils.getCreatedSetTokenAddress(tx.hash);
      const initializeParams = await delegatedManagerFactory.initializeState(setTokenAddress);

      const delegatedManager = await deployer.manager.getDelegatedManager(initializeParams.manager);

      expect(await delegatedManager.setToken()).eq(setTokenAddress);
      expect(await delegatedManager.factory()).eq(delegatedManagerFactory.address);
      expect(await delegatedManager.methodologist()).eq(subjectMethodologist);
      expect(await delegatedManager.useAssetAllowlist()).eq(true);
    });

    it("should set the intialization state correctly", async() => {
      const createdContracts = await delegatedManagerFactory.callStatic.createSetAndManager(
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

      const tx = await subject();

      const setTokenAddress = await protocolUtils.getCreatedSetTokenAddress(tx.hash);
      const initializeParams = await delegatedManagerFactory.initializeState(setTokenAddress);

      expect(initializeParams.deployer).eq(owner.address);
      expect(initializeParams.owner).eq(subjectOwner);
      expect(initializeParams.isPending).eq(true);
      expect(initializeParams.manager).eq(createdContracts[1]);
    });

    it("should emit a DelegatedManagerDeployed event", async() => {
      const createdContracts = await delegatedManagerFactory.callStatic.createSetAndManager(
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

      await expect(subject()).to.emit(delegatedManagerFactory, "DelegatedManagerCreated").withArgs(
        createdContracts[0], // SetToken
        createdContracts[1], // DelegatedManager
        owner.address
      );
    });

    describe("when the assets array is non-empty but missing some component elements", async() => {
      beforeEach(async() => {
        subjectAssets = [setV2Setup.dai.address];
      });

      it("should revert", async() => {
        await expect(subject()).to.be.revertedWith("Asset list must include all components");
      });
    });

    describe("when the assets array is empty", async() => {
      beforeEach(() => {
        subjectAssets = [];
      });

      it("should set the intialization state correctly", async() => {
        const tx = await subject();

        const setTokenAddress = await protocolUtils.getCreatedSetTokenAddress(tx.hash);
        const initializeParams = await delegatedManagerFactory.initializeState(setTokenAddress);

        expect(initializeParams.isPending).eq(true);
      });

      it("should set the DelegatedManager's useAssetAllowlist to false", async () => {
        const tx = await subject();

        const setTokenAddress = await protocolUtils.getCreatedSetTokenAddress(tx.hash);
        const initializeParams = await delegatedManagerFactory.initializeState(setTokenAddress);
        const delegatedManager = await deployer.manager.getDelegatedManager(initializeParams.manager);

        expect(await delegatedManager.useAssetAllowlist()).eq(false);
      });
    });

    describe("when the extensions array is empty", async() => {
      beforeEach(async() => {
        subjectExtensions = [];
      });

      it("should revert", async() => {
        await expect(subject()).to.be.revertedWith("Must have at least 1 extension");
      });
    });
  });

  describe("#createManager", () => {
    let subjectCaller: Account;
    let subjectSetToken: Address;
    let subjectOwner: Address;
    let subjectMethodologist: Address;
    let subjectOperators: Address[];
    let subjectAssets: Address[];
    let subjectExtensions: Address[];

    let components: Address[];
    let units: BigNumber[];
    let modules: Address[];

    cacheBeforeEach(async() => {
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
        maxStreamingFeePercentage: ether(.05),
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

    beforeEach(() => {
      subjectCaller = owner;
    });

    async function subject(): Promise<ContractTransaction> {
      return delegatedManagerFactory.connect(subjectCaller.wallet).createManager(
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
      expect(await delegatedManager.methodologist()).eq(subjectMethodologist);
      expect(await delegatedManager.useAssetAllowlist()).eq(true);
    });

    it("should set the intialization state correctly", async() => {
      const newManagerAddress = await delegatedManagerFactory.callStatic.createManager(
        subjectSetToken,
        subjectOwner,
        subjectMethodologist,
        subjectOperators,
        subjectAssets,
        subjectExtensions
      );

      await subject();

      const initializeParams = await delegatedManagerFactory.initializeState(subjectSetToken);

      expect(initializeParams.deployer).eq(owner.address);
      expect(initializeParams.owner).eq(subjectOwner);
      expect(initializeParams.isPending).eq(true);
      expect(initializeParams.manager).eq(newManagerAddress);
    });

    it("should emit a DelegatedManagerDeployed event", async() => {
      const managerAddress = await delegatedManagerFactory.callStatic.createManager(
        subjectSetToken,
        subjectOwner,
        subjectMethodologist,
        subjectOperators,
        subjectAssets,
        subjectExtensions
      );

      await expect(subject()).to.emit(delegatedManagerFactory, "DelegatedManagerCreated").withArgs(
        subjectSetToken,
        managerAddress,
        owner.address
      );
    });

    describe("when the caller is not the SetToken manager", async () => {
      beforeEach(() => {
        subjectCaller = otherAccount;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be manager");
      });
    });

    describe("when the assets array is non-empty but missing some component elements", async() => {
      beforeEach(async() => {
        subjectAssets = [setV2Setup.wbtc.address];
      });

      it("should revert", async() => {
        await expect(subject()).to.be.revertedWith("Asset list must include all components");
      });
    });

    describe("when the assets array is empty", async() => {
      beforeEach(() => {
        subjectAssets = [];
      });

      it("should set the intialization state correctly", async() => {
        await subject();

        const initializeParams = await delegatedManagerFactory.initializeState(subjectSetToken);

        expect(initializeParams.isPending).eq(true);
      });

      it("should set the DelegatedManager's useAssetAllowlist to false", async () => {
        await subject();

        const initializeParams = await delegatedManagerFactory.initializeState(subjectSetToken);
        const delegatedManager = await deployer.manager.getDelegatedManager(initializeParams.manager);

        expect(await delegatedManager.useAssetAllowlist()).eq(false);
      });
    });

    describe("when the extensions array is empty", async() => {
      beforeEach(async() => {
        subjectExtensions = [];
      });

      it("should revert", async() => {
        await expect(subject()).to.be.revertedWith("Must have at least 1 extension");
      });
    });
  });

  describe("initialize", () => {
    let module: Address;
    let extension: Address;
    let manager: DelegatedManager;
    let initializeParams: any;
    let setToken: SetToken;
    let setTokenAddress: Address;

    let subjectCaller: Account;
    let subjectSetToken: Address;
    let subjectOwnerFeeSplit: BigNumber;
    let subjectOwnerFeeRecipient: Address;
    let subjectInitializeTargets: Address[];
    let subjectInitializeBytecode: string[];

    beforeEach(() => {
      subjectCaller = owner;
      subjectOwnerFeeSplit = ether(.5);
      subjectOwnerFeeRecipient = otherAccount.address;
      subjectInitializeTargets = [];
      subjectInitializeBytecode = [];
    });

    async function subject(): Promise<ContractTransaction> {
      return await delegatedManagerFactory.connect(subjectCaller.wallet).initialize(
        subjectSetToken,
        subjectOwnerFeeSplit,
        subjectOwnerFeeRecipient,
        subjectInitializeTargets,
        subjectInitializeBytecode
      );
    }

    describe("when the SetToken was created by the factory", () => {
      cacheBeforeEach(async () => {
        module = setV2Setup.issuanceModule.address;
        extension = mockIssuanceExtension.address;

        const tx = await create(module, extension);
        setTokenAddress = await protocolUtils.getCreatedSetTokenAddress(tx.hash);

        initializeParams = await delegatedManagerFactory.initializeState(setTokenAddress);
        manager = await deployer.manager.getDelegatedManager(initializeParams.manager);
        setToken = await deployer.setV2.getSetToken(setTokenAddress);

        subjectSetToken = setTokenAddress;
      });

      beforeEach(async () => {
        subjectInitializeTargets = [module, extension];
        subjectInitializeBytecode = await generateBytecode(setTokenAddress, initializeParams.manager);
      });

      it("should initialize the module", async() => {
        await subject();

        expect(await setToken.moduleStates(module)).eq(MODULE_STATE.INITIALIZED);
      });

      it("should initialize the extension", async() => {
        await subject();

        expect(await manager.isInitializedExtension(extension)).eq(true);
      });

      it("should set the ownerFeeSplit on the DelegatedManager", async() => {
        await subject();

        expect(await manager.ownerFeeSplit()).eq(subjectOwnerFeeSplit);
      });

      it("should set the ownerFeeRecipient on the DelegatedManager", async() => {
        await subject();

        expect(await manager.ownerFeeRecipient()).eq(subjectOwnerFeeRecipient);
      });

      it("should set the SetToken's manager to the `manager` specified initializeParams", async () => {
        const oldManager = await setToken.manager();

        await subject();

        const newManager = await setToken.manager();

        expect(newManager).not.eq(oldManager);
        expect(newManager).eq(initializeParams.manager);
      });

      it("should transfer ownership of DelegatedManager to the `owner` specified initializeState", async () => {
        const oldOwner = await manager.owner();

        await subject();

        const newOwner = await manager.owner();

        expect(oldOwner).not.eq(newOwner);
        expect(newOwner).eq(initializeParams.owner);
      });

      it("should delete the initializeState for the SetToken", async () => {
        await subject();

        const finalInitializeParams = await delegatedManagerFactory.initializeState(setTokenAddress);

        expect(finalInitializeParams.deployer).eq(ADDRESS_ZERO);
        expect(finalInitializeParams.owner).eq(ADDRESS_ZERO);
        expect(finalInitializeParams.manager).eq(ADDRESS_ZERO);
        expect(finalInitializeParams.isPending).eq(false);
      });

      it("should emit a DelegatedManagerInitialized event", async() => {
        await expect(subject()).to.emit(delegatedManagerFactory, "DelegatedManagerInitialized").withArgs(
          subjectSetToken,
          initializeParams.manager
        );
      });
    });

    describe("when a SetToken is being migrated to a DelegatedManager", async () => {
      cacheBeforeEach(async () => {
        module = setV2Setup.issuanceModule.address;
        extension = mockIssuanceExtension.address;

        setToken = await setV2Setup.createSetToken(
          [setV2Setup.dai.address],
          [ether(1)],
          [setV2Setup.issuanceModule.address]
        );

        await create(module, extension, setToken.address);

        initializeParams = await delegatedManagerFactory.initializeState(setToken.address);
        manager = await deployer.manager.getDelegatedManager(initializeParams.manager);
        setToken = await deployer.setV2.getSetToken(setToken.address);

        subjectSetToken = setToken.address;
      });

      beforeEach(async () => {
        const extensionBytecode = (await generateBytecode(setToken.address, manager.address))[1];
        subjectInitializeTargets = [extension];
        subjectInitializeBytecode = [extensionBytecode];
      });

      it("should initialize the module", async() => {
        await subject();

        expect(await setToken.moduleStates(module)).eq(MODULE_STATE.PENDING);
      });

      it("should initialize the extension", async() => {
        await subject();

        expect(await manager.isInitializedExtension(extension)).eq(true);
      });

      it("should set the ownerFeeSplit on the DelegatedManager", async() => {
        await subject();

        expect(await manager.ownerFeeSplit()).eq(subjectOwnerFeeSplit);
      });

      it("should set the ownerFeeRecipient on the DelegatedManager", async() => {
        await subject();

        expect(await manager.ownerFeeRecipient()).eq(subjectOwnerFeeRecipient);
      });

      it("should NOT set the SetToken's manager", async () => {
        const oldManager = await setToken.manager();

        await subject();

        const newManager = await setToken.manager();

        expect(newManager).eq(oldManager);
      });

      it("should transfer ownership of DelegateManager to the `owner` specified initializeState", async () => {
        const oldOwner = await manager.owner();

        await subject();

        const newOwner = await manager.owner();

        expect(oldOwner).not.eq(newOwner);
        expect(newOwner).eq(initializeParams.owner);
      });

      it("should delete the initializeState for the SetToken", async () => {
        await subject();

        const finalInitializeParams = await delegatedManagerFactory.initializeState(setToken.address);

        expect(finalInitializeParams.deployer).eq(ADDRESS_ZERO);
        expect(finalInitializeParams.owner).eq(ADDRESS_ZERO);
        expect(finalInitializeParams.manager).eq(ADDRESS_ZERO);
        expect(finalInitializeParams.isPending).eq(false);
      });
    });

    describe("when the initialization state is not pending", async() => {
      it("should revert", async() => {
        await expect(subject()).to.be.revertedWith("Manager must be awaiting initialization");
      });
    });

    describe("when the caller is not the deployer", async() => {
      beforeEach(async() => {
        await create(module, extension);
        subjectCaller = otherAccount;
      });

      it("should revert", async() => {
        await expect(subject()).to.be.revertedWith("Only deployer can initialize manager");
      });
    });

    describe("when initializeTargets and initializeBytecodes do not have the same length", async() => {
      beforeEach(async () => {
        await create(module, extension);
        subjectInitializeBytecode = [];
      });

      it("should revert", async() => {
        await expect(subject()).to.be.revertedWith("Array length must be > 0");
      });
    });
  });
});