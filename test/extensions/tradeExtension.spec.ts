import "module-alias/register";

import { BigNumber } from "ethers";
import { Address, Account } from "@utils/types";
import { ADDRESS_ZERO, EMPTY_BYTES } from "@utils/constants";
import { DelegatedManager, TradeExtension, ManagerCore } from "@utils/contracts/index";
import { SetToken, TradeModule, TradeAdapterMock } from "@setprotocol/set-protocol-v2/utils/contracts";
import DeployHelper from "@utils/deploys";
import {
  addSnapshotBeforeRestoreAfterEach,
  ether,
  getAccounts,
  getWaffleExpect
} from "@utils/index";
import { SystemFixture } from "@setprotocol/set-protocol-v2/utils/fixtures";
import { getSystemFixture, getRandomAccount } from "@setprotocol/set-protocol-v2/utils/test";
import { ContractTransaction } from "ethers";

const expect = getWaffleExpect();

describe("TradeExtension", () => {
  let owner: Account;
  let methodologist: Account;
  let operator: Account;
  let factory: Account;

  let deployer: DeployHelper;
  let setToken: SetToken;
  let setV2Setup: SystemFixture;

  let tradeModule: TradeModule;

  let managerCore: ManagerCore;
  let delegatedManager: DelegatedManager;
  let tradeExtension: TradeExtension;

  const tradeAdapterName = "TRADEMOCK";
  let tradeMock: TradeAdapterMock;

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

    tradeModule = await deployer.setDeployer.modules.deployTradeModule(setV2Setup.controller.address);
    await setV2Setup.controller.addModule(tradeModule.address);

    tradeMock = await deployer.setDeployer.mocks.deployTradeAdapterMock();

    await setV2Setup.integrationRegistry.addIntegration(
      tradeModule.address,
      tradeAdapterName,
      tradeMock.address
    );

    managerCore = await deployer.managerCore.deployManagerCore();

    tradeExtension = await deployer.globalExtensions.deployTradeExtension(
      managerCore.address,
      tradeModule.address
    );

    setToken = await setV2Setup.createSetToken(
      [setV2Setup.dai.address],
      [ether(1)],
      [setV2Setup.issuanceModule.address, tradeModule.address]
    );

    await setV2Setup.issuanceModule.initialize(setToken.address, ADDRESS_ZERO);

    delegatedManager = await deployer.manager.deployDelegatedManager(
      setToken.address,
      factory.address,
      methodologist.address,
      [tradeExtension.address],
      [operator.address],
      [setV2Setup.dai.address, setV2Setup.weth.address],
      true
    );

    await setToken.setManager(delegatedManager.address);

    await managerCore.initialize([factory.address]);
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#constructor", async () => {
    let subjectManagerCore: Address;
    let subjectTradeModule: Address;

    beforeEach(async () => {
      subjectManagerCore = managerCore.address;
      subjectTradeModule = tradeModule.address;
    });

    async function subject(): Promise<TradeExtension> {
      return await deployer.globalExtensions.deployTradeExtension(
        subjectManagerCore,
        subjectTradeModule
      );
    }

    it("should set the correct TradeModule address", async () => {
      const tradeExtension = await subject();

      const storedModule = await tradeExtension.tradeModule();
      expect(storedModule).to.eq(subjectTradeModule);
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
      return tradeExtension.connect(subjectCaller.wallet).initializeExtension(subjectDelegatedManager);
    }

    it("should store the correct SetToken and DelegatedManager on the TradeExtension", async () => {
      await subject();

      const storedDelegatedManager: Address = await tradeExtension.setManagers(setToken.address);
      expect(storedDelegatedManager).to.eq(delegatedManager.address);
    });

    it("should initialize the TradeExtension on the DelegatedManager", async () => {
      await subject();

      const isExtensionInitialized: Boolean = await delegatedManager.isInitializedExtension(tradeExtension.address);
      expect(isExtensionInitialized).to.eq(true);
    });

    it("should emit the correct ExtensionInitialized event", async () => {
      await expect(subject()).to.emit(tradeExtension, "ExtensionInitialized").withArgs(setToken.address, delegatedManager.address);
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
        await tradeExtension.connect(owner.wallet).initializeExtension(delegatedManager.address);
        await delegatedManager.connect(owner.wallet).removeExtensions([tradeExtension.address]);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Extension must be pending");
      });
    });

    describe("when the extension is already initialized", async () => {
      beforeEach(async () => {
        await tradeExtension.connect(owner.wallet).initializeExtension(delegatedManager.address);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Extension must be pending");
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
      return tradeExtension.connect(subjectCaller.wallet).initializeModuleAndExtension(subjectDelegatedManager);
    }

    it("should initialize the module on the SetToken", async () => {
      await subject();

      const isModuleInitialized: Boolean = await setToken.isInitializedModule(tradeModule.address);
      expect(isModuleInitialized).to.eq(true);
    });

    it("should store the correct SetToken and DelegatedManager on the TradeExtension", async () => {
      await subject();

      const storedDelegatedManager: Address = await tradeExtension.setManagers(setToken.address);
      expect(storedDelegatedManager).to.eq(delegatedManager.address);
    });

    it("should initialize the TradeExtension on the DelegatedManager", async () => {
      await subject();

      const isExtensionInitialized: Boolean = await delegatedManager.isInitializedExtension(tradeExtension.address);
      expect(isExtensionInitialized).to.eq(true);
    });

    it("should emit the correct ModuleInitialized event", async () => {
      await expect(subject()).to.emit(setToken, "ModuleInitialized").withArgs(tradeModule.address);
    });

    it("should emit the correct ExtensionInitialized event", async () => {
      await expect(subject()).to.emit(tradeExtension, "ExtensionInitialized").withArgs(setToken.address, delegatedManager.address);
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
        await tradeExtension.connect(owner.wallet).initializeModuleAndExtension(delegatedManager.address);
        await delegatedManager.connect(owner.wallet).removeExtensions([tradeExtension.address]);
        await delegatedManager.connect(owner.wallet).setManager(owner.address);
        await setToken.connect(owner.wallet).removeModule(tradeModule.address);
        await setToken.connect(owner.wallet).setManager(delegatedManager.address);
        await delegatedManager.connect(owner.wallet).addExtensions([tradeExtension.address]);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("TradeModule must be pending");
      });
    });

    describe("when the module is already initialized", async () => {
      beforeEach(async () => {
        await tradeExtension.connect(owner.wallet).initializeModuleAndExtension(delegatedManager.address);
        await delegatedManager.connect(owner.wallet).removeExtensions([tradeExtension.address]);
        await delegatedManager.connect(owner.wallet).addExtensions([tradeExtension.address]);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("TradeModule must be pending");
      });
    });

    describe("when the extension is not pending or initialized", async () => {
      beforeEach(async () => {
        await tradeExtension.connect(owner.wallet).initializeExtension(delegatedManager.address);
        await delegatedManager.connect(owner.wallet).removeExtensions([tradeExtension.address]);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Extension must be pending");
      });
    });

    describe("when the extension is already initialized", async () => {
      beforeEach(async () => {
        await tradeExtension.connect(owner.wallet).initializeExtension(delegatedManager.address);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Extension must be pending");
      });
    });
  });

  describe("#removeExtension", async () => {
    let subjectTradeExtension: Address[];
    let subjectCaller: Account;

    beforeEach(async () => {
      await tradeExtension.connect(owner.wallet).initializeExtension(delegatedManager.address);

      subjectTradeExtension = [tradeExtension.address];
      subjectCaller = owner;
    });

    async function subject(): Promise<ContractTransaction> {
      return delegatedManager.connect(subjectCaller.wallet).removeExtensions(subjectTradeExtension);
    }

    it("should clear SetToken and DelegatedManager from TradeExtension state", async () => {
      await subject();

      const storedDelegatedManager: Address = await tradeExtension.setManagers(setToken.address);
      expect(storedDelegatedManager).to.eq(ADDRESS_ZERO);
    });

    it("should emit the correct ExtensionRemoved event", async () => {
      await expect(subject()).to.emit(tradeExtension, "ExtensionRemoved").withArgs(setToken.address, delegatedManager.address);
    });
  });

  describe("#trade", async () => {
    let mintedTokens: BigNumber;
    let subjectSetToken: Address;
    let subjectAdapterName: string;
    let subjectSendToken: Address;
    let subjectSendAmount: BigNumber;
    let subjectReceiveToken: Address;
    let subjectMinReceiveAmount: BigNumber;
    let subjectBytes: string;
    let subjectCaller: Account;

    beforeEach(async () => {
      await tradeExtension.connect(owner.wallet).initializeModuleAndExtension(delegatedManager.address);

      mintedTokens = ether(1);
      await setV2Setup.dai.approve(setV2Setup.issuanceModule.address, ether(1));
      await setV2Setup.issuanceModule.issue(setToken.address, mintedTokens, owner.address);

      // Fund TradeAdapter with destinationToken WETH and DAI
      await setV2Setup.weth.transfer(tradeMock.address, ether(10));
      await setV2Setup.dai.transfer(tradeMock.address, ether(10));

      subjectSetToken = setToken.address;
      subjectCaller = operator;
      subjectAdapterName = tradeAdapterName;
      subjectSendToken = setV2Setup.dai.address;
      subjectSendAmount = ether(0.5);
      subjectReceiveToken = setV2Setup.weth.address;
      subjectMinReceiveAmount = ether(0);
      subjectBytes = EMPTY_BYTES;
    });

    async function subject(): Promise<ContractTransaction> {
      return tradeExtension.connect(subjectCaller.wallet).trade(
        subjectSetToken,
        subjectAdapterName,
        subjectSendToken,
        subjectSendAmount,
        subjectReceiveToken,
        subjectMinReceiveAmount,
        subjectBytes
      );
    }

    it("should successfully execute the trade", async () => {
      const oldSendTokenBalance = await setV2Setup.dai.balanceOf(setToken.address);
      const oldReceiveTokenBalance = await setV2Setup.weth.balanceOf(setToken.address);

      await subject();

      const expectedNewSendTokenBalance = oldSendTokenBalance.sub(ether(0.5));
      const actualNewSendTokenBalance = await setV2Setup.dai.balanceOf(setToken.address);
      const expectedNewReceiveTokenBalance = oldReceiveTokenBalance.add(ether(10));
      const actualNewReceiveTokenBalance = await setV2Setup.weth.balanceOf(setToken.address);

      expect(expectedNewSendTokenBalance).to.eq(actualNewSendTokenBalance);
      expect(expectedNewReceiveTokenBalance).to.eq(actualNewReceiveTokenBalance);
    });

    describe("when the sender is not an operator", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be approved operator");
      });
    });

    describe("when the receiveToken is not an allowed asset", async () => {
      beforeEach(async () => {
        subjectReceiveToken = setV2Setup.wbtc.address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be allowed asset");
      });
    });
  });
});