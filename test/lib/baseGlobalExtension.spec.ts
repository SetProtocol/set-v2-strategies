import "module-alias/register";

import { Account, Address, Bytes } from "@utils/types";
import { ZERO, ADDRESS_ZERO } from "@utils/constants";
import { BaseGlobalExtensionMock, DelegatedManager } from "@utils/contracts/index";

import DeployHelper from "@utils/deploys";

import {
  addSnapshotBeforeRestoreAfterEach,
  getAccounts,
  getWaffleExpect,
  ether,
} from "@utils/index";

import {
  SetToken
} from "@setprotocol/set-protocol-v2/utils/contracts";

import { getSystemFixture } from "@setprotocol/set-protocol-v2/utils/test";

import {
  SystemFixture
} from "@setprotocol/set-protocol-v2/utils/fixtures";

import { ContractTransaction } from "ethers";

const expect = getWaffleExpect();

describe("BaseGlobalExtension", () => {
  let owner: Account;
  let methodologist: Account;
  let otherAccount: Account;
  let factory: Account;
  let operator: Account;

  let deployer: DeployHelper;
  let setToken: SetToken;
  let setV2Setup: SystemFixture;

  let delegatedManager: DelegatedManager;
  let baseExtensionMock: BaseGlobalExtensionMock;

  before(async () => {
    [
      owner,
      methodologist,
      otherAccount,
      factory,
      operator,
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

    baseExtensionMock = await deployer.mocks.deployBaseGlobalExtensionMock();

    // Deploy DelegatedManager
    delegatedManager = await deployer.manager.deployDelegatedManager(
      setToken.address,
      factory.address,
      methodologist.address,
      [baseExtensionMock.address],
      [operator.address],
      [setV2Setup.usdc.address, setV2Setup.weth.address],
      true
    );

    // Transfer ownership to DelegatedManager
    await setToken.setManager(delegatedManager.address);

    await baseExtensionMock.initializeExtension(setToken.address, delegatedManager.address);
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#testOnlyOperator", async () => {
    let subjectSetToken: Address;
    let subjectCaller: Account;

    beforeEach(async () => {
      subjectSetToken = setToken.address;
      subjectCaller = operator;
    });

    async function subject(): Promise<ContractTransaction> {
      return baseExtensionMock.connect(subjectCaller.wallet).testOnlyOperator(subjectSetToken);
    }

    it("should succeed without revert", async () => {
      await subject();
    });

    describe("when the sender is not operator", async () => {
      beforeEach(async () => {
        subjectCaller = owner;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be approved operator");
      });
    });
  });

  describe("#testOnlyMethodologist", async () => {
    let subjectSetToken: Address;
    let subjectCaller: Account;

    beforeEach(async () => {
      subjectSetToken = setToken.address;
      subjectCaller = methodologist;
    });

    async function subject(): Promise<ContractTransaction> {
      return baseExtensionMock.connect(subjectCaller.wallet).testOnlyMethodologist(subjectSetToken);
    }

    it("should succeed without revert", async () => {
      await subject();
    });

    describe("when the sender is not methodologist", async () => {
      beforeEach(async () => {
        subjectCaller = owner;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be methodologist");
      });
    });
  });

  describe("#testOnlyOwner", async () => {
    let subjectSetToken: Address;
    let subjectCaller: Account;

    beforeEach(async () => {
      subjectSetToken = setToken.address;
      subjectCaller = owner;
    });

    async function subject(): Promise<ContractTransaction> {
      return baseExtensionMock.connect(subjectCaller.wallet).testOnlyOwner(subjectSetToken);
    }

    it("should succeed without revert", async () => {
      await subject();
    });

    describe("when the sender is not the owner", async () => {
      beforeEach(async () => {
        subjectCaller = operator;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be owner");
      });
    });
  });

  describe("#testOnlyManager", async () => {
    let subjectRemoveExtensions: Address[];
    let subjectCaller: Account;

    beforeEach(async () => {
      // Easiest way to test onlyManager is by calling removeExtensions on manager since that's the only
      // fxn that calls back into extension
      subjectRemoveExtensions = [baseExtensionMock.address];
      subjectCaller = owner;
    });

    async function subject(): Promise<ContractTransaction> {
      return delegatedManager.connect(subjectCaller.wallet).removeExtensions(subjectRemoveExtensions);
    }

    it("should succeed without revert", async () => {
      await subject();
    });

    describe("when the sender is not the manager", async () => {
      let subjectSetToken: Address;

      beforeEach(async () => {
        subjectSetToken = setToken.address;
        subjectCaller = owner;
      });

      async function subject(): Promise<ContractTransaction> {
        return baseExtensionMock.connect(subjectCaller.wallet).testOnlyManager(subjectSetToken);
      }

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be manager");
      });
    });
  });

  describe("#testOnlyAllowedAsset", async () => {
    let subjectSetToken: Address;
    let subjectAsset: Address;
    let subjectCaller: Account;

    beforeEach(async () => {
      subjectSetToken = setToken.address;
      subjectAsset = setV2Setup.usdc.address;
      subjectCaller = owner;
    });

    async function subject(): Promise<ContractTransaction> {
      return baseExtensionMock.connect(subjectCaller.wallet).testOnlyAllowedAsset(subjectSetToken, subjectAsset);
    }

    it("should succeed without revert", async () => {
      await subject();
    });

    describe("when the asset is not an approved asset", async () => {
      beforeEach(async () => {
        subjectAsset = setV2Setup.wbtc.address
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be allowed asset");
      });
    });
  });

  describe("#testInvokeManager", async () => {
    let subjectSetToken: Address;
    let subjectModule: Address;
    let subjectCallData: Bytes;
    let subjectCaller: Account;

    beforeEach(async () => {
      subjectSetToken = setToken.address;
      subjectModule = setV2Setup.streamingFeeModule.address;
      subjectCallData = setV2Setup.streamingFeeModule.interface.encodeFunctionData("updateFeeRecipient", [
        setToken.address,
        otherAccount.address,
      ]);
      subjectCaller = owner;
    });

    async function subject(): Promise<ContractTransaction> {
      return baseExtensionMock.connect(subjectCaller.wallet).testInvokeManager(subjectSetToken, subjectModule, subjectCallData);
    }

    it("should call updateFeeRecipient on the streaming fee module from the SetToken", async () => {
      await subject();
      const feeStates = await setV2Setup.streamingFeeModule.feeStates(setToken.address);
      expect(feeStates.feeRecipient).to.eq(otherAccount.address);
    });
  });
});