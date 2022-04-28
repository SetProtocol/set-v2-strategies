import "module-alias/register";

import { BigNumber, Contract } from "ethers";
import { Address, Account } from "@utils/types";
import { ADDRESS_ZERO } from "@utils/constants";
import {
  DelegatedManager,
  ClaimExtension,
  ManagerCore,
} from "@utils/contracts/index";
import {
  SetToken,
  AirdropModule,
  ClaimModule,
  ClaimAdapterMock
} from "@setprotocol/set-protocol-v2/utils/contracts";
import DeployHelper from "@utils/deploys";
import {
  addSnapshotBeforeRestoreAfterEach,
  ether,
  getAccounts,
  getWaffleExpect,
  getRandomAddress
} from "@utils/index";
import { SystemFixture } from "@setprotocol/set-protocol-v2/dist/utils/fixtures";
import { getSystemFixture, getRandomAccount } from "@setprotocol/set-protocol-v2/dist/utils/test";
import { ContractTransaction } from "ethers";
import { AirdropSettings } from "@setprotocol/set-protocol-v2/dist/utils/types";

const expect = getWaffleExpect();

describe("ClaimExtension", () => {
  let owner: Account;
  let methodologist: Account;
  let operator: Account;
  let factory: Account;

  let deployer: DeployHelper;
  let setToken: SetToken;
  let setV2Setup: SystemFixture;

  let managerCore: ManagerCore;
  let delegatedManager: DelegatedManager;
  let claimExtension: ClaimExtension;

  let airdropModule: AirdropModule;
  let claimModule: ClaimModule;
  let claimAdapterMockOne: ClaimAdapterMock;
  let claimAdapterMockTwo: ClaimAdapterMock;
  const claimAdapterMockIntegrationNameOne: string = "MOCK_CLAIM_ONE";
  const claimAdapterMockIntegrationNameTwo: string = "MOCK_CLAIM_TWO";

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

    airdropModule = await deployer.setDeployer.modules.deployAirdropModule(setV2Setup.controller.address);
    await setV2Setup.controller.addModule(airdropModule.address);

    claimModule = await deployer.setDeployer.modules.deployClaimModule(setV2Setup.controller.address);
    await setV2Setup.controller.addModule(claimModule.address);
    claimAdapterMockOne = await deployer.setDeployer.mocks.deployClaimAdapterMock();
    await setV2Setup.integrationRegistry.addIntegration(
      claimModule.address,
      claimAdapterMockIntegrationNameOne,
      claimAdapterMockOne.address
    );
    claimAdapterMockTwo = await deployer.setDeployer.mocks.deployClaimAdapterMock();
    await setV2Setup.integrationRegistry.addIntegration(
      claimModule.address,
      claimAdapterMockIntegrationNameTwo,
      claimAdapterMockTwo.address
    );

    managerCore = await deployer.managerCore.deployManagerCore();

    claimExtension = await deployer.globalExtensions.deployClaimExtension(
      managerCore.address,
      airdropModule.address,
      claimModule.address
    );

    setToken = await setV2Setup.createSetToken(
      [setV2Setup.weth.address],
      [ether(1)],
      [setV2Setup.issuanceModule.address, airdropModule.address, claimModule.address]
    );

    await setV2Setup.issuanceModule.initialize(setToken.address, ADDRESS_ZERO);

    delegatedManager = await deployer.manager.deployDelegatedManager(
      setToken.address,
      factory.address,
      methodologist.address,
      [claimExtension.address],
      [operator.address],
      [setV2Setup.dai.address, setV2Setup.weth.address, setV2Setup.wbtc.address],
      true
    );

    await setToken.setManager(delegatedManager.address);

    await managerCore.initialize([claimExtension.address], [factory.address]);
    await managerCore.connect(factory.wallet).addManager(delegatedManager.address);
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#constructor", async () => {
    let subjectManagerCore: Address;
    let subjectAirdropModule: Address;
    let subjectClaimModule: Address;

    beforeEach(async () => {
      subjectManagerCore = managerCore.address;
      subjectAirdropModule = airdropModule.address;
      subjectClaimModule = claimModule.address;
    });

    async function subject(): Promise<ClaimExtension> {
      return await deployer.globalExtensions.deployClaimExtension(
        subjectManagerCore,
        subjectAirdropModule,
        subjectClaimModule
      );
    }

    it("should set the correct AirdropModule address", async () => {
      const claimExtension = await subject();

      const storedModule = await claimExtension.airdropModule();
      expect(storedModule).to.eq(subjectAirdropModule);
    });

    it("should set the correct ClaimModule address", async () => {
      const claimExtension = await subject();

      const storedModule = await claimExtension.claimModule();
      expect(storedModule).to.eq(subjectClaimModule);
    });
  });

  describe("#initializeAirdropModule", async () => {
    let airdrops: Address[];
    let airdropFee: BigNumber;
    let anyoneAbsorb: boolean;
    let airdropFeeRecipient: Address;

    let subjectDelegatedManager: Address;
    let subjectAirdropSettings: AirdropSettings;
    let subjectCaller: Account;

    before(async () => {
      airdrops = [setV2Setup.usdc.address, setV2Setup.weth.address];
      airdropFee = ether(.2);
      anyoneAbsorb = true;
      airdropFeeRecipient = delegatedManager.address;
    });

    beforeEach(async () => {
      await claimExtension.connect(owner.wallet).initializeExtension(delegatedManager.address);

      subjectDelegatedManager = delegatedManager.address;
      subjectAirdropSettings = {
        airdrops,
        feeRecipient: airdropFeeRecipient,
        airdropFee,
        anyoneAbsorb
      } as AirdropSettings;
      subjectCaller = owner;
    });

    async function subject(): Promise<ContractTransaction> {
      return claimExtension.connect(subjectCaller.wallet).initializeAirdropModule(
        subjectDelegatedManager,
        subjectAirdropSettings
      );
    }

    it("should initialize the AirdropModule on the SetToken", async () => {
      await subject();

      const isModuleInitialized: Boolean = await setToken.isInitializedModule(airdropModule.address);
      expect(isModuleInitialized).to.eq(true);
    });

    it("should set the correct airdrops and anyoneAbsorb fields", async () => {
      await subject();

      const airdropSettings: any = await airdropModule.airdropSettings(setToken.address);
      const airdrops = await airdropModule.getAirdrops(setToken.address);

      expect(JSON.stringify(airdrops)).to.eq(JSON.stringify(airdrops));
      expect(airdropSettings.airdropFee).to.eq(airdropFee);
      expect(airdropSettings.anyoneAbsorb).to.eq(anyoneAbsorb);
    });

    it("should set the correct isAirdrop state", async () => {
      await subject();

      const wethIsAirdrop = await airdropModule.isAirdrop(setToken.address, setV2Setup.weth.address);
      const usdcIsAirdrop = await airdropModule.isAirdrop(setToken.address, setV2Setup.usdc.address);

      expect(wethIsAirdrop).to.be.true;
      expect(usdcIsAirdrop).to.be.true;
    });

    describe("when the sender is not the owner", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be owner");
      });
    });

    describe("when the module is not pending or initialized", async () => {
      beforeEach(async () => {
        await subject();
        await delegatedManager.connect(owner.wallet).removeExtensions([claimExtension.address]);
        await delegatedManager.connect(owner.wallet).setManager(owner.address);
        await setToken.connect(owner.wallet).removeModule(airdropModule.address);
        await setToken.connect(owner.wallet).setManager(delegatedManager.address);
        await delegatedManager.connect(owner.wallet).addExtensions([claimExtension.address]);
        await claimExtension.connect(owner.wallet).initializeExtension(delegatedManager.address);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be pending initialization");
      });
    });

    describe("when the module is already initialized", async () => {
      beforeEach(async () => {
        await subject();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be pending initialization");
      });
    });

    describe("when the extension is not pending or initialized", async () => {
      beforeEach(async () => {
        await delegatedManager.connect(owner.wallet).removeExtensions([claimExtension.address]);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be initialized extension");
      });
    });

    describe("when the extension is pending", async () => {
      beforeEach(async () => {
        await delegatedManager.connect(owner.wallet).removeExtensions([claimExtension.address]);
        await delegatedManager.connect(owner.wallet).addExtensions([claimExtension.address]);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be initialized extension");
      });
    });

    describe("when the manager is not a ManagerCore-enabled manager", async () => {
      beforeEach(async () => {
        await managerCore.connect(owner.wallet).removeManager(delegatedManager.address);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be ManagerCore-enabled manager");
      });
    });
  });

  describe("#initializeClaimModule", async () => {
    let subjectDelegatedManager: Address;
    let subjectRewardPools: Address[];
    let subjectIntegrations: string[];
    let subjectAnyoneClaim: boolean;
    let subjectCaller: Account;

    beforeEach(async () => {
      await claimExtension.connect(owner.wallet).initializeExtension(delegatedManager.address);

      subjectDelegatedManager = delegatedManager.address;
      subjectRewardPools = [await getRandomAddress(), await getRandomAddress()];
      subjectIntegrations = [claimAdapterMockIntegrationNameOne, claimAdapterMockIntegrationNameTwo];
      subjectAnyoneClaim = true;
      subjectCaller = owner;
    });

    async function subject(): Promise<ContractTransaction> {
      return claimExtension.connect(subjectCaller.wallet).initializeClaimModule(
        subjectDelegatedManager,
        subjectAnyoneClaim,
        subjectRewardPools,
        subjectIntegrations
      );
    }

    it("should initialize the ClaimModule on the SetToken", async () => {
      await subject();

      const isModuleInitialized: Boolean = await setToken.isInitializedModule(claimModule.address);
      expect(isModuleInitialized).to.eq(true);
    });

    it("should set the anyoneClaim field", async () => {
      const anyoneClaimBefore = await claimModule.anyoneClaim(setToken.address);
      expect(anyoneClaimBefore).to.eq(false);

      await subject();

      const anyoneClaim = await claimModule.anyoneClaim(setToken.address);
      expect(anyoneClaim).to.eq(true);
    });

    it("should add the rewardPools to the rewardPoolList", async () => {
      expect((await claimModule.getRewardPools(setToken.address)).length).to.eq(0);

      await subject();

      const rewardPools = await claimModule.getRewardPools(setToken.address);
      expect(rewardPools[0]).to.eq(subjectRewardPools[0]);
      expect(rewardPools[1]).to.eq(subjectRewardPools[1]);
    });

    it("should add all new integrations for the rewardPools", async () => {
      await subject();

      const rewardPoolOneClaims = await claimModule.getRewardPoolClaims(setToken.address, subjectRewardPools[0]);
      const rewardPoolTwoClaims = await claimModule.getRewardPoolClaims(setToken.address, subjectRewardPools[1]);
      expect(rewardPoolOneClaims[0]).to.eq(claimAdapterMockOne.address);
      expect(rewardPoolTwoClaims[0]).to.eq(claimAdapterMockTwo.address);
    });

    describe("when the sender is not the owner", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be owner");
      });
    });

    describe("when the module is not pending or initialized", async () => {
      beforeEach(async () => {
        await subject();
        await delegatedManager.connect(owner.wallet).removeExtensions([claimExtension.address]);
        await delegatedManager.connect(owner.wallet).setManager(owner.address);
        await setToken.connect(owner.wallet).removeModule(claimModule.address);
        await setToken.connect(owner.wallet).setManager(delegatedManager.address);
        await delegatedManager.connect(owner.wallet).addExtensions([claimExtension.address]);
        await claimExtension.connect(owner.wallet).initializeExtension(delegatedManager.address);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be pending initialization");
      });
    });

    describe("when the module is already initialized", async () => {
      beforeEach(async () => {
        await subject();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be pending initialization");
      });
    });

    describe("when the extension is not pending or initialized", async () => {
      beforeEach(async () => {
        await delegatedManager.connect(owner.wallet).removeExtensions([claimExtension.address]);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be initialized extension");
      });
    });

    describe("when the extension is pending", async () => {
      beforeEach(async () => {
        await delegatedManager.connect(owner.wallet).removeExtensions([claimExtension.address]);
        await delegatedManager.connect(owner.wallet).addExtensions([claimExtension.address]);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be initialized extension");
      });
    });

    describe("when the manager is not a ManagerCore-enabled manager", async () => {
      beforeEach(async () => {
        await managerCore.connect(owner.wallet).removeManager(delegatedManager.address);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be ManagerCore-enabled manager");
      });
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
      return claimExtension.connect(subjectCaller.wallet).initializeExtension(subjectDelegatedManager);
    }

    it("should store the correct SetToken and DelegatedManager on the ClaimExtension", async () => {
      await subject();

      const storedDelegatedManager: Address = await claimExtension.setManagers(setToken.address);
      expect(storedDelegatedManager).to.eq(delegatedManager.address);
    });

    it("should initialize the ClaimExtension on the DelegatedManager", async () => {
      await subject();

      const isExtensionInitialized: Boolean = await delegatedManager.isInitializedExtension(claimExtension.address);
      expect(isExtensionInitialized).to.eq(true);
    });

    it("should emit the correct ClaimExtensionInitialized event", async () => {
      await expect(subject()).to.emit(claimExtension, "ClaimExtensionInitialized").withArgs(
        setToken.address,
        delegatedManager.address
      );
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
        await claimExtension.connect(owner.wallet).initializeExtension(delegatedManager.address);
        await delegatedManager.connect(owner.wallet).removeExtensions([claimExtension.address]);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Extension must be pending");
      });
    });

    describe("when the extension is already initialized", async () => {
      beforeEach(async () => {
        await claimExtension.connect(owner.wallet).initializeExtension(delegatedManager.address);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Extension must be pending");
      });
    });

    describe("when the manager is not a ManagerCore-enabled manager", async () => {
      beforeEach(async () => {
        await managerCore.connect(owner.wallet).removeManager(delegatedManager.address);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be ManagerCore-enabled manager");
      });
    });
  });

  describe("#initializeModulesAndExtension", async () => {
    let airdrops: Address[];
    let airdropFee: BigNumber;
    let anyoneAbsorb: boolean;
    let airdropFeeRecipient: Address;

    let subjectDelegatedManager: Address;
    let subjectAirdropSettings: AirdropSettings;
    let subjectRewardPools: Address[];
    let subjectIntegrations: string[];
    let subjectAnyoneClaim: boolean;
    let subjectCaller: Account;

    before(async () => {
      airdrops = [setV2Setup.usdc.address, setV2Setup.weth.address];
      airdropFee = ether(.2);
      anyoneAbsorb = true;
      airdropFeeRecipient = delegatedManager.address;
    });

    beforeEach(async () => {
      subjectDelegatedManager = delegatedManager.address;
      subjectAirdropSettings = {
        airdrops,
        feeRecipient: airdropFeeRecipient,
        airdropFee,
        anyoneAbsorb
      } as AirdropSettings;
      subjectRewardPools = [await getRandomAddress(), await getRandomAddress()];
      subjectIntegrations = [claimAdapterMockIntegrationNameOne, claimAdapterMockIntegrationNameTwo];
      subjectAnyoneClaim = true;
      subjectCaller = owner;
    });

    async function subject(): Promise<ContractTransaction> {
      return claimExtension.connect(subjectCaller.wallet).initializeModulesAndExtension(
        subjectDelegatedManager,
        subjectAirdropSettings,
        subjectAnyoneClaim,
        subjectRewardPools,
        subjectIntegrations
      );
    }

    it("should initialize the AirdropModule and ClaimModule on the SetToken", async () => {
      await subject();

      const isAirdropModuleInitialized: Boolean = await setToken.isInitializedModule(airdropModule.address);
      const isClaimModuleInitialized: Boolean = await setToken.isInitializedModule(claimModule.address);
      expect(isAirdropModuleInitialized).to.eq(true);
      expect(isClaimModuleInitialized).to.eq(true);
    });

    it("should set the correct airdrops and anyoneAbsorb fields", async () => {
      await subject();

      const airdropSettings: any = await airdropModule.airdropSettings(setToken.address);
      const airdrops = await airdropModule.getAirdrops(setToken.address);

      expect(JSON.stringify(airdrops)).to.eq(JSON.stringify(airdrops));
      expect(airdropSettings.airdropFee).to.eq(airdropFee);
      expect(airdropSettings.anyoneAbsorb).to.eq(anyoneAbsorb);
    });

    it("should set the correct isAirdrop state", async () => {
      await subject();

      const wethIsAirdrop = await airdropModule.isAirdrop(setToken.address, setV2Setup.weth.address);
      const usdcIsAirdrop = await airdropModule.isAirdrop(setToken.address, setV2Setup.usdc.address);

      expect(wethIsAirdrop).to.be.true;
      expect(usdcIsAirdrop).to.be.true;
    });

    it("should set the anyoneClaim field", async () => {
      const anyoneClaimBefore = await claimModule.anyoneClaim(setToken.address);
      expect(anyoneClaimBefore).to.eq(false);

      await subject();

      const anyoneClaim = await claimModule.anyoneClaim(setToken.address);
      expect(anyoneClaim).to.eq(true);
    });

    it("should add the rewardPools to the rewardPoolList", async () => {
      expect((await claimModule.getRewardPools(setToken.address)).length).to.eq(0);

      await subject();

      const rewardPools = await claimModule.getRewardPools(setToken.address);
      expect(rewardPools[0]).to.eq(subjectRewardPools[0]);
      expect(rewardPools[1]).to.eq(subjectRewardPools[1]);
    });

    it("should add all new integrations for the rewardPools", async () => {
      await subject();

      const rewardPoolOneClaims = await claimModule.getRewardPoolClaims(setToken.address, subjectRewardPools[0]);
      const rewardPoolTwoClaims = await claimModule.getRewardPoolClaims(setToken.address, subjectRewardPools[1]);
      expect(rewardPoolOneClaims[0]).to.eq(claimAdapterMockOne.address);
      expect(rewardPoolTwoClaims[0]).to.eq(claimAdapterMockTwo.address);
    });

    it("should store the correct SetToken and DelegatedManager on the ClaimExtension", async () => {
      await subject();

      const storedDelegatedManager: Address = await claimExtension.setManagers(setToken.address);
      expect(storedDelegatedManager).to.eq(delegatedManager.address);
    });

    it("should initialize the ClaimExtension on the DelegatedManager", async () => {
      await subject();

      const isExtensionInitialized: Boolean = await delegatedManager.isInitializedExtension(claimExtension.address);
      expect(isExtensionInitialized).to.eq(true);
    });

    it("should emit the correct ClaimExtensionInitialized event", async () => {
      await expect(subject()).to.emit(claimExtension, "ClaimExtensionInitialized").withArgs(
        setToken.address,
        delegatedManager.address
      );
    });

    describe("when the sender is not the owner", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be owner");
      });
    });

    describe("when the AirdropModule is not pending or initialized", async () => {
      beforeEach(async () => {
        await claimExtension.connect(owner.wallet).initializeExtension(delegatedManager.address);
        await claimExtension.connect(owner.wallet).initializeAirdropModule(
          delegatedManager.address,
          {
            airdrops,
            feeRecipient: airdropFeeRecipient,
            airdropFee,
            anyoneAbsorb
          } as AirdropSettings
        );
        await delegatedManager.connect(owner.wallet).removeExtensions([claimExtension.address]);
        await delegatedManager.connect(owner.wallet).setManager(owner.address);
        await setToken.connect(owner.wallet).removeModule(airdropModule.address);
        await setToken.connect(owner.wallet).setManager(delegatedManager.address);
        await delegatedManager.connect(owner.wallet).addExtensions([claimExtension.address]);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be pending initialization");
      });
    });

    describe("when the AirdropModule is already initialized", async () => {
      beforeEach(async () => {
        await claimExtension.connect(owner.wallet).initializeExtension(delegatedManager.address);
        await claimExtension.connect(owner.wallet).initializeAirdropModule(
          delegatedManager.address,
          {
            airdrops,
            feeRecipient: airdropFeeRecipient,
            airdropFee,
            anyoneAbsorb
          } as AirdropSettings
        );
        await delegatedManager.connect(owner.wallet).removeExtensions([claimExtension.address]);
        await delegatedManager.connect(owner.wallet).addExtensions([claimExtension.address]);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be pending initialization");
      });
    });

    describe("when the ClaimModule is not pending or initialized", async () => {
      beforeEach(async () => {
        await claimExtension.connect(owner.wallet).initializeExtension(delegatedManager.address);
        await claimExtension.connect(owner.wallet).initializeClaimModule(
          delegatedManager.address,
          true,
          [await getRandomAddress(), await getRandomAddress()],
          [claimAdapterMockIntegrationNameOne, claimAdapterMockIntegrationNameTwo]
        );
        await delegatedManager.connect(owner.wallet).removeExtensions([claimExtension.address]);
        await delegatedManager.connect(owner.wallet).setManager(owner.address);
        await setToken.connect(owner.wallet).removeModule(claimModule.address);
        await setToken.connect(owner.wallet).setManager(delegatedManager.address);
        await delegatedManager.connect(owner.wallet).addExtensions([claimExtension.address]);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be pending initialization");
      });
    });

    describe("when the ClaimModule is already initialized", async () => {
      beforeEach(async () => {
        await claimExtension.connect(owner.wallet).initializeExtension(delegatedManager.address);
        await claimExtension.connect(owner.wallet).initializeClaimModule(
          delegatedManager.address,
          true,
          [await getRandomAddress(), await getRandomAddress()],
          [claimAdapterMockIntegrationNameOne, claimAdapterMockIntegrationNameTwo]
        );
        await delegatedManager.connect(owner.wallet).removeExtensions([claimExtension.address]);
        await delegatedManager.connect(owner.wallet).addExtensions([claimExtension.address]);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be pending initialization");
      });
    });

    describe("when the extension is not pending or initialized", async () => {
      beforeEach(async () => {
        await claimExtension.connect(owner.wallet).initializeExtension(delegatedManager.address);
        await delegatedManager.connect(owner.wallet).removeExtensions([claimExtension.address]);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Extension must be pending");
      });
    });

    describe("when the extension is already initialized", async () => {
      beforeEach(async () => {
        await claimExtension.connect(owner.wallet).initializeExtension(delegatedManager.address);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Extension must be pending");
      });
    });

    describe("when the manager is not a ManagerCore-enabled manager", async () => {
      beforeEach(async () => {
        await managerCore.connect(owner.wallet).removeManager(delegatedManager.address);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be ManagerCore-enabled manager");
      });
    });
  });

  describe("#removeExtension", async () => {
    let subjectManager: Contract;
    let subjectClaimExtension: Address[];
    let subjectCaller: Account;

    beforeEach(async () => {
      await claimExtension.connect(owner.wallet).initializeExtension(delegatedManager.address);

      subjectManager = delegatedManager;
      subjectClaimExtension = [claimExtension.address];
      subjectCaller = owner;
    });

    async function subject(): Promise<ContractTransaction> {
      return subjectManager.connect(subjectCaller.wallet).removeExtensions(subjectClaimExtension);
    }

    it("should clear SetToken and DelegatedManager from ClaimExtension state", async () => {
      await subject();

      const storedDelegatedManager: Address = await claimExtension.setManagers(setToken.address);
      expect(storedDelegatedManager).to.eq(ADDRESS_ZERO);
    });

    it("should emit the correct ExtensionRemoved event", async () => {
      await expect(subject()).to.emit(claimExtension, "ExtensionRemoved").withArgs(
        setToken.address,
        delegatedManager.address
      );
    });

    describe("when the caller is not the SetToken manager", async () => {
      beforeEach(async () => {
        subjectManager = await deployer.mocks.deployManagerMock(setToken.address);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be Manager");
      });
    });
  });
});