import "module-alias/register";

import { BigNumber } from "ethers";
import { Address, Account, StreamingFeeState } from "@utils/types";
import { ADDRESS_ZERO } from "@utils/constants";
import { DelegatedManager, StreamingFeeSplitExtension } from "@utils/contracts/index";
import { SetToken, StreamingFeeModule } from "@setprotocol/set-protocol-v2/utils/contracts";
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

describe.only("StreamingFeeSplitExtension", () => {
  let owner: Account;
  let methodologist: Account;
  let operator: Account;
  let factory: Account;
  
  let deployer: DeployHelper;
  let setToken: SetToken;
  let setV2Setup: SystemFixture;
    
  let delegatedManager: DelegatedManager;
  let streamingFeeSplitExtension: StreamingFeeSplitExtension;

  let feeRecipient: Address;
  let maxStreamingFeePercentage: BigNumber;
  let streamingFeePercentage: BigNumber;
  let feeSettings: StreamingFeeState;
  
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
  
    streamingFeeSplitExtension = await deployer.globalExtensions.deployStreamingFeeSplitExtension(setV2Setup.streamingFeeModule.address);
  
    setToken = await setV2Setup.createSetToken(
      [setV2Setup.dai.address],
      [ether(1)],
      [setV2Setup.issuanceModule.address, setV2Setup.streamingFeeModule.address]
    );
  
    await setV2Setup.issuanceModule.initialize(setToken.address, ADDRESS_ZERO);
  
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

    feeRecipient = delegatedManager.address;
    maxStreamingFeePercentage = ether(.1);
    streamingFeePercentage = ether(.02);

    feeSettings = {
      feeRecipient,
      maxStreamingFeePercentage,
      streamingFeePercentage,
      lastStreamingFeeTimestamp: ZERO,
    } as StreamingFeeState;
  });
  
  addSnapshotBeforeRestoreAfterEach();

  describe("#testInitializeExtension", async () => {
    let subjectDelegatedManager: Address;
    let subjectCaller: Account;
    
    async function subject(): Promise<ContractTransaction> {
      return streamingFeeSplitExtension.connect(subjectCaller.wallet).initializeExtension(subjectDelegatedManager);
    }
    
    describe("when the sender is the owner", async () => {
      beforeEach(async () => {
        subjectCaller = owner;
        subjectDelegatedManager = delegatedManager.address;
    
        // Put StreamingFeeSplitExtension in PENDING state on DelegatedManager
        await delegatedManager.addExtensions([streamingFeeSplitExtension.address]);
      });
    
      it("should succeed without revert", async () => {
        await subject();
      });
    });
    
    describe("when the sender is not the owner", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
        subjectDelegatedManager = delegatedManager.address;
    
        // Put StreamingFeeSplitExtension in PENDING state on DelegatedManager
        await delegatedManager.addExtensions([streamingFeeSplitExtension.address]);
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
    
        // Put StreamingFeeSplitExtension in PENDING state on DelegatedManager
        await delegatedManager.addExtensions([streamingFeeSplitExtension.address]);
      });
    
      it("should succeed without revert", async () => {
        await subject();
      });
    });
    
    describe("when the extension is already initialized", async () => {
      beforeEach(async () => {
        subjectCaller = owner;
        subjectDelegatedManager = delegatedManager.address;
    
        // Put StreamingFeeSplitExtension in PENDING state on DelegatedManager
        await delegatedManager.addExtensions([streamingFeeSplitExtension.address]);
    
        // Initialize StreamingFeeSplitExtension
        streamingFeeSplitExtension.initializeExtension(subjectDelegatedManager)
      });
    
      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Extension must be pending");
      });
    });
    
    describe("when initializeExtension completes successfully", async () => {
      beforeEach(async () => {
        subjectCaller = owner;
        subjectDelegatedManager = delegatedManager.address;
    
        // Put StreamingFeeSplitExtension in PENDING state on DelegatedManager
        await delegatedManager.addExtensions([streamingFeeSplitExtension.address]);
      });
    
      it("should store the correct SetToken and DelegatedManager on the StreamingFeeSplitExtension", async () => {
        await subject();
    
        const storedDelegatedManager: Address = await streamingFeeSplitExtension.setManagers(setToken.address);
        expect(storedDelegatedManager).to.eq(delegatedManager.address);
      });
    
      it("should initialize the extension on the DelegatedManager", async () => {
        await subject();
    
        const isExtensionInitialized: Boolean = await delegatedManager.isInitializedExtension(streamingFeeSplitExtension.address);
        expect(isExtensionInitialized).to.eq(true);
      });
    
      it("should emit the correct ExtensionInitialized event", async () => {
        await expect(subject()).to.emit(streamingFeeSplitExtension, "ExtensionInitialized").withArgs(setToken.address, delegatedManager.address);
      });
    })
  });

  describe("#testInitializeModuleAndExtension", async () => {
    let subjectDelegatedManager: Address;
    let subjectCaller: Account;
      
    async function subject(): Promise<ContractTransaction> {
      return streamingFeeSplitExtension.connect(subjectCaller.wallet).initializeModuleAndExtension(subjectDelegatedManager, feeSettings);
    }
      
    describe("when the sender is the owner", async () => {
      beforeEach(async () => {
        subjectCaller = owner;
        subjectDelegatedManager = delegatedManager.address;
      
        // Put StreamingFeeSplitExtension in PENDING state on DelegatedManager
        await delegatedManager.addExtensions([streamingFeeSplitExtension.address]);
      });
      
      it("should succeed without revert", async () => {
        await subject();
      });
    });
      
    describe("when the sender is not the owner", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
        subjectDelegatedManager = delegatedManager.address;
      
        // Put StreamingFeeSplitExtension in PENDING state on DelegatedManager
        await delegatedManager.addExtensions([streamingFeeSplitExtension.address]);
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
      
        // Put StreamingFeeSplitExtension in PENDING state on DelegatedManager
        await delegatedManager.addExtensions([streamingFeeSplitExtension.address]);
      });
      
      it("should succeed without revert", async () => {
        await subject();
      });
    });
      
    describe("when the extension is already initialized", async () => {
      beforeEach(async () => {
        subjectCaller = owner;
        subjectDelegatedManager = delegatedManager.address;
      
        // Put StreamingFeeSplitExtension in PENDING state on DelegatedManager
        await delegatedManager.addExtensions([streamingFeeSplitExtension.address]);
      
        // Initialize StreamingFeeSplitExtension
        streamingFeeSplitExtension.initializeExtension(subjectDelegatedManager);
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
          [setV2Setup.issuanceModule.address]
        );

        delegatedManager2 = await deployer.manager.deployDelegatedManager(
          setToken2.address,
          factory.address,
          methodologist.address,
          [streamingFeeSplitExtension.address],
          [operator.address],
          [setV2Setup.usdc.address, setV2Setup.weth.address],
          true
        );

        await setToken2.setManager(delegatedManager2.address);

        subjectCaller = owner;
        subjectDelegatedManager = delegatedManager2.address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("StreamingFeeModule must be pending");
      });
    });

    describe("when the module is pending", async () => {
      beforeEach(async () => {
        subjectCaller = owner;
        subjectDelegatedManager = delegatedManager.address;

        // Put StreamingFeeSplitExtension in PENDING state on DelegatedManager
        await delegatedManager.addExtensions([streamingFeeSplitExtension.address]);
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
          [setV2Setup.issuanceModule.address, setV2Setup.streamingFeeModule.address]
        );

        await setV2Setup.streamingFeeModule.initialize(setToken3.address, feeSettings);

        delegatedManager3 = await deployer.manager.deployDelegatedManager(
          setToken3.address,
          factory.address,
          methodologist.address,
          [streamingFeeSplitExtension.address],
          [operator.address],
          [setV2Setup.usdc.address, setV2Setup.weth.address],
          true
        );

        await setToken3.setManager(delegatedManager3.address);

        subjectCaller = owner;
        subjectDelegatedManager = delegatedManager3.address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("StreamingFeeModule must be pending");
      });
    })
      
    describe("when initializeModuleAndExtension completes successfully", async () => {
      beforeEach(async () => {
        subjectCaller = owner;
        subjectDelegatedManager = delegatedManager.address;
      
        // Put StreamingFeeSplitExtension in PENDING state on DelegatedManager
        await delegatedManager.addExtensions([streamingFeeSplitExtension.address]);
      });

      it("should correctly initialize the StreamingFeeModule on the SetToken", async () => {
        const txTimestamp = await getTransactionTimestamp(subject());

        const isModuleInitialized: Boolean = await setToken.isInitializedModule(setV2Setup.streamingFeeModule.address);
        expect(isModuleInitialized).to.eq(true);

        const storedFeeState: StreamingFeeState = await setV2Setup.streamingFeeModule.feeStates(setToken.address);
        expect(storedFeeState.feeRecipient).to.eq(feeRecipient);
        expect(storedFeeState.maxStreamingFeePercentage).to.eq(maxStreamingFeePercentage);
        expect(storedFeeState.streamingFeePercentage).to.eq(streamingFeePercentage);
        expect(storedFeeState.lastStreamingFeeTimestamp).to.eq(txTimestamp);
      });
      
      it("should store the correct SetToken and DelegatedManager on the StreamingFeeSplitExtension", async () => {
        await subject();
      
        const storedDelegatedManager: Address = await streamingFeeSplitExtension.setManagers(setToken.address);
        expect(storedDelegatedManager).to.eq(delegatedManager.address);
      });
      
      it("should initialize the extension on the DelegatedManager", async () => {
        await subject();
      
        const isExtensionInitialized: Boolean = await delegatedManager.isInitializedExtension(streamingFeeSplitExtension.address);
        expect(isExtensionInitialized).to.eq(true);
      });

      it("should emit the correct ModuleInitialized event", async () => {
        await expect(subject()).to.emit(setToken, "ModuleInitialized").withArgs(setV2Setup.streamingFeeModule.address);
      });
      
      it("should emit the correct ExtensionInitialized event", async () => {
        await expect(subject()).to.emit(streamingFeeSplitExtension, "ExtensionInitialized").withArgs(setToken.address, delegatedManager.address);
      });
    })
  });
});