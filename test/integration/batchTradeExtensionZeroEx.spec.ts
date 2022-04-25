import "module-alias/register";

import { BigNumber, ContractTransaction } from "ethers";
import { ethers } from "hardhat";

import { Address, Account, TradeInfo } from "@utils/types";
import { ZERO, ADDRESS_ZERO } from "@utils/constants";
import DeployHelper from "@utils/deploys";

// Strategies
import {
  DelegatedManager,
  BatchTradeExtension,
  ManagerCore,
} from "@utils/contracts/index";
import {
  ether,
  bitcoin,
  preciseMul,
  cacheBeforeEach,
  getAccounts,
  getWaffleExpect
} from "@utils/index";
import {
  BatchTradeUtils
} from "@utils/common";

// SetProtocol
import dependencies from "@setprotocol/set-protocol-v2/dist/utils/deploys/dependencies";
import {
  SetToken,
  TradeModule,
  BasicIssuanceModule,
  ZeroExApiAdapter,
} from "@setprotocol/set-protocol-v2/utils/contracts";
import {
  getSystemFixture,
  getForkedTokens,
  initializeForkedTokens,
  ForkedTokens
} from "@setprotocol/set-protocol-v2/dist/utils/test";
import {
  SystemFixture
} from "@setprotocol/set-protocol-v2/dist/utils/fixtures";

const expect = getWaffleExpect();

