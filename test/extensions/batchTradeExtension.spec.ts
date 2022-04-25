import "module-alias/register";

import { BigNumber, Contract } from "ethers";
import { Address, Account, TradeInfo } from "@utils/types";
import { ADDRESS_ZERO, EMPTY_BYTES } from "@utils/constants";
import {
  DelegatedManager,
  BatchTradeExtension,
  ManagerCore,
  TradeAdapterMock
} from "@utils/contracts/index";
import {
  SetToken,
  TradeModule
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

describe("BatchTradeExtension", () => {
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
  let batchTradeExtension: BatchTradeExtension;

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

    tradeMock = await deployer.mocks.deployTradeAdapterMock();

    await setV2Setup.integrationRegistry.addIntegration(
      tradeModule.address,
      tradeAdapterName,
      tradeMock.address
    );

    managerCore = await deployer.managerCore.deployManagerCore();

    batchTradeExtension = await deployer.globalExtensions.deployBatchTradeExtension(
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
      [batchTradeExtension.address],
      [operator.address],
      [setV2Setup.dai.address, setV2Setup.weth.address, setV2Setup.wbtc.address],
      true
    );

    await setToken.setManager(delegatedManager.address);

    await managerCore.initialize([batchTradeExtension.address], [factory.address]);
    await managerCore.connect(factory.wallet).addManager(delegatedManager.address);
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#constructor", async () => {
    let subjectManagerCore: Address;
    let subjectTradeModule: Address;

    beforeEach(async () => {
      subjectManagerCore = managerCore.address;
      subjectTradeModule = tradeModule.address;
    });

    async function subject(): Promise<BatchTradeExtension> {
      return await deployer.globalExtensions.deployBatchTradeExtension(
        subjectManagerCore,
        subjectTradeModule
      );
    }

    it("should set the correct TradeModule address", async () => {
      const batchTradeExtension = await subject();

      const storedModule = await batchTradeExtension.tradeModule();
      expect(storedModule).to.eq(subjectTradeModule);
    });
  });

  describe("#initializeModule", async () => {
    let subjectDelegatedManager: Address;
    let subjectCaller: Account;

    beforeEach(async () => {
      await batchTradeExtension.connect(owner.wallet).initializeExtension(delegatedManager.address);

      subjectDelegatedManager = delegatedManager.address;
      subjectCaller = owner;
    });

    async function subject(): Promise<ContractTransaction> {
      return batchTradeExtension.connect(subjectCaller.wallet).initializeModule(subjectDelegatedManager);
    }

    it("should initialize the module on the SetToken", async () => {
      await subject();

      const isModuleInitialized: Boolean = await setToken.isInitializedModule(tradeModule.address);
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
        await delegatedManager.connect(owner.wallet).removeExtensions([batchTradeExtension.address]);
        await delegatedManager.connect(owner.wallet).setManager(owner.address);
        await setToken.connect(owner.wallet).removeModule(tradeModule.address);
        await setToken.connect(owner.wallet).setManager(delegatedManager.address);
        await delegatedManager.connect(owner.wallet).addExtensions([batchTradeExtension.address]);
        await batchTradeExtension.connect(owner.wallet).initializeExtension(delegatedManager.address);
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
        await delegatedManager.connect(owner.wallet).removeExtensions([batchTradeExtension.address]);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be initialized extension");
      });
    });

    describe("when the extension is pending", async () => {
      beforeEach(async () => {
        await delegatedManager.connect(owner.wallet).removeExtensions([batchTradeExtension.address]);
        await delegatedManager.connect(owner.wallet).addExtensions([batchTradeExtension.address]);
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
      return batchTradeExtension.connect(subjectCaller.wallet).initializeExtension(subjectDelegatedManager);
    }

    it("should store the correct SetToken and DelegatedManager on the BatchTradeExtension", async () => {
      await subject();

      const storedDelegatedManager: Address = await batchTradeExtension.setManagers(setToken.address);
      expect(storedDelegatedManager).to.eq(delegatedManager.address);
    });

    it("should initialize the BatchTradeExtension on the DelegatedManager", async () => {
      await subject();

      const isExtensionInitialized: Boolean = await delegatedManager.isInitializedExtension(batchTradeExtension.address);
      expect(isExtensionInitialized).to.eq(true);
    });

    it("should emit the correct BatchTradeExtensionInitialized event", async () => {
      await expect(subject()).to.emit(batchTradeExtension, "BatchTradeExtensionInitialized").withArgs(
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
        await batchTradeExtension.connect(owner.wallet).initializeExtension(delegatedManager.address);
        await delegatedManager.connect(owner.wallet).removeExtensions([batchTradeExtension.address]);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Extension must be pending");
      });
    });

    describe("when the extension is already initialized", async () => {
      beforeEach(async () => {
        await batchTradeExtension.connect(owner.wallet).initializeExtension(delegatedManager.address);
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
      return batchTradeExtension.connect(subjectCaller.wallet).initializeModuleAndExtension(subjectDelegatedManager);
    }

    it("should initialize the module on the SetToken", async () => {
      await subject();

      const isModuleInitialized: Boolean = await setToken.isInitializedModule(tradeModule.address);
      expect(isModuleInitialized).to.eq(true);
    });

    it("should store the correct SetToken and DelegatedManager on the BatchTradeExtension", async () => {
      await subject();

      const storedDelegatedManager: Address = await batchTradeExtension.setManagers(setToken.address);
      expect(storedDelegatedManager).to.eq(delegatedManager.address);
    });

    it("should initialize the BatchTradeExtension on the DelegatedManager", async () => {
      await subject();

      const isExtensionInitialized: Boolean = await delegatedManager.isInitializedExtension(batchTradeExtension.address);
      expect(isExtensionInitialized).to.eq(true);
    });

    it("should emit the correct BatchTradeExtensionInitialized event", async () => {
      await expect(subject()).to.emit(batchTradeExtension, "BatchTradeExtensionInitialized").withArgs(
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
        await batchTradeExtension.connect(owner.wallet).initializeModuleAndExtension(delegatedManager.address);
        await delegatedManager.connect(owner.wallet).removeExtensions([batchTradeExtension.address]);
        await delegatedManager.connect(owner.wallet).setManager(owner.address);
        await setToken.connect(owner.wallet).removeModule(tradeModule.address);
        await setToken.connect(owner.wallet).setManager(delegatedManager.address);
        await delegatedManager.connect(owner.wallet).addExtensions([batchTradeExtension.address]);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be pending initialization");
      });
    });

    describe("when the module is already initialized", async () => {
      beforeEach(async () => {
        await batchTradeExtension.connect(owner.wallet).initializeModuleAndExtension(delegatedManager.address);
        await delegatedManager.connect(owner.wallet).removeExtensions([batchTradeExtension.address]);
        await delegatedManager.connect(owner.wallet).addExtensions([batchTradeExtension.address]);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be pending initialization");
      });
    });

    describe("when the extension is not pending or initialized", async () => {
      beforeEach(async () => {
        await batchTradeExtension.connect(owner.wallet).initializeExtension(delegatedManager.address);
        await delegatedManager.connect(owner.wallet).removeExtensions([batchTradeExtension.address]);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Extension must be pending");
      });
    });

    describe("when the extension is already initialized", async () => {
      beforeEach(async () => {
        await batchTradeExtension.connect(owner.wallet).initializeExtension(delegatedManager.address);
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
    let subjectBatchTradeExtension: Address[];
    let subjectCaller: Account;

    beforeEach(async () => {
      await batchTradeExtension.connect(owner.wallet).initializeExtension(delegatedManager.address);

      subjectManager = delegatedManager;
      subjectBatchTradeExtension = [batchTradeExtension.address];
      subjectCaller = owner;
    });

    async function subject(): Promise<ContractTransaction> {
      return subjectManager.connect(subjectCaller.wallet).removeExtensions(subjectBatchTradeExtension);
    }

    it("should clear SetToken and DelegatedManager from BatchTradeExtension state", async () => {
      await subject();

      const storedDelegatedManager: Address = await batchTradeExtension.setManagers(setToken.address);
      expect(storedDelegatedManager).to.eq(ADDRESS_ZERO);
    });

    it("should emit the correct ExtensionRemoved event", async () => {
      await expect(subject()).to.emit(batchTradeExtension, "ExtensionRemoved").withArgs(
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

  describe("#batchTrade", async () => {
    let mintedTokens: BigNumber;
    let subjectSetToken: Address;
    let subjectTradeOne: TradeInfo;
    let subjectTradeTwo: TradeInfo;
    let subjectTrades: TradeInfo[];
    let subjectCaller: Account;

    beforeEach(async () => {
      await batchTradeExtension.connect(owner.wallet).initializeModuleAndExtension(delegatedManager.address);

      mintedTokens = ether(1);
      await setV2Setup.dai.approve(setV2Setup.issuanceModule.address, ether(1));
      await setV2Setup.issuanceModule.issue(setToken.address, mintedTokens, owner.address);

      // Fund TradeAdapter with destinationTokens WBTC, WETH and DAI
      await setV2Setup.wbtc.transfer(tradeMock.address, ether(1));
      await setV2Setup.weth.transfer(tradeMock.address, ether(10));
      await setV2Setup.dai.transfer(tradeMock.address, ether(10));

      subjectCaller = operator;
      subjectSetToken = setToken.address;
      subjectTradeOne = {
        exchangeName: tradeAdapterName,
        sendToken: setV2Setup.dai.address,
        sendQuantity: ether(0.6),
        receiveToken: setV2Setup.weth.address,
        receiveQuantity: ether(0),
        data: EMPTY_BYTES
      } as TradeInfo;
      subjectTradeTwo = {
        exchangeName: tradeAdapterName,
        sendToken: setV2Setup.dai.address,
        sendQuantity: ether(0.4),
        receiveToken: setV2Setup.wbtc.address,
        receiveQuantity: ether(0),
        data: EMPTY_BYTES
      } as TradeInfo;
      subjectTrades = [subjectTradeOne, subjectTradeTwo];
    });

    async function subject(): Promise<ContractTransaction> {
      return batchTradeExtension.connect(subjectCaller.wallet).batchTrade(
        subjectSetToken,
        subjectTrades
      );
    }

    it("should successfully execute the trades", async () => {
      const oldSendTokenBalance = await setV2Setup.dai.balanceOf(setToken.address);
      const oldReceiveTokenOneBalance = await setV2Setup.weth.balanceOf(setToken.address);
      const oldReceiveTokenTwoBalance = await setV2Setup.wbtc.balanceOf(setToken.address);

      await subject();

      const expectedNewSendTokenBalance = oldSendTokenBalance.sub(ether(1.0));
      const actualNewSendTokenBalance = await setV2Setup.dai.balanceOf(setToken.address);
      const expectedNewReceiveTokenOneBalance = oldReceiveTokenOneBalance.add(ether(10));
      const actualNewReceiveTokenOneBalance = await setV2Setup.weth.balanceOf(setToken.address);
      const expectedNewReceiveTokenTwoBalance = oldReceiveTokenTwoBalance.add(ether(1));
      const actualNewReceiveTokenTwoBalance = await setV2Setup.wbtc.balanceOf(setToken.address);

      expect(expectedNewSendTokenBalance).to.eq(actualNewSendTokenBalance);
      expect(expectedNewReceiveTokenOneBalance).to.eq(actualNewReceiveTokenOneBalance);
      expect(expectedNewReceiveTokenTwoBalance).to.eq(actualNewReceiveTokenTwoBalance);
    });

    describe("when the sender is not an operator", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be approved operator");
      });
    });

    describe("when a trade fails with a string error", async () => {
      beforeEach(async () => {
        subjectTradeTwo = {
          exchangeName: tradeAdapterName,
          sendToken: setV2Setup.dai.address,
          sendQuantity: ether(0.4),
          receiveToken: setV2Setup.wbtc.address,
          receiveQuantity: ether(2),
          data: EMPTY_BYTES
        } as TradeInfo;
        subjectTrades = [subjectTradeOne, subjectTradeTwo];
      });

      it("should perform the other trades", async () => {
        const oldSendTokenBalance = await setV2Setup.dai.balanceOf(setToken.address);
        const oldReceiveTokenOneBalance = await setV2Setup.weth.balanceOf(setToken.address);
        const oldReceiveTokenTwoBalance = await setV2Setup.wbtc.balanceOf(setToken.address);

        await subject();

        const expectedNewSendTokenBalance = oldSendTokenBalance.sub(ether(0.6));
        const actualNewSendTokenBalance = await setV2Setup.dai.balanceOf(setToken.address);
        const expectedNewReceiveTokenOneBalance = oldReceiveTokenOneBalance.add(ether(10));
        const actualNewReceiveTokenOneBalance = await setV2Setup.weth.balanceOf(setToken.address);
        const actualNewReceiveTokenTwoBalance = await setV2Setup.wbtc.balanceOf(setToken.address);

        expect(expectedNewSendTokenBalance).to.eq(actualNewSendTokenBalance);
        expect(expectedNewReceiveTokenOneBalance).to.eq(actualNewReceiveTokenOneBalance);
        expect(oldReceiveTokenTwoBalance).to.eq(actualNewReceiveTokenTwoBalance);
      });

      it("should emit the correct TradeFailed event", async () => {
        await expect(subject()).to.emit(batchTradeExtension, "StringTradeFailed").withArgs(
          setToken.address,
          1,
          "Insufficient funds in exchange"
        );
      });
    });

    describe("when a trade fails with a byte error", async () => {
      beforeEach(async () => {
        subjectTradeTwo = {
          exchangeName: tradeAdapterName,
          sendToken: setV2Setup.dai.address,
          sendQuantity: ether(0.4),
          receiveToken: setV2Setup.wbtc.address,
          receiveQuantity: BigNumber.from(1),
          data: EMPTY_BYTES
        } as TradeInfo;
        subjectTrades = [subjectTradeOne, subjectTradeTwo];
      });

      it("should perform the other trades", async () => {
        const oldSendTokenBalance = await setV2Setup.dai.balanceOf(setToken.address);
        const oldReceiveTokenOneBalance = await setV2Setup.weth.balanceOf(setToken.address);
        const oldReceiveTokenTwoBalance = await setV2Setup.wbtc.balanceOf(setToken.address);

        await subject();

        const expectedNewSendTokenBalance = oldSendTokenBalance.sub(ether(0.6));
        const actualNewSendTokenBalance = await setV2Setup.dai.balanceOf(setToken.address);
        const expectedNewReceiveTokenOneBalance = oldReceiveTokenOneBalance.add(ether(10));
        const actualNewReceiveTokenOneBalance = await setV2Setup.weth.balanceOf(setToken.address);
        const actualNewReceiveTokenTwoBalance = await setV2Setup.wbtc.balanceOf(setToken.address);

        expect(expectedNewSendTokenBalance).to.eq(actualNewSendTokenBalance);
        expect(expectedNewReceiveTokenOneBalance).to.eq(actualNewReceiveTokenOneBalance);
        expect(oldReceiveTokenTwoBalance).to.eq(actualNewReceiveTokenTwoBalance);
      });

      it("should emit the correct BytesTradeFailed event", async () => {
        const expectedByteError = tradeMock.interface.encodeFunctionData("trade", [
          setV2Setup.dai.address,
          setV2Setup.wbtc.address,
          setToken.address,
          ether(0.4),
          BigNumber.from(1)
        ]);

        await expect(subject()).to.emit(batchTradeExtension, "BytesTradeFailed").withArgs(
          setToken.address,
          1,
          expectedByteError
        );
      });
    });

    describe("when a receiveToken is not an allowed asset", async () => {
      beforeEach(async () => {
        subjectTradeTwo = {
          exchangeName: tradeAdapterName,
          sendToken: setV2Setup.dai.address,
          sendQuantity: ether(0.4),
          receiveToken: setV2Setup.usdc.address,
          receiveQuantity: ether(0),
          data: EMPTY_BYTES
        } as TradeInfo;
        subjectTrades = [subjectTradeOne, subjectTradeTwo];
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be allowed asset");
      });
    });
  });
});