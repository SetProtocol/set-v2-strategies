import "module-alias/register";

import { Address, Account, Bytes } from "@utils/types";
import { ADDRESS_ZERO, EXTENSION_STATE, ZERO } from "@utils/constants";
import { DelegatedManager, BaseGlobalExtensionMock } from "@utils/contracts/index";
import { SetToken } from "@setprotocol/set-protocol-v2/utils/contracts";
import DeployHelper from "@utils/deploys";
import {
  addSnapshotBeforeRestoreAfterEach,
  ether,
  getAccounts,
  getWaffleExpect,
  getRandomAddress
} from "@utils/index";
import { SystemFixture } from "@setprotocol/set-protocol-v2/utils/fixtures";
import { getSystemFixture, getRandomAccount } from "@setprotocol/set-protocol-v2/utils/test";

const expect = getWaffleExpect();

describe.only("DelegatedManager", () => {
  let owner: Account;
  let methodologist: Account;
  let otherAccount: Account;
  let factory: Account;
  let operatorOne: Account;
  let operatorTwo: Account;
  let fakeExtension: Account;
  let newManager: Account;

  let setV2Setup: SystemFixture;

  let deployer: DeployHelper;
  let setToken: SetToken;

  let delegatedManager: DelegatedManager;
  let baseExtension: BaseGlobalExtensionMock;

  before(async () => {
    [
      owner,
      otherAccount,
      methodologist,
      factory,
      operatorOne,
      operatorTwo,
      fakeExtension,
      newManager
    ] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);

    setV2Setup = getSystemFixture(owner.address);
    await setV2Setup.initialize();

    setToken = await setV2Setup.createSetToken(
      [setV2Setup.dai.address],
      [ether(1)],
      [setV2Setup.issuanceModule.address, setV2Setup.streamingFeeModule.address]
    );

    // Initialize modules
    await setV2Setup.issuanceModule.initialize(setToken.address, ADDRESS_ZERO);
    const feeRecipient = owner.address;
    const maxStreamingFeePercentage = ether(.1);
    const streamingFeePercentage = ether(.02);
    const streamingFeeSettings = {
      feeRecipient,
      maxStreamingFeePercentage,
      streamingFeePercentage,
      lastStreamingFeeTimestamp: ZERO,
    };
    await setV2Setup.streamingFeeModule.initialize(setToken.address, streamingFeeSettings);

    baseExtension = await deployer.mocks.deployBaseGlobalExtensionMock();

    // Deploy DelegatedManager
    delegatedManager = await deployer.manager.deployDelegatedManager(
      setToken.address,
      factory.address,
      methodologist.address,
      [baseExtension.address],
      [operatorOne.address, operatorTwo.address],
      [setV2Setup.usdc.address, setV2Setup.weth.address]
    );

    // Transfer ownership to DelegatedManager
    await setToken.setManager(delegatedManager.address);
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#constructor", async () => {
    let subjectSetToken: Address;
    let subjectFactory: Address;
    let subjectMethodologist: Address;
    let subjectExtensions: Address[];
    let subjectOperators: Address[];
    let subjectAllowedAssets: Address[];

    beforeEach(async () => {
      subjectSetToken = setToken.address;
      subjectFactory = factory.address;
      subjectMethodologist = methodologist.address;
      subjectExtensions = [baseExtension.address];
      subjectOperators = [operatorOne.address, operatorTwo.address];
      subjectAllowedAssets = [setV2Setup.usdc.address, setV2Setup.weth.address];
    });

    async function subject(): Promise<DelegatedManager> {
      return await deployer.manager.deployDelegatedManager(
        subjectSetToken,
        subjectFactory,
        subjectMethodologist,
        subjectExtensions,
        subjectOperators,
        subjectAllowedAssets
      );
    }

    it("should set the correct SetToken address", async () => {
      const delegatedManager = await subject();

      const actualToken = await delegatedManager.setToken();
      expect (actualToken).to.eq(subjectSetToken);
    });

    it("should set the correct factory address", async () => {
      const delegatedManager = await subject();

      const actualFactory = await delegatedManager.factory();
      expect (actualFactory).to.eq(subjectFactory);
    });

    it("should set the correct Methodologist address", async () => {
      const delegatedManager = await subject();

      const actualMethodologist = await delegatedManager.methodologist();
      expect (actualMethodologist).to.eq(subjectMethodologist);
    });

    it("should set Extension to pending and NOT add to array", async () => {
      const delegatedManager = await subject();

      const actualExtensionArray = await delegatedManager.getExtensions();
      const isApprovedExtension = await delegatedManager.extensionAllowlist(subjectExtensions[0]);

      expect(actualExtensionArray).to.be.empty;
      expect(isApprovedExtension).to.eq(EXTENSION_STATE["PENDING"]);
    });

    it("should set the correct Operators approvals and arrays", async () => {
      const delegatedManager = await subject();

      const actualOperatorsArray = await delegatedManager.getOperators();
      const isApprovedOperatorOne = await delegatedManager.operatorAllowlist(operatorOne.address);
      const isApprovedOperatorTwo = await delegatedManager.operatorAllowlist(operatorTwo.address);

      expect(JSON.stringify(actualOperatorsArray)).to.eq(JSON.stringify(subjectOperators));
      expect(isApprovedOperatorOne).to.be.true;
      expect(isApprovedOperatorTwo).to.be.true;
    });

    it("should set the correct Allowed assets approvals and arrays", async () => {
      const delegatedManager = await subject();

      const actualAssetsArray = await delegatedManager.getAllowedAssets();
      const isApprovedUSDC = await delegatedManager.assetAllowlist(setV2Setup.usdc.address);
      const isApprovedWETH = await delegatedManager.assetAllowlist(setV2Setup.weth.address);

      expect(JSON.stringify(actualAssetsArray)).to.eq(JSON.stringify(subjectAllowedAssets));
      expect(isApprovedUSDC).to.be.true;
      expect(isApprovedWETH).to.be.true;
    });
  });

  describe("#initializeExtension", async () => {
    let subjectCaller: Account;

    beforeEach(async () => {
      await delegatedManager.addExtensions([otherAccount.address]);

      subjectCaller = otherAccount;
    });

    async function subject(): Promise<any> {
      return delegatedManager.connect(subjectCaller.wallet).initializeExtension();
    }

    it("should mark the module as initialized", async () => {
      await subject();

      const isInitializedExternsion = await delegatedManager.extensionAllowlist(otherAccount.address);
      expect(isInitializedExternsion).to.eq(EXTENSION_STATE["INITIALIZED"]);
    });

    describe("when the caller is not a pending extension", async () => {
      beforeEach(async () => {
        subjectCaller = fakeExtension;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Extension must be pending");
      });
    });
  });

  describe("#interactManager", async () => {
    let subjectModule: Address;
    let subjectCallData: Bytes;
    let subjectCaller: Account;

    beforeEach(async () => {
      await delegatedManager.addExtensions([otherAccount.address]);
      await delegatedManager.connect(otherAccount.wallet).initializeExtension();

      subjectModule = setV2Setup.streamingFeeModule.address;

      // Invoke update fee recipient
      subjectCallData = setV2Setup.streamingFeeModule.interface.encodeFunctionData("updateFeeRecipient", [
        setToken.address,
        otherAccount.address,
      ]);

      subjectCaller = otherAccount;
    });

    async function subject(): Promise<any> {
      return delegatedManager.connect(subjectCaller.wallet).interactManager(
        subjectModule,
        subjectCallData
      );
    }

    it("should call updateFeeRecipient on the streaming fee module from the SetToken", async () => {
      await subject();
      const feeStates = await setV2Setup.streamingFeeModule.feeStates(setToken.address);
      expect(feeStates.feeRecipient).to.eq(otherAccount.address);
    });

    describe("when the caller is not an initialized extension", async () => {
      beforeEach(async () => {
        subjectCaller = fakeExtension;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be initialized extension");
      });
    });
  });

  describe("#addExtensions", async () => {
    let subjectExtensions: Address[];
    let subjectCaller: Account;

    beforeEach(async () => {
      subjectExtensions = [otherAccount.address, fakeExtension.address];
      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      return delegatedManager.connect(subjectCaller.wallet).addExtensions(subjectExtensions);
    }

    it("should NOT add the extensions address", async () => {
      const preExtensions = await delegatedManager.getExtensions();

      await subject();

      const postExtensions = await delegatedManager.getExtensions();

      expect(JSON.stringify(preExtensions)).to.eq(JSON.stringify(postExtensions));
    });

    it("should set the extension mapping", async () => {
      await subject();
      const isExtensionOne = await delegatedManager.extensionAllowlist(otherAccount.address);
      const isExtensionTwo = await delegatedManager.extensionAllowlist(fakeExtension.address);

      expect(isExtensionOne).to.eq(EXTENSION_STATE["PENDING"]);
      expect(isExtensionTwo).to.eq(EXTENSION_STATE["PENDING"]);
    });

    it("should emit the correct ExtensionAdded event for the first address", async () => {
      await expect(subject()).to.emit(delegatedManager, "ExtensionAdded").withArgs(otherAccount.address);
    });

    it("should emit the correct ExtensionAdded event for the second address", async () => {
      await expect(subject()).to.emit(delegatedManager, "ExtensionAdded").withArgs(fakeExtension.address);
    });

    describe("when the extension already exists", async () => {
      beforeEach(async () => {
        subjectExtensions = [baseExtension.address];
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Extension already exists");
      });
    });

    describe("when the caller is not the owner", async () => {
      beforeEach(async () => {
        subjectCaller = methodologist;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Ownable: caller is not the owner");
      });
    });
  });

  describe("#removeExtensions", async () => {
    let subjectExtensions: Address[];
    let subjectCaller: Account;

    beforeEach(async () => {
      await baseExtension.connect(owner.wallet).initializeExtension(
        setToken.address,
        delegatedManager.address
      );

      subjectExtensions = [baseExtension.address];
      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      return delegatedManager.connect(subjectCaller.wallet).removeExtensions(subjectExtensions);
    }

    it("should remove the extension address", async () => {
      await subject();
      const extensions = await delegatedManager.getExtensions();

      expect(extensions.length).to.eq(0);
    });

    it("should set the extension mapping", async () => {
      const preIsExtensionOne = await delegatedManager.extensionAllowlist(baseExtension.address);

      expect(preIsExtensionOne).to.eq(EXTENSION_STATE["INITIALIZED"]);

      await subject();

      const postIsExtensionOne = await delegatedManager.extensionAllowlist(baseExtension.address);

      expect(postIsExtensionOne).to.eq(EXTENSION_STATE["NONE"]);
    });

    it("should emit the correct ExtensionRemoved event for the first address", async () => {
      await expect(subject()).to.emit(delegatedManager, "ExtensionRemoved").withArgs(baseExtension.address);
    });

    describe("when the extension does not exist", async () => {
      beforeEach(async () => {
        subjectExtensions = [await getRandomAddress()];
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Extension not initialized");
      });
    });

    describe("when the caller is not the owner", async () => {
      beforeEach(async () => {
        subjectCaller = methodologist;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Ownable: caller is not the owner");
      });
    });
  });

  describe("#addOperators", async () => {
    let subjectOperators: Address[];
    let subjectCaller: Account;

    beforeEach(async () => {
      subjectOperators = [otherAccount.address];
      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      return delegatedManager.connect(subjectCaller.wallet).addOperators(subjectOperators);
    }

    it("should add the operator address", async () => {
      await subject();
      const operators = await delegatedManager.getOperators();

      expect(operators[2]).to.eq(otherAccount.address);
    });

    it("should set the operator mapping", async () => {
      await subject();
      const isOperatorOne = await delegatedManager.operatorAllowlist(otherAccount.address);

      expect(isOperatorOne).to.be.true;
    });

    it("should emit the correct OperatorAdded event", async () => {
      await expect(subject()).to.emit(delegatedManager, "OperatorAdded").withArgs(otherAccount.address);
    });

    describe("when the operator already exists", async () => {
      beforeEach(async () => {
        subjectOperators = [operatorOne.address];
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Operator already added");
      });
    });

    describe("when the caller is not the owner", async () => {
      beforeEach(async () => {
        subjectCaller = methodologist;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Ownable: caller is not the owner");
      });
    });
  });

  describe("#removeOperators", async () => {
    let subjectOperators: Address[];
    let subjectCaller: Account;

    beforeEach(async () => {
      subjectOperators = [operatorOne.address, operatorTwo.address];
      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      return delegatedManager.connect(subjectCaller.wallet).removeOperators(subjectOperators);
    }

    it("should remove the operator addresses", async () => {
      await subject();
      const operators = await delegatedManager.getOperators();

      expect(operators).to.be.empty;
    });

    it("should set the operator mapping", async () => {
      await subject();
      const isOperatorOne = await delegatedManager.operatorAllowlist(operatorOne.address);
      const isOperatorTwo = await delegatedManager.operatorAllowlist(operatorTwo.address);

      expect(isOperatorOne).to.be.false;
      expect(isOperatorTwo).to.be.false;
    });

    it("should emit the correct OperatorRemoved event for the first address", async () => {
      await expect(subject()).to.emit(delegatedManager, "OperatorRemoved").withArgs(operatorOne.address);
    });

    it("should emit the correct OperatorRemoved event for the second address", async () => {
      await expect(subject()).to.emit(delegatedManager, "OperatorRemoved").withArgs(operatorTwo.address);
    });

    describe("when the operator hasn't been added", async () => {
      beforeEach(async () => {
        subjectOperators = [otherAccount.address];
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Operator not already added");
      });
    });

    describe("when the caller is not the owner", async () => {
      beforeEach(async () => {
        subjectCaller = methodologist;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Ownable: caller is not the owner");
      });
    });
  });

  describe("#addAllowedAssets", async () => {
    let subjectAssets: Address[];
    let subjectCaller: Account;

    beforeEach(async () => {
      subjectAssets = [setV2Setup.wbtc.address];
      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      return delegatedManager.connect(subjectCaller.wallet).addAllowedAssets(subjectAssets);
    }

    it("should add the asset address", async () => {
      await subject();
      const assets = await delegatedManager.getAllowedAssets();

      expect(assets[2]).to.eq(setV2Setup.wbtc.address);
    });

    it("should set the allowed asset mapping", async () => {
      await subject();

      const isApprovedWBTC = await delegatedManager.assetAllowlist(setV2Setup.wbtc.address);

      expect(isApprovedWBTC).to.be.true;
    });

    it("should emit the correct AllowedAssetAdded event", async () => {
      await expect(subject()).to.emit(delegatedManager, "AllowedAssetAdded").withArgs(setV2Setup.wbtc.address);
    });

    describe("when the asset already exists", async () => {
      beforeEach(async () => {
        subjectAssets = [setV2Setup.weth.address];
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Asset already added");
      });
    });

    describe("when the caller is not the owner", async () => {
      beforeEach(async () => {
        subjectCaller = methodologist;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Ownable: caller is not the owner");
      });
    });
  });

  describe("#removeAllowedAssets", async () => {
    let subjectAssets: Address[];
    let subjectCaller: Account;

    beforeEach(async () => {
      subjectAssets = [setV2Setup.weth.address, setV2Setup.usdc.address];
      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      return delegatedManager.connect(subjectCaller.wallet).removeAllowedAssets(subjectAssets);
    }

    it("should remove the asset addresses", async () => {
      await subject();
      const assets = await delegatedManager.getAllowedAssets();

      expect(assets).to.be.empty;
    });

    it("should set the asset mapping", async () => {
      await subject();
      const isApprovedWETH = await delegatedManager.assetAllowlist(setV2Setup.weth.address);
      const isApprovedUSDC = await delegatedManager.assetAllowlist(setV2Setup.usdc.address);

      expect(isApprovedWETH).to.be.false;
      expect(isApprovedUSDC).to.be.false;
    });

    it("should emit the correct AllowedAssetRemoved event for the first address", async () => {
      await expect(subject()).to.emit(delegatedManager, "AllowedAssetRemoved").withArgs(setV2Setup.weth.address);
    });

    it("should emit the correct AllowedAssetRemoved event for the second address", async () => {
      await expect(subject()).to.emit(delegatedManager, "AllowedAssetRemoved").withArgs(setV2Setup.usdc.address);
    });

    describe("when the asset hasn't been added", async () => {
      beforeEach(async () => {
        subjectAssets = [otherAccount.address];
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Asset not already added");
      });
    });

    describe("when the caller is not the owner", async () => {
      beforeEach(async () => {
        subjectCaller = methodologist;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Ownable: caller is not the owner");
      });
    });
  });

  describe("#setMethodologist", async () => {
    let subjectNewMethodologist: Address;
    let subjectCaller: Account;

    beforeEach(async () => {
      subjectNewMethodologist = await getRandomAddress();
      subjectCaller = methodologist;
    });

    async function subject(): Promise<any> {
      return delegatedManager.connect(subjectCaller.wallet).setMethodologist(subjectNewMethodologist);
    }

    it("should set the new methodologist", async () => {
      await subject();
      const actualIndexModule = await delegatedManager.methodologist();
      expect(actualIndexModule).to.eq(subjectNewMethodologist);
    });

    it("should emit the correct MethodologistChanged event", async () => {
      await expect(subject()).to.emit(delegatedManager, "MethodologistChanged").withArgs(methodologist.address, subjectNewMethodologist);
    });

    describe("when the caller is not the methodologist", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be methodologist");
      });
    });
  });

  describe("#addModule", async () => {
    let subjectModule: Address;
    let subjectCaller: Account;

    beforeEach(async () => {
      await setV2Setup.controller.addModule(otherAccount.address);

      subjectModule = otherAccount.address;
      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      return delegatedManager.connect(subjectCaller.wallet).addModule(subjectModule);
    }

    it("should add the module to the SetToken", async () => {
      await subject();
      const isModule = await setToken.isPendingModule(subjectModule);
      expect(isModule).to.eq(true);
    });

    describe("when the caller is not the operator", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Ownable: caller is not the owner");
      });
    });
  });

  describe("#removeModule", async () => {
    let subjectModule: Address;
    let subjectCaller: Account;

    beforeEach(async () => {
      subjectModule = setV2Setup.streamingFeeModule.address;
      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      return delegatedManager.connect(subjectCaller.wallet).removeModule(subjectModule);
    }

    it("should remove the module from the SetToken", async () => {
      await subject();
      const isModule = await setToken.isInitializedModule(subjectModule);
      expect(isModule).to.eq(false);
    });

    describe("when the caller is not the operator", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Ownable: caller is not the owner");
      });
    });
  });

  describe("#setManager", async () => {
    let subjectNewManager: Address;
    let subjectCaller: Account;

    beforeEach(async () => {
      subjectNewManager = newManager.address;
      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      return delegatedManager.connect(subjectCaller.wallet).setManager(subjectNewManager);
    }

    it("should change the manager address", async () => {
      await subject();
      const manager = await setToken.manager();

      expect(manager).to.eq(newManager.address);
    });

    describe("when passed manager is the zero address", async () => {
      beforeEach(async () => {
        subjectNewManager = ADDRESS_ZERO;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Zero address not valid");
      });
    });

    describe("when the caller is not the operator", async () => {
      beforeEach(async () => {
        subjectCaller = methodologist;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Ownable: caller is not the owner");
      });
    });
  });
});