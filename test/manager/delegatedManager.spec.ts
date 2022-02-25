import "module-alias/register";

import { Address, Account } from "@utils/types";
import { ADDRESS_ZERO, ZERO } from "@utils/constants";
import { DelegatedManager, BaseExtensionMock } from "@utils/contracts/index";
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
import { getSystemFixture } from "@setprotocol/set-protocol-v2/utils/test";

const expect = getWaffleExpect();

describe("DelegatedManager", () => {
  let owner: Account;
  let methodologist: Account;
  let otherAccount: Account;
  let factory: Account;
  let operatorOne: Account;
  let operatorTwo: Account;
  let setV2Setup: SystemFixture;

  let deployer: DeployHelper;
  let setToken: SetToken;

  let delegatedManager: DelegatedManager;
  let baseExtension: BaseExtensionMock;

  before(async () => {
    [
      owner,
      otherAccount,
      newManager,
      methodologist,
      factory,
      operatorOne,
      operatorTwo
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

    baseExtension = await deployer.mocks.deployBaseExtensionMock(otherAccount.address);

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

  describe.only("#constructor", async () => {
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

    it("should set the correct Extension approvals and arrays", async () => {
      const delegatedManager = await subject();

      const actualExtensionArray = await delegatedManager.getExtensions();
      const isApprovedExtension = await delegatedManager.extensionAllowlist(subjectExtensions[0]);

      expect(JSON.stringify(actualExtensionArray)).to.eq(JSON.stringify(subjectExtensions));
      expect(isApprovedExtension).to.be.true;
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

  // describe("#interactManager", async () => {
  //   let subjectModule: Address;
  //   let subjectCallData: Bytes;

  //   beforeEach(async () => {
  //     await delegatedManager.connect(owner.wallet).addAdapter(baseExtension.address);

  //     subjectModule = setV2Setup.streamingFeeModule.address;

  //     // Invoke update fee recipient
  //     subjectCallData = setV2Setup.streamingFeeModule.interface.encodeFunctionData("updateFeeRecipient", [
  //       setToken.address,
  //       otherAccount.address,
  //     ]);
  //   });

  //   async function subject(): Promise<any> {
  //     return baseExtension.interactManager(subjectModule, subjectCallData);
  //   }

  //   it("should call updateFeeRecipient on the streaming fee module from the SetToken", async () => {
  //     await subject();
  //     const feeStates = await setV2Setup.streamingFeeModule.feeStates(setToken.address);
  //     expect(feeStates.feeRecipient).to.eq(otherAccount.address);
  //   });

  //   describe("when the caller is not an adapter", async () => {
  //     beforeEach(async () => {
  //       await delegatedManager.connect(owner.wallet).removeAdapter(baseExtension.address);
  //     });

  //     it("should revert", async () => {
  //       await expect(subject()).to.be.revertedWith("Must be adapter");
  //     });
  //   });
  // });

  describe("#addAdapter", async () => {
    let subjectAdapter: Address;
    let subjectCaller: Account;

    beforeEach(async () => {
      subjectAdapter = baseExtension.address;
      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      return delegatedManager.connect(subjectCaller.wallet).addAdapter(subjectAdapter);
    }

    it("should add the adapter address", async () => {
      await subject();
      const adapters = await delegatedManager.getAdapters();

      expect(adapters[0]).to.eq(baseExtension.address);
    });

    it("should set the adapter mapping", async () => {
      await subject();
      const isAdapter = await delegatedManager.isAdapter(subjectAdapter);

      expect(isAdapter).to.be.true;
    });

    it("should emit the correct AdapterAdded event", async () => {
      await expect(subject()).to.emit(delegatedManager, "AdapterAdded").withArgs(baseExtension.address);
    });

    describe("when the adapter already exists", async () => {
      beforeEach(async () => {
        await subject();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Adapter already exists");
      });
    });

    describe("when adapter has different manager address", async () => {
      beforeEach(async () => {
        subjectAdapter = (await deployer.mocks.deployBaseExtensionMock(await getRandomAddress())).address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Adapter manager invalid");
      });
    });

    describe("when the caller is not the operator", async () => {
      beforeEach(async () => {
        subjectCaller = methodologist;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be operator");
      });
    });
  });

  // describe("#removeAdapter", async () => {
  //   let subjectAdapter: Address;
  //   let subjectCaller: Account;

  //   beforeEach(async () => {
  //     await delegatedManager.connect(owner.wallet).addAdapter(baseExtension.address);

  //     subjectAdapter = baseExtension.address;
  //     subjectCaller = owner;
  //   });

  //   async function subject(): Promise<any> {
  //     return delegatedManager.connect(subjectCaller.wallet).removeAdapter(subjectAdapter);
  //   }

  //   it("should remove the adapter address", async () => {
  //     await subject();
  //     const adapters = await delegatedManager.getAdapters();

  //     expect(adapters.length).to.eq(0);
  //   });

  //   it("should set the adapter mapping", async () => {
  //     await subject();
  //     const isAdapter = await delegatedManager.isAdapter(subjectAdapter);

  //     expect(isAdapter).to.be.false;
  //   });

  //   it("should emit the correct AdapterRemoved event", async () => {
  //     await expect(subject()).to.emit(delegatedManager, "AdapterRemoved").withArgs(baseExtension.address);
  //   });

  //   describe("when the adapter does not exist", async () => {
  //     beforeEach(async () => {
  //       subjectAdapter = await getRandomAddress();
  //     });

  //     it("should revert", async () => {
  //       await expect(subject()).to.be.revertedWith("Adapter does not exist");
  //     });
  //   });

  //   describe("when the caller is not the operator", async () => {
  //     beforeEach(async () => {
  //       subjectCaller = methodologist;
  //     });

  //     it("should revert", async () => {
  //       await expect(subject()).to.be.revertedWith("Must be operator");
  //     });
  //   });
  // });


  // describe("#setMethodologist", async () => {
  //   let subjectNewMethodologist: Address;
  //   let subjectCaller: Account;

  //   beforeEach(async () => {
  //     subjectNewMethodologist = await getRandomAddress();
  //     subjectCaller = methodologist;
  //   });

  //   async function subject(): Promise<any> {
  //     return delegatedManager.connect(subjectCaller.wallet).setMethodologist(subjectNewMethodologist);
  //   }

  //   it("should set the new methodologist", async () => {
  //     await subject();
  //     const actualIndexModule = await delegatedManager.methodologist();
  //     expect(actualIndexModule).to.eq(subjectNewMethodologist);
  //   });

  //   it("should emit the correct MethodologistChanged event", async () => {
  //     await expect(subject()).to.emit(delegatedManager, "MethodologistChanged").withArgs(methodologist.address, subjectNewMethodologist);
  //   });

  //   describe("when the caller is not the methodologist", async () => {
  //     beforeEach(async () => {
  //       subjectCaller = await getRandomAccount();
  //     });

  //     it("should revert", async () => {
  //       await expect(subject()).to.be.revertedWith("Must be methodologist");
  //     });
  //   });
  // });

  // describe("#setOperator", async () => {
  //   let subjectNewOperator: Address;
  //   let subjectCaller: Account;

  //   beforeEach(async () => {
  //     subjectNewOperator = await getRandomAddress();
  //     subjectCaller = owner;
  //   });

  //   async function subject(): Promise<any> {
  //     return delegatedManager.connect(subjectCaller.wallet).setOperator(subjectNewOperator);
  //   }

  //   it("should set the new operator", async () => {
  //     await subject();
  //     const actualIndexModule = await delegatedManager.operator();
  //     expect(actualIndexModule).to.eq(subjectNewOperator);
  //   });

  //   it("should emit the correct OperatorChanged event", async () => {
  //     await expect(subject()).to.emit(delegatedManager, "OperatorChanged").withArgs(owner.address, subjectNewOperator);
  //   });

  //   describe("when the caller is not the operator", async () => {
  //     beforeEach(async () => {
  //       subjectCaller = await getRandomAccount();
  //     });

  //     it("should revert", async () => {
  //       await expect(subject()).to.be.revertedWith("Must be operator");
  //     });
  //   });
  // });

  // describe("#addModule", async () => {
  //   let subjectModule: Address;
  //   let subjectCaller: Account;

  //   beforeEach(async () => {
  //     await setV2Setup.controller.addModule(otherAccount.address);

  //     subjectModule = otherAccount.address;
  //     subjectCaller = owner;
  //   });

  //   async function subject(): Promise<any> {
  //     return delegatedManager.connect(subjectCaller.wallet).addModule(subjectModule);
  //   }

  //   it("should add the module to the SetToken", async () => {
  //     await subject();
  //     const isModule = await setToken.isPendingModule(subjectModule);
  //     expect(isModule).to.eq(true);
  //   });

  //   describe("when the caller is not the operator", async () => {
  //     beforeEach(async () => {
  //       subjectCaller = await getRandomAccount();
  //     });

  //     it("should revert", async () => {
  //       await expect(subject()).to.be.revertedWith("Must be operator");
  //     });
  //   });
  // });

  // describe("#removeModule", async () => {
  //   let subjectModule: Address;
  //   let subjectCaller: Account;

  //   beforeEach(async () => {
  //     subjectModule = setV2Setup.streamingFeeModule.address;
  //     subjectCaller = owner;
  //   });

  //   async function subject(): Promise<any> {
  //     return delegatedManager.connect(subjectCaller.wallet).removeModule(subjectModule);
  //   }

  //   it("should remove the module from the SetToken", async () => {
  //     await subject();
  //     const isModule = await setToken.isInitializedModule(subjectModule);
  //     expect(isModule).to.eq(false);
  //   });

  //   describe("when the caller is not the operator", async () => {
  //     beforeEach(async () => {
  //       subjectCaller = await getRandomAccount();
  //     });

  //     it("should revert", async () => {
  //       await expect(subject()).to.be.revertedWith("Must be operator");
  //     });
  //   });
  // });

  // describe("#setManager", async () => {
  //   let subjectNewManager: Address;
  //   let subjectCaller: Account;

  //   beforeEach(async () => {
  //     subjectNewManager = newManager.address;
  //     subjectCaller = owner;
  //   });

  //   async function subject(): Promise<any> {
  //     return delegatedManager.connect(subjectCaller.wallet).setManager(subjectNewManager);
  //   }

  //   it("should change the manager address", async () => {
  //     await subject();
  //     const manager = await setToken.manager();

  //     expect(manager).to.eq(newManager.address);
  //   });

  //   describe("when passed manager is the zero address", async () => {
  //     beforeEach(async () => {
  //       subjectNewManager = ADDRESS_ZERO;
  //     });

  //     it("should revert", async () => {
  //       await expect(subject()).to.be.revertedWith("Zero address not valid");
  //     });
  //   });

  //   describe("when the caller is not the operator", async () => {
  //     beforeEach(async () => {
  //       subjectCaller = methodologist;
  //     });

  //     it("should revert", async () => {
  //       await expect(subject()).to.be.revertedWith("Must be operator");
  //     });
  //   });
  // });
});
