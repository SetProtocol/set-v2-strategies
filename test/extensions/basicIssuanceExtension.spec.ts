import "module-alias/register";

import { BigNumber } from "ethers";
import { Address, Account } from "@utils/types";
import { ADDRESS_ZERO } from "@utils/constants";
import { DelegatedManager, BasicIssuanceExtension } from "@utils/contracts/index";
import { SetToken, DebtIssuanceModule } from "@setprotocol/set-protocol-v2/utils/contracts";
import DeployHelper from "@utils/deploys";
import {
  addSnapshotBeforeRestoreAfterEach,
  ether,
  getAccounts,
  getWaffleExpect,
  getTransactionTimestamp
} from "@utils/index";
import { SystemFixture } from "@setprotocol/set-protocol-v2/utils/fixtures";
import { getSystemFixture, getRandomAccount } from "@setprotocol/set-protocol-v2/utils/test";
import { ContractTransaction } from "ethers";
import { ZERO } from "@setprotocol/set-protocol-v2/utils/constants";

const expect = getWaffleExpect();

describe.only("BasicIssuanceExtension", () => {
  let owner: Account;
  let methodologist: Account;
  let operator: Account;
  let factory: Account;
    
  let deployer: DeployHelper;
  let setToken: SetToken;
  let setV2Setup: SystemFixture;
    
  let debtIssuanceModule: DebtIssuanceModule;
    
  let delegatedManager: DelegatedManager;
  let basicIssuanceExtension: BasicIssuanceExtension;

  let maxManagerFee: BigNumber;
  let managerIssueFee: BigNumber;
  let managerRedeemFee: BigNumber;
  let feeRecipient: Address;
  let managerIssuanceHook: Address;
    
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

    
    debtIssuanceModule = await deployer.setV2.deployDebtIssuanceModule(setV2Setup.controller.address);
    await setV2Setup.controller.addModule(debtIssuanceModule.address);
    
    basicIssuanceExtension = await deployer.globalExtensions.deployBasicIssuanceExtension(debtIssuanceModule.address);
    
    setToken = await setV2Setup.createSetToken(
      [setV2Setup.dai.address],
      [ether(1)],
      [debtIssuanceModule.address]
    );
        
    delegatedManager = await deployer.manager.deployDelegatedManager(
      setToken.address,
      factory.address,
      methodologist.address,
      [],
      [operator.address],
      [setV2Setup.usdc.address, setV2Setup.weth.address],
      true
    );
    
    await setToken.setManager(delegatedManager.address);
  
    maxManagerFee = ether(.1);
    managerIssueFee = ether(.02);
    managerRedeemFee = ether(.02);
    feeRecipient = delegatedManager.address;
    managerIssuanceHook = owner.address;
  });
    
  addSnapshotBeforeRestoreAfterEach();

  describe("#testInitializeExtension", async () => {
    let subjectDelegatedManager: Address;
    let subjectCaller: Account;
    
    async function subject(): Promise<ContractTransaction> {
      return basicIssuanceExtension.connect(subjectCaller.wallet).initializeExtension(subjectDelegatedManager);
    }
    
    describe("when the sender is the owner", async () => {
      beforeEach(async () => {
        subjectCaller = owner;
        subjectDelegatedManager = delegatedManager.address;
    
        // Put BasicIssuanceExtension in PENDING state on DelegatedManager
        await delegatedManager.addExtensions([basicIssuanceExtension.address]);
      });
    
      it("should succeed without revert", async () => {
        await subject();
      });
    });
    
    describe("when the sender is not the owner", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
        subjectDelegatedManager = delegatedManager.address;
    
        // Put BasicIssuanceExtension in PENDING state on DelegatedManager
        await delegatedManager.addExtensions([basicIssuanceExtension.address]);
      });
    
      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be owner");
      });
    });
    
    describe("when the extension is not pending or initialized", async () => {
      beforeEach(async () => {
        subjectCaller = owner;
        subjectDelegatedManager = delegatedManager.address;
      });
    
      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Extension must be pending");
      });
    });
    
    describe("when the extension is pending", async () => {
      beforeEach(async () => {
        subjectCaller = owner;
        subjectDelegatedManager = delegatedManager.address;
    
        // Put BasicIssuanceExtension in PENDING state on DelegatedManager
        await delegatedManager.addExtensions([basicIssuanceExtension.address]);
      });
    
      it("should succeed without revert", async () => {
        await subject();
      });
    });
    
    describe("when the extension is already initialized", async () => {
      beforeEach(async () => {
        subjectCaller = owner;
        subjectDelegatedManager = delegatedManager.address;
    
        // Put BasicIssuanceExtension in PENDING state on DelegatedManager
        await delegatedManager.addExtensions([basicIssuanceExtension.address]);
    
        // Initialize BasicIssuanceExtension
        basicIssuanceExtension.initializeExtension(subjectDelegatedManager)
      });
    
      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Extension must be pending");
      });
    });
    
    describe("when initializeExtension completes successfully", async () => {
      beforeEach(async () => {
        subjectCaller = owner;
        subjectDelegatedManager = delegatedManager.address;
    
        // Put BasicIssuanceExtension in PENDING state on DelegatedManager
        await delegatedManager.addExtensions([basicIssuanceExtension.address]);
      });
    
      it("should store the correct SetToken and DelegatedManager on the BasicIssuanceExtension", async () => {
        await subject();
    
        const storedDelegatedManager: Address = await basicIssuanceExtension.setManagers(setToken.address);
        expect(storedDelegatedManager).to.eq(delegatedManager.address);
      });
    
      it("should initialize the extension on the DelegatedManager", async () => {
        await subject();
    
        const isExtensionInitialized: Boolean = await delegatedManager.isInitializedExtension(basicIssuanceExtension.address);
        expect(isExtensionInitialized).to.eq(true);
      });
    
      it("should emit the correct ExtensionInitialized event", async () => {
        await expect(subject()).to.emit(basicIssuanceExtension, "ExtensionInitialized").withArgs(setToken.address, delegatedManager.address);
      });
    })
  });

  describe("#testInitializeModuleAndExtension", async () => {
    let subjectDelegatedManager: Address;
    let subjectCaller: Account;
      
    async function subject(): Promise<ContractTransaction> {
      return basicIssuanceExtension.connect(subjectCaller.wallet).initializeModuleAndExtension(
          subjectDelegatedManager, 
          maxManagerFee,
          managerIssueFee,
          managerRedeemFee,
          feeRecipient,
          managerIssuanceHook
        );
    }
      
    describe("when the sender is the owner", async () => {
      beforeEach(async () => {
        subjectCaller = owner;
        subjectDelegatedManager = delegatedManager.address;
      
        // Put BasicIssuanceExtension in PENDING state on DelegatedManager
        await delegatedManager.addExtensions([basicIssuanceExtension.address]);
      });
      
      it("should succeed without revert", async () => {
        await subject();
      });
    });
      
    describe("when the sender is not the owner", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
        subjectDelegatedManager = delegatedManager.address;
      
        // Put BasicIssuanceExtension in PENDING state on DelegatedManager
        await delegatedManager.addExtensions([basicIssuanceExtension.address]);
      });
      
      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be owner");
      });
    });
      
    describe("when the extension is not pending or initialized", async () => {
      beforeEach(async () => {
        subjectCaller = owner;
        subjectDelegatedManager = delegatedManager.address;
      });
      
      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Extension must be pending");
      });
    });
      
    describe("when the extension is pending", async () => {
      beforeEach(async () => {
        subjectCaller = owner;
        subjectDelegatedManager = delegatedManager.address;
      
        // Put BasicIssuanceExtension in PENDING state on DelegatedManager
        await delegatedManager.addExtensions([basicIssuanceExtension.address]);
      });
      
      it("should succeed without revert", async () => {
        await subject();
      });
    });
      
    describe("when the extension is already initialized", async () => {
      beforeEach(async () => {
        subjectCaller = owner;
        subjectDelegatedManager = delegatedManager.address;
      
        // Put BasicIssuanceExtension in PENDING state on DelegatedManager
        await delegatedManager.addExtensions([basicIssuanceExtension.address]);
      
        // Initialize BasicIssuanceExtension
        basicIssuanceExtension.initializeExtension(subjectDelegatedManager);
      });
      
      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Extension must be pending");
      });
    });

    describe("when the module is not pending or initialized", async () => {
      let setToken2: SetToken;
      let delegatedManager2: DelegatedManager;

      beforeEach(async () => {
        setToken2 = await setV2Setup.createSetToken(
          [setV2Setup.dai.address],
          [ether(1)],
          [setV2Setup.streamingFeeModule.address]
        );

        delegatedManager2 = await deployer.manager.deployDelegatedManager(
          setToken2.address,
          factory.address,
          methodologist.address,
          [basicIssuanceExtension.address],
          [operator.address],
          [setV2Setup.usdc.address, setV2Setup.weth.address],
          true
        );

        await setToken2.setManager(delegatedManager2.address);

        subjectCaller = owner;
        subjectDelegatedManager = delegatedManager2.address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("BasicIssuanceModule must be pending");
      });
    });

    describe("when the module is pending", async () => {
      beforeEach(async () => {
        subjectCaller = owner;
        subjectDelegatedManager = delegatedManager.address;

        // Put BasicIssuanceExtension in PENDING state on DelegatedManager
        await delegatedManager.addExtensions([basicIssuanceExtension.address]);
      });

      it("should succeed without revert", async () => {
        await subject();
      });
    });

    describe("when the module is already initialized", async () => {
      let setToken3: SetToken;
      let delegatedManager3: DelegatedManager;

      beforeEach(async () => {
        setToken3 = await setV2Setup.createSetToken(
          [setV2Setup.dai.address],
          [ether(1)],
          [debtIssuanceModule.address]
        );

        await debtIssuanceModule.initialize(
          setToken3.address,
          maxManagerFee,
          managerIssueFee,
          managerRedeemFee,
          feeRecipient,
          managerIssuanceHook
        );

        delegatedManager3 = await deployer.manager.deployDelegatedManager(
          setToken3.address,
          factory.address,
          methodologist.address,
          [basicIssuanceExtension.address],
          [operator.address],
          [setV2Setup.usdc.address, setV2Setup.weth.address],
          true
        );

        await setToken3.setManager(delegatedManager3.address);

        subjectCaller = owner;
        subjectDelegatedManager = delegatedManager3.address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("BasicIssuanceModule must be pending");
      });
    })
      
    describe("when initializeModuleAndExtension completes successfully", async () => {
      beforeEach(async () => {
        subjectCaller = owner;
        subjectDelegatedManager = delegatedManager.address;
      
        // Put BasicIssuanceExtension in PENDING state on DelegatedManager
        await delegatedManager.addExtensions([basicIssuanceExtension.address]);
      });

      it("should correctly initialize the BasicIssuanceModule on the SetToken", async () => {
        const txTimestamp = await getTransactionTimestamp(subject());

        const isModuleInitialized: Boolean = await setToken.isInitializedModule(debtIssuanceModule.address);
        expect(isModuleInitialized).to.eq(true);

        const storedSettings: any = await debtIssuanceModule.issuanceSettings(setToken.address);

        expect(storedSettings.maxManagerFee).to.eq(maxManagerFee);
        expect(storedSettings.managerIssueFee).to.eq(managerIssueFee);
        expect(storedSettings.managerRedeemFee).to.eq(managerRedeemFee);
        expect(storedSettings.feeRecipient).to.eq(feeRecipient);
        expect(storedSettings.managerIssuanceHook).to.eq(managerIssuanceHook);
      });
      
      it("should store the correct SetToken and DelegatedManager on the BasicIssuanceExtension", async () => {
        await subject();
      
        const storedDelegatedManager: Address = await basicIssuanceExtension.setManagers(setToken.address);
        expect(storedDelegatedManager).to.eq(delegatedManager.address);
      });
      
      it("should initialize the extension on the DelegatedManager", async () => {
        await subject();
      
        const isExtensionInitialized: Boolean = await delegatedManager.isInitializedExtension(basicIssuanceExtension.address);
        expect(isExtensionInitialized).to.eq(true);
      });

      it("should emit the correct ModuleInitialized event", async () => {
        await expect(subject()).to.emit(setToken, "ModuleInitialized").withArgs(debtIssuanceModule.address);
      });
      
      it("should emit the correct ExtensionInitialized event", async () => {
        await expect(subject()).to.emit(basicIssuanceExtension, "ExtensionInitialized").withArgs(setToken.address, delegatedManager.address);
      });
    })
  });
});