import "module-alias/register";

import { BigNumber } from "ethers";
import { Address, Account } from "@utils/types";
import { ADDRESS_ZERO, ZERO } from "@utils/constants";
import { DelegatedManager, BasicIssuanceExtension } from "@utils/contracts/index";
import { SetToken, DebtIssuanceModule } from "@setprotocol/set-protocol-v2/utils/contracts";
import DeployHelper from "@utils/deploys";
import {
  addSnapshotBeforeRestoreAfterEach,
  ether,
  getAccounts,
  getWaffleExpect,
  preciseMul
} from "@utils/index";
import { SystemFixture } from "@setprotocol/set-protocol-v2/utils/fixtures";
import { getSystemFixture, getRandomAccount } from "@setprotocol/set-protocol-v2/utils/test";
import { ContractTransaction } from "ethers";

const expect = getWaffleExpect();

describe("BasicIssuanceExtension", () => {
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
      [basicIssuanceExtension.address],
      [operator.address],
      [setV2Setup.usdc.address, setV2Setup.weth.address],
      true
    );

    ownerFeeSplit = ether(0.1);
    await delegatedManager.updateOwnerFeeSplit(ownerFeeSplit);
    ownerFeeRecipient = owner.address;
    await delegatedManager.updateOwnerFeeRecipient(ownerFeeRecipient);

    await setToken.setManager(delegatedManager.address);

    maxManagerFee = ether(.1);
    managerIssueFee = ether(.02);
    managerRedeemFee = ether(.03);
    feeRecipient = delegatedManager.address;
    managerIssuanceHook = ADDRESS_ZERO;
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#constructor", async () => {
    let subjectBasicIssuanceModule: Address;

    beforeEach(async () => {
      subjectBasicIssuanceModule = debtIssuanceModule.address;
    });

    async function subject(): Promise<BasicIssuanceExtension> {
      return await deployer.globalExtensions.deployBasicIssuanceExtension(subjectBasicIssuanceModule);
    }

    it("should set the correct BasicIssuanceModule address", async () => {
      const BasicIssuanceExtension = await subject();

      const storedModule = await BasicIssuanceExtension.issuanceModule();
      expect(storedModule).to.eq(subjectBasicIssuanceModule);
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
      return basicIssuanceExtension.connect(subjectCaller.wallet).initializeExtension(subjectDelegatedManager);
    }

    it("should store the correct SetToken and DelegatedManager on the BasicIssuanceExtension", async () => {
      await subject();

      const storedDelegatedManager: Address = await basicIssuanceExtension.setManagers(setToken.address);
      expect(storedDelegatedManager).to.eq(delegatedManager.address);
    });

    it("should initialize the BasicIssuanceExtension on the DelegatedManager", async () => {
      await subject();

      const isExtensionInitialized: Boolean = await delegatedManager.isInitializedExtension(basicIssuanceExtension.address);
      expect(isExtensionInitialized).to.eq(true);
    });

    it("should emit the correct ExtensionInitialized event", async () => {
      await expect(subject()).to.emit(basicIssuanceExtension, "ExtensionInitialized").withArgs(setToken.address, delegatedManager.address);
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
        await basicIssuanceExtension.connect(owner.wallet).initializeExtension(delegatedManager.address);
        await delegatedManager.connect(owner.wallet).removeExtensions([basicIssuanceExtension.address]);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Extension must be pending");
      });
    });

    describe("when the extension is already initialized", async () => {
      beforeEach(async () => {
        await basicIssuanceExtension.connect(owner.wallet).initializeExtension(delegatedManager.address);
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
      return basicIssuanceExtension.connect(subjectCaller.wallet).initializeModuleAndExtension(
        subjectDelegatedManager,
        maxManagerFee,
        managerIssueFee,
        managerRedeemFee,
        feeRecipient,
        managerIssuanceHook
      );
    }

    it("should correctly initialize the BasicIssuanceModule on the SetToken", async () => {
      await subject();

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

    it("should initialize the BasicIssuanceExtension on the DelegatedManager", async () => {
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

    describe("when the sender is not the owner", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be owner");
      });
    });

    // describe("when the BasicIssuanceModule is not pending or initialized", async () => {
    //   beforeEach(async () => {
    //     // initialize module
    //     // remove module
    //   });

    //   it("should revert", async () => {
    //     await expect(subject()).to.be.revertedWith("BasicIssuanceModule must be pending");
    //   });
    // });

    // describe("when the BasicIssuanceModule is already initialized", async () => {
    //   beforeEach(async () => {
    //     // initialize module
    //   });

    //   it("should revert", async () => {
    //     await expect(subject()).to.be.revertedWith("BasicIssuanceModule must be pending");
    //   });
    // });

    describe("when the extension is not pending or initialized", async () => {
      beforeEach(async () => {
        await basicIssuanceExtension.connect(owner.wallet).initializeExtension(delegatedManager.address);
        await delegatedManager.connect(owner.wallet).removeExtensions([basicIssuanceExtension.address]);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Extension must be pending");
      });
    });

    describe("when the extension is already initialized", async () => {
      beforeEach(async () => {
        await basicIssuanceExtension.connect(owner.wallet).initializeExtension(delegatedManager.address);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Extension must be pending");
      });
    });
  });

  describe("#updateIssueFee", async () => {
    let subjectNewFee: BigNumber;
    let subjectSetToken: Address;
    let subjectCaller: Account;

    beforeEach(async () => {
      await basicIssuanceExtension.connect(owner.wallet).initializeModuleAndExtension(
        delegatedManager.address,
        maxManagerFee,
        managerIssueFee,
        managerRedeemFee,
        feeRecipient,
        managerIssuanceHook
      );

      subjectNewFee = ether(.03);
      subjectSetToken = setToken.address;
      subjectCaller = owner;
    });

    async function subject(): Promise<ContractTransaction> {
      return await basicIssuanceExtension.connect(subjectCaller.wallet).updateIssueFee(subjectSetToken, subjectNewFee);
    }

    it("should update the issue fee on the BasicIssuanceModule", async () => {
      await subject();

      const issueState: any = await debtIssuanceModule.issuanceSettings(setToken.address);
      expect(issueState.managerIssueFee).to.eq(subjectNewFee);
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

  describe("#updateRedeemFee", async () => {
    let subjectNewFee: BigNumber;
    let subjectSetToken: Address;
    let subjectCaller: Account;

    beforeEach(async () => {
      await basicIssuanceExtension.connect(owner.wallet).initializeModuleAndExtension(
        delegatedManager.address,
        maxManagerFee,
        managerIssueFee,
        managerRedeemFee,
        feeRecipient,
        managerIssuanceHook
      );

      subjectNewFee = ether(.02);
      subjectSetToken = setToken.address;
      subjectCaller = owner;
    });

    async function subject(): Promise<ContractTransaction> {
      return await basicIssuanceExtension.connect(subjectCaller.wallet).updateRedeemFee(subjectSetToken, subjectNewFee);
    }

    it("should update the redeem fee on the BasicIssuanceModule", async () => {
      await subject();

      const issueState: any = await debtIssuanceModule.issuanceSettings(setToken.address);
      expect(issueState.managerRedeemFee).to.eq(subjectNewFee);
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
      await basicIssuanceExtension.connect(owner.wallet).initializeModuleAndExtension(
        delegatedManager.address,
        maxManagerFee,
        managerIssueFee,
        managerRedeemFee,
        feeRecipient,
        managerIssuanceHook
      );

      subjectNewFeeRecipient = factory.address;
      subjectSetToken = setToken.address;
      subjectCaller = owner;
    });

    async function subject(): Promise<ContractTransaction> {
      return await basicIssuanceExtension.connect(subjectCaller.wallet).updateFeeRecipient(subjectSetToken, subjectNewFeeRecipient);
    }

    it("should update the fee recipient on the BasicIssuanceModule", async () => {
      await subject();

      const issueState: any = await debtIssuanceModule.issuanceSettings(setToken.address);
      expect(issueState.feeRecipient).to.eq(subjectNewFeeRecipient);
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

  describe("#distributeFees", async () => {
    let mintedTokens: BigNumber;
    let redeemedTokens: BigNumber;
    let subjectSetToken: Address;

    beforeEach(async () => {
      await basicIssuanceExtension.connect(owner.wallet).initializeModuleAndExtension(
        delegatedManager.address,
        maxManagerFee,
        managerIssueFee,
        managerRedeemFee,
        feeRecipient,
        managerIssuanceHook
      );

      mintedTokens = ether(2);
      await setV2Setup.dai.approve(debtIssuanceModule.address, ether(3));
      await debtIssuanceModule.issue(setToken.address, mintedTokens, factory.address);

      redeemedTokens = ether(1);
      await setToken.approve(debtIssuanceModule.address, ether(2));
      await debtIssuanceModule.connect(factory.wallet).redeem(setToken.address, redeemedTokens, factory.address);

      subjectSetToken = setToken.address;
    });

    async function subject(): Promise<ContractTransaction> {
      return await basicIssuanceExtension.distributeFees(subjectSetToken);
    }

    it("should send correct amount of fees to owner fee recipient and methodologist", async () => {
      subject();

      const expectedMintFees = preciseMul(mintedTokens, managerIssueFee);
      const expectedRedeemFees = preciseMul(redeemedTokens, managerRedeemFee);
      const expectedMintRedeemFees = expectedMintFees.add(expectedRedeemFees);

      const expectedOwnerTake = preciseMul(expectedMintRedeemFees, ownerFeeSplit);
      const expectedMethodologistTake = expectedMintRedeemFees.sub(expectedOwnerTake);

      const ownerFeeRecipientBalance = await setToken.balanceOf(ownerFeeRecipient);
      const methodologistBalance = await setToken.balanceOf(methodologist.address);

      expect(ownerFeeRecipientBalance).to.eq(expectedOwnerTake);
      expect(methodologistBalance).to.eq(expectedMethodologistTake);
    });

    it("should emit a FeesDistributed event", async () => {
      await expect(subject()).to.emit(basicIssuanceExtension, "FeesDistributed");
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