describe("BatchTradeExtension - ZeroExAPITradeAdapter - TradeModule Integration [ @forked-mainnet ]", () => {
  let owner: Account;
  let methodologist: Account;
  let operator: Account;
  let factory: Account;

  let deployer: DeployHelper;

  let zeroExApiAdapter: ZeroExApiAdapter;
  let zeroExApiAdapterName: string;

  let setToken: SetToken;
  let managerCore: ManagerCore;
  let delegatedManager: DelegatedManager;
  let batchTradeExtension: BatchTradeExtension;
  let batchTradeUtils: BatchTradeUtils;

  let setV2Setup: SystemFixture;
  let zeroExAddress: Address;
  let tradeModule: TradeModule;
  let issuanceModule: BasicIssuanceModule;
  let tokens: ForkedTokens;
  let daiWeight: BigNumber;
  let wethWeight: BigNumber;
  let wbtcWeight: BigNumber;
  let totalSupply: BigNumber;

  cacheBeforeEach(async () => {
    [
      owner,
      methodologist,
      operator,
      factory
    ] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);
    setV2Setup = getSystemFixture(owner.address);
    batchTradeUtils = new BatchTradeUtils(ethers.provider);
    await setV2Setup.initialize();

    // Set variables
    issuanceModule = setV2Setup.issuanceModule;
    zeroExAddress = dependencies.ZERO_EX_EXCHANGE["1"];

    // Get forked tokens and fund owner so they can create an initial issuance
    tokens = getForkedTokens();
    await initializeForkedTokens(deployer.setDeployer);

    // Deploy ZeroExApiAdapter
    zeroExApiAdapter = await deployer
      .setDeployer
      .adapters
      .deployZeroExApiAdapter(zeroExAddress, tokens.weth.address);

    zeroExApiAdapterName = "ZeroExApiAdapterV5";

    // Deploy TradeModule and wire up with ZeroExApiAdapter
    tradeModule = await deployer.setDeployer.modules.deployTradeModule(setV2Setup.controller.address);
    await setV2Setup.controller.addModule(tradeModule.address);

    await setV2Setup.integrationRegistry.addIntegration(
      tradeModule.address,
      zeroExApiAdapterName,
      zeroExApiAdapter.address
    );

    // Deploy and issue 1 SetToken
    // BED-like: each token has ~1/3 weight
    daiWeight = ether(35);
    wethWeight = ether(.012099);
    wbtcWeight = bitcoin(.000913);

    setToken = await setV2Setup.createSetToken(
      [tokens.dai.address, tokens.weth.address, tokens.wbtc.address],
      [daiWeight, wethWeight, wbtcWeight],
      [setV2Setup.issuanceModule.address, tradeModule.address]
    );

    await tradeModule.connect(owner.wallet).initialize(setToken.address);
    await issuanceModule.connect(owner.wallet).initialize(setToken.address, ADDRESS_ZERO);

    await tokens.dai.transfer(owner.address, daiWeight.mul(100));
    await tokens.weth.transfer(owner.address, wethWeight.mul(100));
    await tokens.wbtc.transfer(owner.address, wbtcWeight.mul(100));

    await tokens.dai.connect(owner.wallet).approve(issuanceModule.address, ethers.constants.MaxUint256);
    await tokens.weth.connect(owner.wallet).approve(issuanceModule.address, ethers.constants.MaxUint256);
    await tokens.wbtc.connect(owner.wallet).approve(issuanceModule.address, ethers.constants.MaxUint256);

    await setV2Setup.issuanceModule.issue(setToken.address, ether(1), owner.address);
    totalSupply = await setToken.totalSupply();

    // Deploy DelegatedManager with BatchTradeExtension and transfer SetToken managership to it
    managerCore = await deployer.managerCore.deployManagerCore();

    batchTradeExtension = await deployer.globalExtensions.deployBatchTradeExtension(
      managerCore.address,
      tradeModule.address
    );

    delegatedManager = await deployer.manager.deployDelegatedManager(
      setToken.address,
      factory.address,
      methodologist.address,
      [batchTradeExtension.address],
      [operator.address],
      [tokens.dai.address, tokens.weth.address, tokens.wbtc.address],
      true
    );

    await setToken.setManager(delegatedManager.address);

    await managerCore.initialize([batchTradeExtension.address], [factory.address]);
    await managerCore.connect(factory.wallet).addManager(delegatedManager.address);
    await batchTradeExtension.connect(owner.wallet).initializeExtension(delegatedManager.address);
  });

  describe("#batchTrade", function() {
    let quoteSlippage: number;
    let subjectSetToken: Address;
    let subjectTradeOne: TradeInfo;
    let subjectTradeTwo: TradeInfo;
    let subjectTrades: TradeInfo[];
    let subjectCaller: Account;

    async function subject(): Promise<ContractTransaction> {
      return batchTradeExtension.connect(subjectCaller.wallet).batchTrade(
        subjectSetToken,
        subjectTrades
      );
    }

    context("when trading all dai and weth into wbtc", () => {
      beforeEach(async () => {
        const daiPositionUnit = await setToken.getDefaultPositionRealUnit(tokens.dai.address);
        const wethPositionUnit = await setToken.getDefaultPositionRealUnit(tokens.weth.address);

        const daiAmount = preciseMul(daiPositionUnit, totalSupply);
        const wethAmount = preciseMul(wethPositionUnit, totalSupply);

        quoteSlippage = .99; // Wide

        const daiQuote = await batchTradeUtils.getZeroExQuote(
          delegatedManager.address,
          tokens.dai.address,
          tokens.wbtc.address,
          daiAmount,
          quoteSlippage
        );

        const wethQuote = await batchTradeUtils.getZeroExQuote(
          delegatedManager.address,
          tokens.weth.address,
          tokens.wbtc.address,
          wethAmount,
          quoteSlippage
        );

        subjectTradeOne = {
          exchangeName: zeroExApiAdapterName,
          sendToken: tokens.dai.address,
          sendQuantity: daiPositionUnit,
          receiveToken: tokens.wbtc.address,
          receiveQuantity: ether(0),
          data: daiQuote.data
        } as TradeInfo;

        subjectTradeTwo = {
          exchangeName: zeroExApiAdapterName,
          sendToken: tokens.weth.address,
          sendQuantity: wethPositionUnit,
          receiveToken: tokens.wbtc.address,
          receiveQuantity: ether(0),
          data: wethQuote.data
        } as TradeInfo;

        subjectTrades = [subjectTradeOne, subjectTradeTwo];
        subjectSetToken = setToken.address;
        subjectCaller = operator;
      });

      it("trades as expected", async () => {
        const initialDaiDefaultPosition = await setToken.getDefaultPositionRealUnit(tokens.dai.address);
        const initialWethDefaultPosition = await setToken.getDefaultPositionRealUnit(tokens.weth.address);
        const initialWbtcDefaultPosition = await setToken.getDefaultPositionRealUnit(tokens.wbtc.address);

        const result = await subject();

        const finalDaiDefaultPosition = await setToken.getDefaultPositionRealUnit(tokens.dai.address);
        const finalWethDefaultPosition = await setToken.getDefaultPositionRealUnit(tokens.weth.address);
        const finalWbtcDefaultPosition = await setToken.getDefaultPositionRealUnit(tokens.wbtc.address);

        const txs = await batchTradeUtils.getBatchTradeResults(
          batchTradeExtension,
          result.hash,
          subjectTrades,
        );

        expect(txs[0].success).eq(true);
        expect(txs[1].success).eq(true);

        expect(initialDaiDefaultPosition).gt(ZERO);
        expect(initialWethDefaultPosition).gt(ZERO);
        expect(initialWbtcDefaultPosition).gt(ZERO);

        expect(finalDaiDefaultPosition).eq(ZERO);
        expect(finalWethDefaultPosition).eq(ZERO);
        expect(finalWbtcDefaultPosition).gt(initialWbtcDefaultPosition);
      });
    });

    // Skipping next two tests because they're unstable & we're using real-time quotes from 0x.
    // Preserving these because setups are useful for debugging and generating fixture data.
    // (A stable unit test case was developed to hit the relevant bytes error `catch` block in batchTrade)
    context.skip("when trading and triggering underbought error", () => {
      beforeEach(async () => {
        // Issue 4 more sets
        await setV2Setup.issuanceModule.issue(setToken.address, ether(4), owner.address);

        const daiPositionUnit = await setToken.getDefaultPositionRealUnit(tokens.dai.address);
        const daiAmount = preciseMul(daiPositionUnit, totalSupply);

        quoteSlippage = 0; // Narrow

        const daiQuote = await batchTradeUtils.getZeroExQuote(
          delegatedManager.address,
          tokens.dai.address,
          tokens.wbtc.address,
          daiAmount,
          quoteSlippage
        );

        subjectTradeOne = {
          exchangeName: zeroExApiAdapterName,
          sendToken: tokens.dai.address,
          sendQuantity: daiPositionUnit,
          receiveToken: tokens.wbtc.address,
          receiveQuantity: ether(0),
          data: daiQuote.data
        } as TradeInfo;

        subjectTrades = [subjectTradeOne];
        subjectSetToken = setToken.address;
        subjectCaller = operator;
      });

      it("trades as expected", async () => {
        const initialDaiDefaultPosition = await setToken.getDefaultPositionRealUnit(tokens.dai.address);
        const initialWbtcDefaultPosition = await setToken.getDefaultPositionRealUnit(tokens.wbtc.address);

        const result = await subject();

        const finalDaiDefaultPosition = await setToken.getDefaultPositionRealUnit(tokens.dai.address);
        const finalWbtcDefaultPosition = await setToken.getDefaultPositionRealUnit(tokens.wbtc.address);

        const txs = await batchTradeUtils.getBatchTradeResults(
          batchTradeExtension,
          result.hash,
          subjectTrades,
        );

        // Verify that revert reason is human readable
        expect(txs[0].success).eq(false);
        expect(txs[0].revertReason!.length).gt(0);
        expect(txs[0].revertReason!.slice(0,2)).not.eq("0x");

        expect(finalDaiDefaultPosition).eq(initialDaiDefaultPosition);
        expect(finalWbtcDefaultPosition).eq(initialWbtcDefaultPosition);
      });
    });

    context.skip("when trading and triggering a bytes error", () => {
      beforeEach(async () => {
        // Issue 70 sets
        await setV2Setup.issuanceModule.issue(setToken.address, ether(70), owner.address);
        totalSupply = await setToken.totalSupply();

        const daiPositionUnit = await setToken.getDefaultPositionRealUnit(tokens.dai.address);
        const daiAmount = preciseMul(daiPositionUnit, totalSupply);

        quoteSlippage = .01; // Narrow

        const daiQuote = await batchTradeUtils.getZeroExQuote(
          delegatedManager.address,
          tokens.dai.address,
          tokens.wbtc.address,
          daiAmount,
          quoteSlippage
        );

        subjectTradeOne = {
          exchangeName: zeroExApiAdapterName,
          sendToken: tokens.dai.address,
          sendQuantity: daiPositionUnit,
          receiveToken: tokens.wbtc.address,
          receiveQuantity: ether(0),
          data: daiQuote.data
        } as TradeInfo;

        subjectTrades = [subjectTradeOne];
        subjectSetToken = setToken.address;
        subjectCaller = operator;
      });

      it("trades as expected", async () => {
        const initialDaiDefaultPosition = await setToken.getDefaultPositionRealUnit(tokens.dai.address);
        const initialWbtcDefaultPosition = await setToken.getDefaultPositionRealUnit(tokens.wbtc.address);

        const result = await subject();

        const finalDaiDefaultPosition = await setToken.getDefaultPositionRealUnit(tokens.dai.address);
        const finalWbtcDefaultPosition = await setToken.getDefaultPositionRealUnit(tokens.wbtc.address);

        // Not testing this because probably varies depending on quote routing but ...
        // revertReason: '0x734e6e1c6af479b200000000000000000000000000000000000000000000000000000000'
        const txs = await batchTradeUtils.getBatchTradeResults(
          batchTradeExtension,
          result.hash,
          subjectTrades,
        );

        expect(txs[0].success).eq(false);
        expect(finalDaiDefaultPosition).eq(initialDaiDefaultPosition);
        expect(finalWbtcDefaultPosition).eq(initialWbtcDefaultPosition);
      });
    });
  });
});