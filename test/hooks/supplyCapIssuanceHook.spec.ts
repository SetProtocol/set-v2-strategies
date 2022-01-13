import "module-alias/register";

import { Address, Account } from "@utils/types";
import { SupplyCapIssuanceHook } from "@utils/contracts/index";
import { SetToken, DebtIssuanceModule } from "@setprotocol/set-protocol-v2/utils/contracts";
import DeployHelper from "@utils/deploys";
import {
  addSnapshotBeforeRestoreAfterEach,
  ether,
  getAccounts,
  getWaffleExpect,
  getRandomAccount,
} from "@utils/index";
import { SystemFixture } from "@setprotocol/set-protocol-v2/utils/fixtures";
import { getSystemFixture } from "@setprotocol/set-protocol-v2/utils/test";
import { BigNumber, ContractTransaction } from "ethers";

const expect = getWaffleExpect();

describe("SupplyCapIssuanceHook", () => {
  let owner: Account;
  let hookOwner: Account;
  let setV2Setup: SystemFixture;

  let deployer: DeployHelper;
  let setToken: SetToken;

  let issuanceHook: SupplyCapIssuanceHook;
  let debtIssuanceModule: DebtIssuanceModule;

  before(async () => {
    [
      owner,
      hookOwner,
    ] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);

    setV2Setup = getSystemFixture(owner.address);
    await setV2Setup.initialize();

    debtIssuanceModule = await deployer.setV2.deployDebtIssuanceModule(setV2Setup.controller.address);
    await setV2Setup.controller.addModule(debtIssuanceModule.address);

    setToken = await setV2Setup.createSetToken(
      [setV2Setup.dai.address],
      [ether(1)],
      [debtIssuanceModule.address]
    );
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#constructor", async () => {
    let subjectOwner: Address;
    let subjectSupplyCap: BigNumber;

    beforeEach(async () => {
      subjectOwner = hookOwner.address;
      subjectSupplyCap = ether(10);
    });

    async function subject(): Promise<SupplyCapIssuanceHook> {
      return await deployer.hooks.deploySupplyCapIssuanceHook(subjectOwner, subjectSupplyCap);
    }

    it("should set the correct SetToken address", async () => {
      const hook = await subject();

      const actualSupplyCap = await hook.supplyCap();
      expect(actualSupplyCap).to.eq(subjectSupplyCap);
    });

    it("should set the correct owner address", async () => {
      const hook = await subject();

      const actualOwner = await hook.owner();
      expect(actualOwner).to.eq(subjectOwner);
    });
  });

  describe("#invokePreIssueHook", async () => {
    let subjectSetToken: Address;
    let subjectQuantity: BigNumber;
    let subjectTo: Address;

    beforeEach(async () => {
      issuanceHook = await deployer.hooks.deploySupplyCapIssuanceHook(owner.address, ether(10));

      await debtIssuanceModule.initialize(
        setToken.address,
        ether(.1),
        ether(.01),
        ether(.01),
        owner.address,
        issuanceHook.address
      );

      await setV2Setup.dai.approve(debtIssuanceModule.address, ether(100));

      subjectSetToken = setToken.address;
      subjectQuantity = ether(5);
      subjectTo = owner.address;
    });

    async function subject(): Promise<ContractTransaction> {
      return await debtIssuanceModule.issue(
        subjectSetToken,
        subjectQuantity,
        subjectTo
      );
    }

    it("should not revert", async () => {
      await expect(subject()).to.not.be.reverted;
    });

    describe("when total issuance quantity forces supply over the limit", async () => {
      beforeEach(async () => {
        subjectQuantity = ether(11);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Supply cap exceeded");
      });
    });
  });

  describe("#updateSupplyCap", async () => {
    let subjectNewCap: BigNumber;
    let subjectCaller: Account;

    beforeEach(async () => {
      issuanceHook = await deployer.hooks.deploySupplyCapIssuanceHook(owner.address, ether(10));

      subjectNewCap = ether(20);
      subjectCaller = owner;
    });

    async function subject(): Promise<ContractTransaction> {
      return await issuanceHook.connect(subjectCaller.wallet).updateSupplyCap(subjectNewCap);
    }

    it("should update supply cap", async () => {
      await subject();

      const actualCap = await issuanceHook.supplyCap();

      expect(actualCap).to.eq(subjectNewCap);
    });

    it("should emit the correct SupplyCapUpdated event", async () => {
      await expect(subject()).to.emit(issuanceHook, "SupplyCapUpdated").withArgs(subjectNewCap);
    });

    describe("when caller is not owner", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Ownable: caller is not the owner");
      });
    });
  });
});
