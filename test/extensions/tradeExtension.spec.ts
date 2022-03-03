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

describe.only("TradeExtension", () => {
  let owner: Account;
  let methodologist: Account;
  let operator: Account;
  let factory: Account;

  let deployer: DeployHelper;
  let setToken1: SetToken;
  let setToken2: SetToken;
  let setToken3: SetToken;
  let setToken4: SetToken;
  let setToken5: SetToken;
  let setToken6: SetToken;
  let setToken7: SetToken;
  let setV2Setup: SystemFixture;

  let tradeModule: TradeModule;

  let delegatedManager1: DelegatedManager;
  let delegatedManager2: DelegatedManager;
  let delegatedManager3: DelegatedManager;
  let delegatedManager4: DelegatedManager;
  let delegatedManager5: DelegatedManager;
  let delegatedManager6: DelegatedManager;
  let delegatedManager7: DelegatedManager;
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

    // SetToken + DelegatedManager: TradeModule initialized, TradeExtension pending
    setToken1 = await setV2Setup.createSetToken(
      [setV2Setup.dai.address],
      [ether(1)],
      [setV2Setup.issuanceModule.address, tradeModule.address]
    );

    await setV2Setup.issuanceModule.initialize(setToken1.address, ADDRESS_ZERO);
    await tradeModule.initialize(setToken1.address);

    delegatedManager1 = await deployer.manager.deployDelegatedManager(
      setToken1.address,
      factory.address,
      methodologist.address,
      [tradeExtension.address],
      [operator.address],
      [setV2Setup.usdc.address, setV2Setup.weth.address],
      true
    );

    await setToken1.setManager(delegatedManager1.address);

    // SetToken + DelegatedManager: TradeMode initialized, TradeExtension not pending
    setToken2 = await setV2Setup.createSetToken(
      [setV2Setup.dai.address],
      [ether(1)],
      [setV2Setup.issuanceModule.address, tradeModule.address]
    );

    await setV2Setup.issuanceModule.initialize(setToken2.address, ADDRESS_ZERO);
    await tradeModule.initialize(setToken2.address);

    delegatedManager2 = await deployer.manager.deployDelegatedManager(
      setToken2.address,
      factory.address,
      methodologist.address,
      [],
      [operator.address],
      [setV2Setup.usdc.address, setV2Setup.weth.address],
      true
    );

    await setToken2.setManager(delegatedManager2.address);

    // SetToken + DelegatedManager: TradeModule not initialized, TradeExtension pending
    setToken3 = await setV2Setup.createSetToken(
      [setV2Setup.dai.address],
      [ether(1)],
      [setV2Setup.issuanceModule.address, tradeModule.address]
    );

    await setV2Setup.issuanceModule.initialize(setToken3.address, ADDRESS_ZERO);

    delegatedManager3 = await deployer.manager.deployDelegatedManager(
      setToken3.address,
      factory.address,
      methodologist.address,
      [tradeExtension.address],
      [operator.address],
      [setV2Setup.usdc.address, setV2Setup.weth.address],
      true
    );

    await setToken3.setManager(delegatedManager3.address);

    // SetToken + DelegatedManager: TradeModule not initialized, TradeExtension not pending
    setToken4 = await setV2Setup.createSetToken(
      [setV2Setup.dai.address],
      [ether(1)],
      [setV2Setup.issuanceModule.address, tradeModule.address]
    );

    await setV2Setup.issuanceModule.initialize(setToken4.address, ADDRESS_ZERO);

    delegatedManager4 = await deployer.manager.deployDelegatedManager(
      setToken4.address,
      factory.address,
      methodologist.address,
      [],
      [operator.address],
      [setV2Setup.usdc.address, setV2Setup.weth.address],
      true
    );

    await setToken4.setManager(delegatedManager4.address);

    // SetToken + DelegatedManager: No TradeModule, TradeExtension not pending
    setToken5 = await setV2Setup.createSetToken(
      [setV2Setup.dai.address],
      [ether(1)],
      [setV2Setup.issuanceModule.address]
    );

    await setV2Setup.issuanceModule.initialize(setToken5.address, ADDRESS_ZERO);

    delegatedManager5 = await deployer.manager.deployDelegatedManager(
      setToken5.address,
      factory.address,
      methodologist.address,
      [],
      [operator.address],
      [setV2Setup.usdc.address, setV2Setup.weth.address],
      true
    );

    await setToken5.setManager(delegatedManager5.address);

    // SetToken + DelegatedManager: TradeModule initialized, TradeExtension initialized
    setToken6 = await setV2Setup.createSetToken(
      [setV2Setup.dai.address],
      [ether(1)],
      [setV2Setup.issuanceModule.address, tradeModule.address]
    );

    await setV2Setup.issuanceModule.initialize(setToken6.address, ADDRESS_ZERO);
    await tradeModule.initialize(setToken6.address);

    delegatedManager6 = await deployer.manager.deployDelegatedManager(
      setToken6.address,
      factory.address,
      methodologist.address,
      [tradeExtension.address],
      [operator.address],
      [setV2Setup.usdc.address, setV2Setup.weth.address],
      true
    );

    await setToken6.setManager(delegatedManager6.address);

    await tradeExtension.initializeExtension(delegatedManager6.address);

    // SetToken + DelegatedManager: TradeModule pending, TradeExtension initialized
    setToken7 = await setV2Setup.createSetToken(
      [setV2Setup.dai.address],
      [ether(1)],
      [setV2Setup.issuanceModule.address, tradeModule.address]
    );

    await setV2Setup.issuanceModule.initialize(setToken7.address, ADDRESS_ZERO);

    delegatedManager7 = await deployer.manager.deployDelegatedManager(
      setToken7.address,
      factory.address,
      methodologist.address,
      [tradeExtension.address],
      [operator.address],
      [setV2Setup.usdc.address, setV2Setup.weth.address],
      true
    );

    await setToken7.setManager(delegatedManager6.address);

    await tradeExtension.initializeExtension(delegatedManager7.address);
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#testInitializeExtension", async () => {
    let subjectDelegatedManager: Address;
    let subjectCaller: Account;

    async function subject(): Promise<ContractTransaction> {
      return tradeExtension.connect(subjectCaller.wallet).initializeExtension(subjectDelegatedManager);
    }

    describe("when the sender is the owner", async () => {
      beforeEach(async () => {
        subjectCaller = owner;
        subjectDelegatedManager = delegatedManager1.address;
      });

      it("should succeed without revert", async () => {
        await subject();
      });
    });

    describe("when the sender is not the owner", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
        subjectDelegatedManager = delegatedManager1.address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be owner");
      });
    });

    describe("when the extension is not pending or initialized", async () => {
      beforeEach(async () => {
        subjectCaller = owner;
        subjectDelegatedManager = delegatedManager2.address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Extension must be pending");
      });
    });

    describe("when the extension is pending", async () => {
      beforeEach(async () => {
        subjectCaller = owner;
        subjectDelegatedManager = delegatedManager1.address;
      });

      it("should succeed without revert", async () => {
        await subject();
      });
    });

    describe("when the extension is initialized", async () => {
      beforeEach(async () => {
        subjectCaller = owner;
        subjectDelegatedManager = delegatedManager6.address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Extension must be pending");
      });
    });

    describe("when the extension is initialized", async () => {
      beforeEach(async () => {
        subjectCaller = owner;
        subjectDelegatedManager = delegatedManager1.address;
      });

      it("should store the correct SetToken and DelegatedManager pair", async () => {
        await subject();

        const storedDelegatedManager: Address = await tradeExtension.setManagers(setToken1.address);
        expect(storedDelegatedManager).to.eq(delegatedManager1.address);
      });

      it("should initialize the extension on the DelegatedManager", async () => {
        await subject();

        const isExtensionInitialized: Boolean = await delegatedManager1.isInitializedExtension(tradeExtension.address);
        expect(isExtensionInitialized).to.eq(true);
      });

      it("should emit the correct ExtensionInitialized event for the SetToken and DelegatedManager pair", async () => {
        await expect(subject()).to.emit(tradeExtension, "ExtensionInitialized").withArgs(setToken1.address, delegatedManager1.address);
      });
    })
  });

  describe("#testInitializeModuleAndExtension", async () => {
    let subjectDelegatedManager: Address;
    let subjectCaller: Account;

    async function subject(): Promise<ContractTransaction> {
      return tradeExtension.connect(subjectCaller.wallet).initializeModuleAndExtension(subjectDelegatedManager);
    }

    describe("when the sender is the owner", async () => {
      beforeEach(async () => {
        subjectCaller = owner;
        subjectDelegatedManager = delegatedManager3.address;
      });

      it("should succeed without revert", async () => {
        await subject();
      });
    });

    describe("when the sender is not the owner", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
        subjectDelegatedManager = delegatedManager3.address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be owner");
      });
    });

    describe("when the extension is not pending or initialized", async () => {
      beforeEach(async () => {
        subjectCaller = owner;
        subjectDelegatedManager = delegatedManager4.address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Extension must be pending");
      });
    });

    describe("when the extension is pending", async () => {
      beforeEach(async () => {
        subjectCaller = owner;
        subjectDelegatedManager = delegatedManager3.address;
      });

      it("should succeed without revert", async () => {
        await subject();
      });
    });

    describe("when the extension is initialized", async () => {
      beforeEach(async () => {
        subjectCaller = owner;
        subjectDelegatedManager = delegatedManager7.address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Extension must be pending");
      });
    });

    describe("when the module not pending or initialized", async () => {
      beforeEach(async () => {
        subjectCaller = owner;
        subjectDelegatedManager = delegatedManager5.address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("TradeModule must be pending");
      });
    });

    describe("when the module is pending", async () => {
      beforeEach(async () => {
        subjectCaller = owner;
        subjectDelegatedManager = delegatedManager3.address;
      });

      it("should succeed without revert", async () => {
        await subject();
      });
    });

    describe("when the module is initialized", async () => {
      beforeEach(async () => {
        subjectCaller = owner;
        subjectDelegatedManager = delegatedManager2.address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("TradeModule must be pending");
      });
    });

    describe("when the module and extension is initialized", async () => {
      beforeEach(async () => {
        subjectCaller = owner;
        subjectDelegatedManager = delegatedManager3.address;
      });

      it("should initialize the module on the SetToken", async () => {
        await subject();

        const isModuleInitialized: Boolean = await setToken3.isInitializedModule(tradeModule.address);
        expect(isModuleInitialized).to.eq(true);
      });

      it("should store the correct SetToken and DelegatedManager pair", async () => {
        await subject();

        const storedDelegatedManager: Address = await tradeExtension.setManagers(setToken3.address);
        expect(storedDelegatedManager).to.eq(delegatedManager3.address);
      });

      it("should initialize the extension on the DelegatedManager", async () => {
        await subject();

        const isExtensionInitialized: Boolean = await delegatedManager3.isInitializedExtension(tradeExtension.address);
        expect(isExtensionInitialized).to.eq(true);
      });

      it("should emit the correct ExtensionInitialized event for the SetToken and DelegatedManager pair", async () => {
        await expect(subject()).to.emit(tradeExtension, "ExtensionInitialized").withArgs(setToken3.address, delegatedManager3.address);
      });
    })
  });
});