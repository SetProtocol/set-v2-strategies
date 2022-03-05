import "module-alias/register";

import { BigNumber } from "ethers";
import { Address, Account, StreamingFeeState } from "@utils/types";
import { ADDRESS_ZERO, ONE_YEAR_IN_SECONDS } from "@utils/constants";
import { DelegatedManager, StreamingFeeSplitExtension } from "@utils/contracts/index";
import { SetToken } from "@setprotocol/set-protocol-v2/utils/contracts";
import DeployHelper from "@utils/deploys";
import {
  addSnapshotBeforeRestoreAfterEach,
  ether,
  getAccounts,
  getWaffleExpect,
  increaseTimeAsync,
  preciseMul,
  getTransactionTimestamp
} from "@utils/index";
import { getStreamingFee, getStreamingFeeInflationAmount } from "@utils/common";
import { SystemFixture } from "@setprotocol/set-protocol-v2/utils/fixtures";
import { getSystemFixture, getRandomAccount } from "@setprotocol/set-protocol-v2/utils/test";
import { ContractTransaction } from "ethers";
import { ZERO } from "@setprotocol/set-protocol-v2/utils/constants";

const expect = getWaffleExpect();

describe("StreamingFeeSplitExtension", () => {
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

  let ownerFeeSplit: BigNumber;
  let ownerFeeRecipient: Address;

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
      [streamingFeeSplitExtension.address],
      [operator.address],
      [setV2Setup.usdc.address, setV2Setup.weth.address],
      true
    );

    ownerFeeSplit = ether(0.1);
    await delegatedManager.updateOwnerFeeSplit(ownerFeeSplit);
    ownerFeeRecipient = owner.address;
    await delegatedManager.updateOwnerFeeRecipient(ownerFeeRecipient);

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

  describe("#constructor", async () => {
    let subjectStreamingFeeModule: Address;

    beforeEach(async () => {
      subjectStreamingFeeModule = setV2Setup.streamingFeeModule.address;
    });

    async function subject(): Promise<StreamingFeeSplitExtension> {
      return await deployer.globalExtensions.deployStreamingFeeSplitExtension(subjectStreamingFeeModule);
    }

    it("should set the correct StreamingFeeModule address", async () => {
      const streamingFeeSplitExtension = await subject();

      const storedModule = await streamingFeeSplitExtension.streamingFeeModule();
      expect(storedModule).to.eq(subjectStreamingFeeModule);
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
      return streamingFeeSplitExtension.connect(subjectCaller.wallet).initializeExtension(subjectDelegatedManager);
    }

    it("should store the correct SetToken and DelegatedManager on the StreamingFeeSplitExtension", async () => {
      await subject();

      const storedDelegatedManager: Address = await streamingFeeSplitExtension.setManagers(setToken.address);
      expect(storedDelegatedManager).to.eq(delegatedManager.address);
    });

    it("should initialize the StreamingFeeSplitExtension on the DelegatedManager", async () => {
      await subject();

      const isExtensionInitialized: Boolean = await delegatedManager.isInitializedExtension(streamingFeeSplitExtension.address);
      expect(isExtensionInitialized).to.eq(true);
    });

    it("should emit the correct ExtensionInitialized event", async () => {
      await expect(subject()).to.emit(streamingFeeSplitExtension, "ExtensionInitialized").withArgs(setToken.address, delegatedManager.address);
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
        await streamingFeeSplitExtension.connect(owner.wallet).initializeExtension(delegatedManager.address);
        await delegatedManager.connect(owner.wallet).removeExtensions([streamingFeeSplitExtension.address]);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Extension must be pending");
      });
    });

    describe("when the extension is already initialized", async () => {
      beforeEach(async () => {
        await streamingFeeSplitExtension.connect(owner.wallet).initializeExtension(delegatedManager.address);
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
      return streamingFeeSplitExtension.connect(subjectCaller.wallet).initializeModuleAndExtension(subjectDelegatedManager, feeSettings);
    }

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

    it("should initialize the StreamingFeeSplitExtension on the DelegatedManager", async () => {
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

    describe("when the sender is not the owner", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be owner");
      });
    });

    describe("when the StreamingFeeModule is not pending or initialized", async () => {
      beforeEach(async () => {
        await streamingFeeSplitExtension.connect(owner.wallet).initializeModuleAndExtension(subjectDelegatedManager, feeSettings);
        await delegatedManager.connect(owner.wallet).removeExtensions([streamingFeeSplitExtension.address]);
        await delegatedManager.connect(owner.wallet).setManager(owner.address);
        await setToken.connect(owner.wallet).removeModule(setV2Setup.streamingFeeModule.address);
        await setToken.connect(owner.wallet).setManager(delegatedManager.address);
        await delegatedManager.connect(owner.wallet).addExtensions([streamingFeeSplitExtension.address]);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("StreamingFeeModule must be pending");
      });
    });

    describe("when the StreamingFeeModule is already initialized", async () => {
      beforeEach(async () => {
        await streamingFeeSplitExtension.connect(owner.wallet).initializeModuleAndExtension(subjectDelegatedManager, feeSettings);
        await delegatedManager.connect(owner.wallet).removeExtensions([streamingFeeSplitExtension.address]);
        await delegatedManager.connect(owner.wallet).addExtensions([streamingFeeSplitExtension.address]);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("StreamingFeeModule must be pending");
      });
    });

    describe("when the extension is not pending or initialized", async () => {
      beforeEach(async () => {
        await streamingFeeSplitExtension.connect(owner.wallet).initializeExtension(delegatedManager.address);
        await delegatedManager.connect(owner.wallet).removeExtensions([streamingFeeSplitExtension.address]);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Extension must be pending");
      });
    });

    describe("when the extension is already initialized", async () => {
      beforeEach(async () => {
        await streamingFeeSplitExtension.connect(owner.wallet).initializeExtension(delegatedManager.address);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Extension must be pending");
      });
    });
  });

  describe("#updateStreamingFee", async () => {
    let mintedTokens: BigNumber;
    const timeFastForward: BigNumber = ONE_YEAR_IN_SECONDS;

    let subjectNewFee: BigNumber;

    let subjectSetToken: Address;
    let subjectCaller: Account;

    beforeEach(async () => {
      mintedTokens = ether(2);
      await setV2Setup.dai.approve(setV2Setup.issuanceModule.address, ether(3));
      await setV2Setup.issuanceModule.issue(setToken.address, mintedTokens, owner.address);

      await increaseTimeAsync(timeFastForward);

      await streamingFeeSplitExtension.connect(owner.wallet).initializeModuleAndExtension(delegatedManager.address, feeSettings);

      subjectNewFee = ether(.01);
      subjectSetToken = setToken.address;
      subjectCaller = owner;
    });

    async function subject(): Promise<ContractTransaction> {
      return await streamingFeeSplitExtension.connect(subjectCaller.wallet).updateStreamingFee(subjectSetToken, subjectNewFee);
    }

    it("should update the streaming fee on the StreamingFeeModule", async () => {
      await subject();

      const storedFeeState: StreamingFeeState = await setV2Setup.streamingFeeModule.feeStates(setToken.address);
      expect(storedFeeState.streamingFeePercentage).to.eq(subjectNewFee);
    });

    it("should send correct amount of fees to the DelegatedManager", async () => {
      const preManagerBalance = await setToken.balanceOf(delegatedManager.address);
      const feeState: any = await setV2Setup.streamingFeeModule.feeStates(setToken.address);
      const totalSupply = await setToken.totalSupply();
      const txnTimestamp = await getTransactionTimestamp(subject());

      const expectedFeeInflation = await getStreamingFee(
        setV2Setup.streamingFeeModule,
        setToken.address,
        feeState.lastStreamingFeeTimestamp,
        txnTimestamp,
        ether(.02)
      );

      const feeInflation = getStreamingFeeInflationAmount(expectedFeeInflation, totalSupply);

      const postManagerBalance = await setToken.balanceOf(delegatedManager.address);

      expect(postManagerBalance.sub(preManagerBalance)).to.eq(feeInflation);
    });

    describe("when the sender is not the owner", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be owner");
      });
    });
  });

  describe("#updateFeeRecipient", async () => {
    let subjectNewFeeRecipient: Address;
    let subjectSetToken: Address;
    let subjectCaller: Account;

    beforeEach(async () => {
      await streamingFeeSplitExtension.connect(owner.wallet).initializeModuleAndExtension(delegatedManager.address, feeSettings);

      subjectNewFeeRecipient = factory.address;
      subjectSetToken = setToken.address;
      subjectCaller = owner;
    });

    async function subject(): Promise<ContractTransaction> {
      return await streamingFeeSplitExtension.connect(subjectCaller.wallet).updateFeeRecipient(subjectSetToken, subjectNewFeeRecipient);
    }

    it("should update the fee recipient on the StreamingFeeModule", async () => {
      await subject();

      const storedFeeState: StreamingFeeState = await setV2Setup.streamingFeeModule.feeStates(setToken.address);
      expect(storedFeeState.feeRecipient).to.eq(subjectNewFeeRecipient);
    });

    describe("when the sender is not the owner", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be owner");
      });
    });
  });

  describe("#accrueFeesAndDistribute", async () => {
    let mintedTokens: BigNumber;
    const timeFastForward: BigNumber = ONE_YEAR_IN_SECONDS;
    let subjectSetToken: Address;

    beforeEach(async () => {
      await streamingFeeSplitExtension.connect(owner.wallet).initializeModuleAndExtension(delegatedManager.address, feeSettings);

      mintedTokens = ether(2);
      await setV2Setup.dai.approve(setV2Setup.issuanceModule.address, ether(3));
      await setV2Setup.issuanceModule.issue(setToken.address, mintedTokens, factory.address);

      await increaseTimeAsync(timeFastForward);

      subjectSetToken = setToken.address;
    });

    async function subject(): Promise<ContractTransaction> {
      return await streamingFeeSplitExtension.accrueFeesAndDistribute(subjectSetToken);
    }

    it("should send correct amount of fees to owner fee recipient and methodologist", async () => {
      const feeState: any = await setV2Setup.streamingFeeModule.feeStates(setToken.address);
      const totalSupply = await setToken.totalSupply();

      const txnTimestamp = await getTransactionTimestamp(subject());

      const expectedFeeInflation = await getStreamingFee(
        setV2Setup.streamingFeeModule,
        setToken.address,
        feeState.lastStreamingFeeTimestamp,
        txnTimestamp
      );

      const feeInflation = getStreamingFeeInflationAmount(expectedFeeInflation, totalSupply);

      const expectedOwnerTake = preciseMul(feeInflation, ownerFeeSplit);
      const expectedMethodologistTake = feeInflation.sub(expectedOwnerTake);

      const ownerFeeRecipientBalance = await setToken.balanceOf(ownerFeeRecipient);
      const methodologistBalance = await setToken.balanceOf(methodologist.address);

      expect(ownerFeeRecipientBalance).to.eq(expectedOwnerTake);
      expect(methodologistBalance).to.eq(expectedMethodologistTake);
    });

    it("should emit a FeesDistributed event", async () => {
      await expect(subject()).to.emit(streamingFeeSplitExtension, "FeesDistributed");
    });

    describe("when methodologist fees are 0", async () => {
      beforeEach(async () => {
        await delegatedManager.connect(owner.wallet).updateOwnerFeeSplit(ether(1));
      });

      it("should not send fees to methodologist", async () => {
        const preMethodologistBalance = await setToken.balanceOf(methodologist.address);

        await subject();

        const postMethodologistBalance = await setToken.balanceOf(methodologist.address);
        expect(postMethodologistBalance.sub(preMethodologistBalance)).to.eq(ZERO);
      });
    });

    describe("when owner fees are 0", async () => {
      beforeEach(async () => {
        await delegatedManager.connect(owner.wallet).updateOwnerFeeSplit(ZERO);
      });

      it("should not send fees to owner fee recipient", async () => {
        const preOwnerFeeRecipientBalance = await setToken.balanceOf(ownerFeeRecipient);

        await subject();

        const postOwnerFeeRecipientBalance = await setToken.balanceOf(ownerFeeRecipient);
        expect(postOwnerFeeRecipientBalance.sub(preOwnerFeeRecipientBalance)).to.eq(ZERO);
      });
    });
  });
});