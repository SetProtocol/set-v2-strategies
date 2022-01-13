import "module-alias/register";

import { BigNumber } from "ethers";
import { Account, Address, Bytes } from "@utils/types";
import { ZERO, ADDRESS_ZERO } from "@utils/constants";
import { BaseExtensionMock, BaseManager } from "@utils/contracts/index";

import DeployHelper from "@utils/deploys";

import {
  addSnapshotBeforeRestoreAfterEach,
  getAccounts,
  getWaffleExpect,
  getRandomAccount,
  ether,
} from "@utils/index";

import {
  ContractCallerMock,
  SetToken
} from "@setprotocol/set-protocol-v2/utils/contracts";

import { getSystemFixture } from "@setprotocol/set-protocol-v2/utils/test";

import {
  SystemFixture
} from "@setprotocol/set-protocol-v2/utils/fixtures";

import { ContractTransaction } from "ethers";

const expect = getWaffleExpect();

describe("BaseExtension", () => {
  let owner: Account;
  let methodologist: Account;
  let otherAccount: Account;
  let deployer: DeployHelper;
  let setToken: SetToken;
  let systemSetup: SystemFixture;

  let baseManager: BaseManager;
  let baseExtensionMock: BaseExtensionMock;

  before(async () => {
    [
      owner,
      methodologist,
      otherAccount,
    ] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);

    systemSetup = getSystemFixture(owner.address);
    await systemSetup.initialize();

    setToken = await systemSetup.createSetToken(
      [systemSetup.dai.address],
      [ether(1)],
      [systemSetup.issuanceModule.address, systemSetup.streamingFeeModule.address]
    );

    // Initialize modules
    await systemSetup.issuanceModule.initialize(setToken.address, ADDRESS_ZERO);
    const feeRecipient = owner.address;
    const maxStreamingFeePercentage = ether(.1);
    const streamingFeePercentage = ether(.02);
    const streamingFeeSettings = {
      feeRecipient,
      maxStreamingFeePercentage,
      streamingFeePercentage,
      lastStreamingFeeTimestamp: ZERO,
    };
    await systemSetup.streamingFeeModule.initialize(setToken.address, streamingFeeSettings);

    // Deploy BaseManager
    baseManager = await deployer.manager.deployBaseManager(
      setToken.address,
      owner.address,
      methodologist.address
    );

    baseExtensionMock = await deployer.mocks.deployBaseExtensionMock(baseManager.address);

    // Transfer ownership to BaseManager
    await setToken.setManager(baseManager.address);
    await baseManager.addExtension(baseExtensionMock.address);

    await baseExtensionMock.updateCallerStatus([owner.address], [true]);
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#testOnlyOperator", async () => {
    let subjectCaller: Account;

    beforeEach(async () => {
      subjectCaller = owner;
    });

    async function subject(): Promise<ContractTransaction> {
      return baseExtensionMock.connect(subjectCaller.wallet).testOnlyOperator();
    }

    it("should succeed without revert", async () => {
      await subject();
    });

    describe("when the sender is not operator", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be operator");
      });
    });
  });

  describe("#testOnlyMethodologist", async () => {
    let subjectCaller: Account;

    beforeEach(async () => {
      subjectCaller = methodologist;
    });

    async function subject(): Promise<ContractTransaction> {
      return baseExtensionMock.connect(subjectCaller.wallet).testOnlyMethodologist();
    }

    it("should succeed without revert", async () => {
      await subject();
    });

    describe("when the sender is not methodologist", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be methodologist");
      });
    });
  });

  describe("#testOnlyEOA", async () => {
    let subjectCaller: Account;

    beforeEach(async () => {
      subjectCaller = methodologist;
    });

    async function subject(): Promise<ContractTransaction> {
      return baseExtensionMock.connect(subjectCaller.wallet).testOnlyEOA();
    }

    it("should succeed without revert", async () => {
      await subject();
    });

    describe("when the sender is not EOA", async () => {
      let subjectTarget: Address;
      let subjectCallData: string;
      let subjectValue: BigNumber;

      let contractCaller: ContractCallerMock;

      beforeEach(async () => {
        contractCaller = await deployer.setDeployer.mocks.deployContractCallerMock();

        subjectTarget = baseExtensionMock.address;
        subjectCallData = baseExtensionMock.interface.encodeFunctionData("testOnlyEOA");
        subjectValue = ZERO;
      });

      async function subjectContractCaller(): Promise<any> {
        return await contractCaller.invoke(
          subjectTarget,
          subjectValue,
          subjectCallData
        );
      }

      it("the trade reverts", async () => {
        await expect(subjectContractCaller()).to.be.revertedWith("Caller must be EOA Address");
      });
    });
  });

  describe("#testOnlyAllowedCaller", async () => {
    let subjectCaller: Account;

    beforeEach(async () => {
      subjectCaller = owner;
    });

    async function subject(): Promise<ContractTransaction> {
      return baseExtensionMock.connect(subjectCaller.wallet).testOnlyAllowedCaller(subjectCaller.address);
    }

    it("should succeed without revert", async () => {
      await subject();
    });

    describe("when the caller is not on allowlist", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Address not permitted to call");
      });

      describe("when anyoneCallable is flipped to true", async () => {
        beforeEach(async () => {
          await baseExtensionMock.updateAnyoneCallable(true);
        });

        it("should succeed without revert", async () => {
          await subject();
        });
      });
    });
  });

  describe("#testInvokeManager", async () => {
    let subjectModule: Address;
    let subjectCallData: Bytes;
    let subjectCaller: Account;

    beforeEach(async () => {
      subjectModule = systemSetup.streamingFeeModule.address;
      subjectCallData = systemSetup.streamingFeeModule.interface.encodeFunctionData("updateFeeRecipient", [
        setToken.address,
        otherAccount.address,
      ]);
      subjectCaller = owner;
    });

    async function subject(): Promise<ContractTransaction> {
      return baseExtensionMock.connect(subjectCaller.wallet).testInvokeManager(subjectModule, subjectCallData);
    }

    it("should call updateFeeRecipient on the streaming fee module from the SetToken", async () => {
      await subject();
      const feeStates = await systemSetup.streamingFeeModule.feeStates(setToken.address);
      expect(feeStates.feeRecipient).to.eq(otherAccount.address);
    });
  });

  describe("#testInvokeManagerTransfer", async () => {
    let subjectToken: Address;
    let subjectDestination: Address;
    let subjectAmount: BigNumber;

    beforeEach(async () => {
      subjectToken = systemSetup.weth.address;
      subjectDestination = otherAccount.address;
      subjectAmount = ether(1);

      await systemSetup.weth.transfer(baseManager.address, subjectAmount);
    });

    async function subject(): Promise<ContractTransaction> {
      return baseExtensionMock.testInvokeManagerTransfer(
        subjectToken,
        subjectDestination,
        subjectAmount
      );
    }

    it("should send the given amount from the manager to the address", async () => {
      const preManagerAmount = await systemSetup.weth.balanceOf(baseManager.address);
      const preDestinationAmount = await systemSetup.weth.balanceOf(subjectDestination);

      await subject();

      const postManagerAmount = await systemSetup.weth.balanceOf(baseManager.address);
      const postDestinationAmount = await systemSetup.weth.balanceOf(subjectDestination);

      expect(preManagerAmount.sub(postManagerAmount)).to.eq(subjectAmount);
      expect(postDestinationAmount.sub(preDestinationAmount)).to.eq(subjectAmount);
    });
  });

  describe("#updateCallerStatus", async () => {
    let subjectFunctionCallers: Address[];
    let subjectStatuses: boolean[];
    let subjectCaller: Account;

    beforeEach(async () => {
      subjectFunctionCallers = [otherAccount.address];
      subjectStatuses = [true];
      subjectCaller = owner;
    });

    async function subject(): Promise<ContractTransaction> {
      return baseExtensionMock.connect(subjectCaller.wallet).updateCallerStatus(subjectFunctionCallers, subjectStatuses);
    }

    it("should update the callAllowList", async () => {
      await subject();
      const callerStatus = await baseExtensionMock.callAllowList(subjectFunctionCallers[0]);
      expect(callerStatus).to.be.true;
    });

    it("should emit CallerStatusUpdated event", async () => {
      await expect(subject()).to.emit(baseExtensionMock, "CallerStatusUpdated").withArgs(
        subjectFunctionCallers[0],
        subjectStatuses[0]
      );
    });

    describe("when the sender is not operator", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be operator");
      });
    });
  });

  describe("#updateAnyoneCallable", async () => {
    let subjectStatus: boolean;
    let subjectCaller: Account;

    beforeEach(async () => {
      subjectStatus = true;
      subjectCaller = owner;
    });

    async function subject(): Promise<ContractTransaction> {
      return baseExtensionMock.connect(subjectCaller.wallet).updateAnyoneCallable(subjectStatus);
    }

    it("should update the anyoneCallable boolean", async () => {
      await subject();
      const callerStatus = await baseExtensionMock.anyoneCallable();
      expect(callerStatus).to.be.true;
    });

    it("should emit AnyoneCallableUpdated event", async () => {
      await expect(subject()).to.emit(baseExtensionMock, "AnyoneCallableUpdated").withArgs(
        subjectStatus
      );
    });

    describe("when the sender is not operator", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be operator");
      });
    });
  });
});