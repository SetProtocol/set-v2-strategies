import "module-alias/register";

import { Contract } from "ethers";
import { Address, Account } from "@utils/types";
import { ADDRESS_ZERO } from "@utils/constants";
import {
  DelegatedManager,
  WrapExtension,
  ManagerCore,
} from "@utils/contracts/index";
import {
  SetToken,
  WrapModuleV2,
  WrapV2AdapterMock
} from "@setprotocol/set-protocol-v2/utils/contracts";
import DeployHelper from "@utils/deploys";
import {
  addSnapshotBeforeRestoreAfterEach,
  ether,
  getAccounts,
  getWaffleExpect
} from "@utils/index";
import { SystemFixture } from "@setprotocol/set-protocol-v2/dist/utils/fixtures";
import { getSystemFixture, getRandomAccount } from "@setprotocol/set-protocol-v2/dist/utils/test";
import { ContractTransaction } from "ethers";

const expect = getWaffleExpect();

describe("WrapExtension", () => {
  let owner: Account;
  let methodologist: Account;
  let operator: Account;
  let factory: Account;

  let deployer: DeployHelper;
  let setToken: SetToken;
  let setV2Setup: SystemFixture;

  let managerCore: ManagerCore;
  let delegatedManager: DelegatedManager;
  let wrapExtension: WrapExtension;

  let wrapModule: WrapModuleV2;
  let wrapAdapterMock: WrapV2AdapterMock;
  const wrapAdapterMockIntegrationName: string = "MOCK_WRAPPER_V2";

  before(async () => {
    [
      owner,
      methodologist,
      operator,
      factory
    ] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);

    setV2Setup = getSystemFixture(owner.address);
    await setV2Setup.initialize();

    wrapModule = await deployer.setDeployer.modules.deployWrapModuleV2(setV2Setup.controller.address, setV2Setup.weth.address);
    await setV2Setup.controller.addModule(wrapModule.address);

    wrapAdapterMock = await deployer.setDeployer.mocks.deployWrapV2AdapterMock();

    await setV2Setup.integrationRegistry.addIntegration(
      wrapModule.address,
      wrapAdapterMockIntegrationName,
      wrapAdapterMock.address
    );

    managerCore = await deployer.managerCore.deployManagerCore();

    wrapExtension = await deployer.globalExtensions.deployWrapExtension(
      managerCore.address,
      wrapModule.address
    );

    setToken = await setV2Setup.createSetToken(
      [setV2Setup.dai.address],
      [ether(1)],
      [setV2Setup.issuanceModule.address, wrapModule.address]
    );

    await setV2Setup.issuanceModule.initialize(setToken.address, ADDRESS_ZERO);

    delegatedManager = await deployer.manager.deployDelegatedManager(
      setToken.address,
      factory.address,
      methodologist.address,
      [wrapExtension.address],
      [operator.address],
      [setV2Setup.dai.address, setV2Setup.weth.address, setV2Setup.wbtc.address],
      true
    );

    await setToken.setManager(delegatedManager.address);

    await managerCore.initialize([wrapExtension.address], [factory.address]);
    await managerCore.connect(factory.wallet).addManager(delegatedManager.address);
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#constructor", async () => {
    let subjectManagerCore: Address;
    let subjectWrapModule: Address;

    beforeEach(async () => {
      subjectManagerCore = managerCore.address;
      subjectWrapModule = wrapModule.address;
    });

    async function subject(): Promise<WrapExtension> {
      return await deployer.globalExtensions.deployWrapExtension(
        subjectManagerCore,
        subjectWrapModule
      );
    }

    it("should set the correct WrapModuleV2 address", async () => {
      const wrapExtension = await subject();

      const storedModule = await wrapExtension.wrapModule();
      expect(storedModule).to.eq(subjectWrapModule);
    });
  });

  describe("#initializeModule", async () => {
    let subjectDelegatedManager: Address;
    let subjectCaller: Account;

    beforeEach(async () => {
      await wrapExtension.connect(owner.wallet).initializeExtension(delegatedManager.address);

      subjectDelegatedManager = delegatedManager.address;
      subjectCaller = owner;
    });

    async function subject(): Promise<ContractTransaction> {
      return wrapExtension.connect(subjectCaller.wallet).initializeModule(subjectDelegatedManager);
    }

    it("should initialize the module on the SetToken", async () => {
      await subject();

      const isModuleInitialized: Boolean = await setToken.isInitializedModule(wrapModule.address);
      expect(isModuleInitialized).to.eq(true);
    });

    describe("when the sender is not the owner", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be owner");
      });
    });

    describe("when the module is not pending or initialized", async () => {
      beforeEach(async () => {
        await subject();
        await delegatedManager.connect(owner.wallet).removeExtensions([wrapExtension.address]);
        await delegatedManager.connect(owner.wallet).setManager(owner.address);
        await setToken.connect(owner.wallet).removeModule(wrapModule.address);
        await setToken.connect(owner.wallet).setManager(delegatedManager.address);
        await delegatedManager.connect(owner.wallet).addExtensions([wrapExtension.address]);
        await wrapExtension.connect(owner.wallet).initializeExtension(delegatedManager.address);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be pending initialization");
      });
    });

    describe("when the module is already initialized", async () => {
      beforeEach(async () => {
        await subject();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be pending initialization");
      });
    });

    describe("when the extension is not pending or initialized", async () => {
      beforeEach(async () => {
        await delegatedManager.connect(owner.wallet).removeExtensions([wrapExtension.address]);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be initialized extension");
      });
    });

    describe("when the extension is pending", async () => {
      beforeEach(async () => {
        await delegatedManager.connect(owner.wallet).removeExtensions([wrapExtension.address]);
        await delegatedManager.connect(owner.wallet).addExtensions([wrapExtension.address]);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be initialized extension");
      });
    });

    describe("when the manager is not a ManagerCore-enabled manager", async () => {
      beforeEach(async () => {
        await managerCore.connect(owner.wallet).removeManager(delegatedManager.address);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be ManagerCore-enabled manager");
      });
    });
  });

  describe("#initializeExtension", async () => {
    let subjectDelegatedManager: Address;
    let subjectCaller: Account;

    beforeEach(async () => {
      subjectDelegatedManager = delegatedManager.address;
      subjectCaller = owner;
    });

    async function subject(): Promise<ContractTransaction> {
      return wrapExtension.connect(subjectCaller.wallet).initializeExtension(subjectDelegatedManager);
    }

    it("should store the correct SetToken and DelegatedManager on the WrapExtension", async () => {
      await subject();

      const storedDelegatedManager: Address = await wrapExtension.setManagers(setToken.address);
      expect(storedDelegatedManager).to.eq(delegatedManager.address);
    });

    it("should initialize the WrapExtension on the DelegatedManager", async () => {
      await subject();

      const isExtensionInitialized: Boolean = await delegatedManager.isInitializedExtension(wrapExtension.address);
      expect(isExtensionInitialized).to.eq(true);
    });

    it("should emit the correct WrapExtensionInitialized event", async () => {
      await expect(subject()).to.emit(wrapExtension, "WrapExtensionInitialized").withArgs(
        setToken.address,
        delegatedManager.address
      );
    });

    describe("when the sender is not the owner", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be owner");
      });
    });

    describe("when the extension is not pending or initialized", async () => {
      beforeEach(async () => {
        await wrapExtension.connect(owner.wallet).initializeExtension(delegatedManager.address);
        await delegatedManager.connect(owner.wallet).removeExtensions([wrapExtension.address]);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Extension must be pending");
      });
    });

    describe("when the extension is already initialized", async () => {
      beforeEach(async () => {
        await wrapExtension.connect(owner.wallet).initializeExtension(delegatedManager.address);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Extension must be pending");
      });
    });

    describe("when the manager is not a ManagerCore-enabled manager", async () => {
      beforeEach(async () => {
        await managerCore.connect(owner.wallet).removeManager(delegatedManager.address);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be ManagerCore-enabled manager");
      });
    });
  });

  describe("#initializeModuleAndExtension", async () => {
    let subjectDelegatedManager: Address;
    let subjectCaller: Account;

    beforeEach(async () => {
      subjectDelegatedManager = delegatedManager.address;
      subjectCaller = owner;
    });

    async function subject(): Promise<ContractTransaction> {
      return wrapExtension.connect(subjectCaller.wallet).initializeModuleAndExtension(subjectDelegatedManager);
    }

    it("should initialize the module on the SetToken", async () => {
      await subject();

      const isModuleInitialized: Boolean = await setToken.isInitializedModule(wrapModule.address);
      expect(isModuleInitialized).to.eq(true);
    });

    it("should store the correct SetToken and DelegatedManager on the WrapExtension", async () => {
      await subject();

      const storedDelegatedManager: Address = await wrapExtension.setManagers(setToken.address);
      expect(storedDelegatedManager).to.eq(delegatedManager.address);
    });

    it("should initialize the WrapExtension on the DelegatedManager", async () => {
      await subject();

      const isExtensionInitialized: Boolean = await delegatedManager.isInitializedExtension(wrapExtension.address);
      expect(isExtensionInitialized).to.eq(true);
    });

    it("should emit the correct WrapExtensionInitialized event", async () => {
      await expect(subject()).to.emit(wrapExtension, "WrapExtensionInitialized").withArgs(
        setToken.address,
        delegatedManager.address
      );
    });

    describe("when the sender is not the owner", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be owner");
      });
    });

    describe("when the module is not pending or initialized", async () => {
      beforeEach(async () => {
        await wrapExtension.connect(owner.wallet).initializeModuleAndExtension(delegatedManager.address);
        await delegatedManager.connect(owner.wallet).removeExtensions([wrapExtension.address]);
        await delegatedManager.connect(owner.wallet).setManager(owner.address);
        await setToken.connect(owner.wallet).removeModule(wrapModule.address);
        await setToken.connect(owner.wallet).setManager(delegatedManager.address);
        await delegatedManager.connect(owner.wallet).addExtensions([wrapExtension.address]);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be pending initialization");
      });
    });

    describe("when the module is already initialized", async () => {
      beforeEach(async () => {
        await wrapExtension.connect(owner.wallet).initializeModuleAndExtension(delegatedManager.address);
        await delegatedManager.connect(owner.wallet).removeExtensions([wrapExtension.address]);
        await delegatedManager.connect(owner.wallet).addExtensions([wrapExtension.address]);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be pending initialization");
      });
    });

    describe("when the extension is not pending or initialized", async () => {
      beforeEach(async () => {
        await wrapExtension.connect(owner.wallet).initializeExtension(delegatedManager.address);
        await delegatedManager.connect(owner.wallet).removeExtensions([wrapExtension.address]);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Extension must be pending");
      });
    });

    describe("when the extension is already initialized", async () => {
      beforeEach(async () => {
        await wrapExtension.connect(owner.wallet).initializeExtension(delegatedManager.address);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Extension must be pending");
      });
    });

    describe("when the manager is not a ManagerCore-enabled manager", async () => {
      beforeEach(async () => {
        await managerCore.connect(owner.wallet).removeManager(delegatedManager.address);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be ManagerCore-enabled manager");
      });
    });
  });

  describe("#removeExtension", async () => {
    let subjectManager: Contract;
    let subjectWrapExtension: Address[];
    let subjectCaller: Account;

    beforeEach(async () => {
      await wrapExtension.connect(owner.wallet).initializeExtension(delegatedManager.address);

      subjectManager = delegatedManager;
      subjectWrapExtension = [wrapExtension.address];
      subjectCaller = owner;
    });

    async function subject(): Promise<ContractTransaction> {
      return subjectManager.connect(subjectCaller.wallet).removeExtensions(subjectWrapExtension);
    }

    it("should clear SetToken and DelegatedManager from WrapExtension state", async () => {
      await subject();

      const storedDelegatedManager: Address = await wrapExtension.setManagers(setToken.address);
      expect(storedDelegatedManager).to.eq(ADDRESS_ZERO);
    });

    it("should emit the correct ExtensionRemoved event", async () => {
      await expect(subject()).to.emit(wrapExtension, "ExtensionRemoved").withArgs(
        setToken.address,
        delegatedManager.address
      );
    });

    describe("when the caller is not the SetToken manager", async () => {
      beforeEach(async () => {
        subjectManager = await deployer.mocks.deployManagerMock(setToken.address);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be Manager");
      });
    });
  });
});