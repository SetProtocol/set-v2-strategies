import "module-alias/register";

import { Account, Address } from "@utils/types";
import { ADDRESS_ZERO } from "@utils/constants";
import {
  DelegatedManagerFactory,
  ManagerCore
} from "@utils/contracts/index";
import DeployHelper from "@utils/deploys";
import {
  addSnapshotBeforeRestoreAfterEach,
  getAccounts,
  getWaffleExpect,
} from "@utils/index";
import { getSystemFixture, getRandomAccount } from "@setprotocol/set-protocol-v2/utils/test";
import { SystemFixture } from "@setprotocol/set-protocol-v2/utils/fixtures";


const expect = getWaffleExpect();

describe("ManagerCore", () => {
  let owner: Account;

  let deployer: DeployHelper;
  let setV2Setup: SystemFixture;

  let managerCore: ManagerCore;
  let delegatedManagerFactory: DelegatedManagerFactory;

  before(async () => {
    [
      owner
    ] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);

    setV2Setup = getSystemFixture(owner.address);
    await setV2Setup.initialize();

    managerCore = await deployer.managerCore.deployManagerCore();

    delegatedManagerFactory = await deployer.factories.deployDelegatedManagerFactory(
      setV2Setup.factory.address
    );
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#constructor", async () => {
    let subjectDeployer: DeployHelper;

    beforeEach(async () => {
      subjectDeployer = new DeployHelper(owner.wallet);
    });

    async function subject(): Promise<ManagerCore> {
      return await subjectDeployer.managerCore.deployManagerCore();
    }

    it("should set the correct owner address", async () => {
      const managerCore = await subject();

      const storedOwner = await managerCore.owner();
      expect (storedOwner).to.eq(owner.address);
    });
  });

  describe("#initialize", async () => {
    let subjectCaller: Account;
    let subjectFactories: Address[];

    beforeEach(async () => {
      subjectCaller = owner;
      subjectFactories = [delegatedManagerFactory.address];
    });

    async function subject(): Promise<any> {
      return await managerCore.connect(subjectCaller.wallet).initialize(subjectFactories);
    }

    it("should have set the correct factories length of 1", async () => {
      await subject();

      const factories = await managerCore.getFactories();
      expect(factories.length).to.eq(1);
    });

    it("should have a valid factory", async () => {
      await subject();

      const validFactory = await managerCore.isFactory(delegatedManagerFactory.address);
      expect(validFactory).to.eq(true);
    });

    it("should initialize the ManagerCore", async () => {
      await subject();

      const storedIsInitialized = await managerCore.isInitialized();
      expect(storedIsInitialized).to.eq(true);
    });

    describe("when the sender is not the owner", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Ownable: caller is not the owner");
      });
    });

    describe("when zero address passed for factory", async () => {
      beforeEach(async () => {
        subjectFactories = [ADDRESS_ZERO];
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Zero address submitted.");
      });
    });

    describe("when the ManagerCore is already initialized", async () => {
      beforeEach(async () => {
        await subject();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("ManagerCore is already initialized");
      });
    });
  });

  describe("#addFactory", async () => {
    let subjectFactory: Address;
    let subjectCaller: Account;
    let subjectManagerCore: ManagerCore;

    beforeEach(async () => {
      await managerCore.initialize([]);

      subjectFactory = delegatedManagerFactory.address;
      subjectCaller = owner;
      subjectManagerCore = managerCore;
    });

    async function subject(): Promise<any> {
      return await subjectManagerCore.connect(subjectCaller.wallet).addFactory(subjectFactory);
    }

    it("should be stored in the factories array", async () => {
      await subject();

      const factories = await managerCore.getFactories();
      expect(factories.length).to.eq(1);
    });

    it("should be returned as a valid factory", async () => {
      await subject();

      const validFactory = await managerCore.isFactory(delegatedManagerFactory.address);
      expect(validFactory).to.eq(true);
    });

    it("should emit the FactoryAdded event", async () => {
      await expect(subject()).to.emit(managerCore, "FactoryAdded").withArgs(subjectFactory);
    });

    describe("when the ManagerCore is not initialized", async () => {
      beforeEach(async () => {
        subjectManagerCore = await deployer.managerCore.deployManagerCore();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Contract must be initialized.");
      });
    });

    describe("when the sender is not the owner", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Ownable: caller is not the owner");
      });
    });

    describe("when the factory already exists", async () => {
      beforeEach(async () => {
        await subject();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Factory already exists");
      });
    });
  });

  describe("#removeFactory", async () => {
    let subjectFactory: Address;
    let subjectCaller: Account;
    let subjectManagerCore: ManagerCore;

    beforeEach(async () => {
      await managerCore.initialize([delegatedManagerFactory.address]);

      subjectFactory = delegatedManagerFactory.address;
      subjectCaller = owner;
      subjectManagerCore = managerCore;
    });

    async function subject(): Promise<any> {
      return await subjectManagerCore.connect(subjectCaller.wallet).removeFactory(subjectFactory);
    }

    it("should remove factory from factories array", async () => {
      await subject();

      const factories = await managerCore.getFactories();
      expect(factories.length).to.eq(0);
    });

    it("should return false as a valid factory", async () => {
      await subject();

      const validFactory = await managerCore.isFactory(delegatedManagerFactory.address);
      expect(validFactory).to.eq(false);
    });

    it("should emit the FactoryRemoved event", async () => {
      await expect(subject()).to.emit(managerCore, "FactoryRemoved").withArgs(subjectFactory);
    });

    describe("when the ManagerCore is not initialized", async () => {
      beforeEach(async () => {
        subjectManagerCore = await deployer.managerCore.deployManagerCore();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Contract must be initialized.");
      });
    });

    describe("when the sender is not the owner", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Ownable: caller is not the owner");
      });
    });

    describe("when the factory does not exist", async () => {
      beforeEach(async () => {
        await subject();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Factory does not exist");
      });
    });
  });
});