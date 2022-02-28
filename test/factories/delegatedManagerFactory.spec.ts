import "module-alias/register";

import { Address, Account, Bytes } from "@utils/types";
import { ADDRESS_ZERO, EXTENSION_STATE, ZERO } from "@utils/constants";
import { DelegatedManagerFactory, BaseGlobalExtensionMock } from "@utils/contracts/index";
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

  let delegatedManagerFactory: DelegatedManagerFactory;
  let baseExtension: BaseGlobalExtensionMock;

  before(async () => {
    [
      owner,
      otherAccount,
      methodologist,
      operatorOne,
      operatorTwo,
    ] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);

    setV2Setup = getSystemFixture(owner.address);
    await setV2Setup.initialize();

    baseExtension = await deployer.mocks.deployBaseGlobalExtensionMock();
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#constructor", async () => {
    let subjectSetTokenFactory: Address;

    beforeEach(async () => {
      subjectSetTokenFactory = setV2Setup.factory.address;
    });

    async function subject(): Promise<DelegatedManagerFactory> {
      return await deployer.factories.deployDelegatedManagerFactory(
        subjectSetTokenFactory
      );
    }

    it("should set the correct SetToken address", async () => {
      const delegatedManager = await subject();

      const actualFactory = await delegatedManager.setTokenFactory();
      expect (actualFactory).to.eq(subjectSetTokenFactory);
    });
  });

  context("when the factory has been deployed", async () => {
    beforeEach(async () => {
      
    });
  });
});