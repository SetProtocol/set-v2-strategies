import "module-alias/register";

import { Address, Account } from "@utils/types";
import { ADDRESS_ZERO } from "@utils/constants";
import { DelegatedManager, TradeExtension } from "@utils/contracts/index";
import { SetToken, TradeModule } from "@setprotocol/set-protocol-v2/utils/contracts";
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

  let delegatedManager: DelegatedManager;
  let tradeExtension: TradeExtension;

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

    tradeExtension = await deployer.globalExtensions.deployTradeExtension(tradeModule.address);

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
      [setV2Setup.usdc.address, setV2Setup.weth.address],
      true
    );

    await setToken.setManager(delegatedManager.address);
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#constructor", async () => {
    let subjectTradeModule: Address;

    beforeEach(async () => {
      subjectTradeModule = tradeModule.address;
    });

    async function subject(): Promise<TradeExtension> {
      return await deployer.globalExtensions.deployTradeExtension(subjectTradeModule);
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

    // describe("when the module is not pending or initialized", async () => {
    //   beforeEach(async () => {
    //     // initialize module
    //     // remove module
    //   });

    //   it("should revert", async () => {
    //     await expect(subject()).to.be.revertedWith("TradeModule must be pending");
    //   });
    // });

    // describe("when the module is already initialized", async () => {
    //   beforeEach(async () => {
    //     // initialize module
    //   });

    //   it("should revert", async () => {
    //     await expect(subject()).to.be.revertedWith("TradeModule must be pending");
    //   });
    // });

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
});