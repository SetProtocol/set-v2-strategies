import "module-alias/register";
import { BigNumber, ContractTransaction } from "ethers";
import { ethers } from "hardhat";
import { solidityPack } from "ethers/lib/utils";

import {
  Address,
  Account,
  PerpV2BasisContractSettings,
  PerpV2BasisMethodologySettings,
  PerpV2BasisExecutionSettings,
  PerpV2BasisIncentiveSettings,
  PerpV2BasisExchangeSettings
} from "@utils/types";

import { ADDRESS_ZERO, ZERO, ONE_DAY_IN_SECONDS, TWO } from "../../utils/constants";
import {
  PerpV2BasisTradingModule,
  SetToken,
  PositionV2,
  PerpV2LibraryV2,
  PerpV2Positions,
  SlippageIssuanceModule,
  TradeModule,
  UniswapV3ExchangeAdapterV2,
  WETH9
} from "@setprotocol/set-protocol-v2/utils/contracts";
import DeployHelper from "../../utils/deploys";
import {
  cacheBeforeEach,
  ether,
  getEthBalance,
  getAccounts,
  getLastBlockTimestamp,
  getRandomAccount,
  getWaffleExpect,
  preciseDiv,
  preciseMul,
  usdc,
  increaseTimeAsync,
  calculateNewLeverageRatioPerpV2Basis
} from "../../utils/index";
import { PerpV2PriceFeedMock } from "@utils/contracts";

import { PerpV2Fixture, SystemFixture, UniswapV3Fixture } from "@setprotocol/set-protocol-v2/utils/fixtures";
import { getPerpV2Fixture, getSystemFixture, getUniswapV3Fixture } from "@setprotocol/set-protocol-v2/utils/test";

import { BaseManager, DeltaNeutralBasisTradingStrategyExtension } from "@utils/contracts/index";

const expect = getWaffleExpect();
const provider = ethers.provider;

// todo: Add unit tests for all events

describe("DeltaNeutralBasisTradingStrategyExtension", () => {
  let owner: Account;
  let methodologist: Account;
  let maker: Account;
  let taker: Account;
  let systemSetup: SystemFixture;
  let perpV2Setup: PerpV2Fixture;
  let uniV3Setup: UniswapV3Fixture;

  let deployer: DeployHelper;
  let setToken: SetToken;

  let strategy: PerpV2BasisContractSettings;
  let methodology: PerpV2BasisMethodologySettings;
  let execution: PerpV2BasisExecutionSettings;
  let incentive: PerpV2BasisIncentiveSettings;
  let exchange: PerpV2BasisExchangeSettings;
  let customTargetLeverageRatio: any;
  let customMinLeverageRatio: any;
  let basePriceDecimalAdjustment: BigNumber;

  let tradeModule: TradeModule;
  let uniswapV3ExchangeAdapter: UniswapV3ExchangeAdapterV2;
  let leverageStrategyExtension: DeltaNeutralBasisTradingStrategyExtension;
  let perpBasisTradingModule: PerpV2BasisTradingModule;
  let positionLib: PositionV2;
  let perpLib: PerpV2LibraryV2;
  let perpPositionsLib: PerpV2Positions;
  let issuanceModule: SlippageIssuanceModule;
  let baseManager: BaseManager;

  let perpV2PriceFeedMock: PerpV2PriceFeedMock;
  let spotAsset: WETH9;

  cacheBeforeEach(async () => {
    [
      owner,
      methodologist,
      maker,
      taker
    ] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);

    systemSetup = getSystemFixture(owner.address);
    await systemSetup.initialize();
    uniV3Setup = getUniswapV3Fixture(owner.address);
    await uniV3Setup.initialize(
      owner,
      systemSetup.weth,
      1000,
      systemSetup.wbtc,
      60000,
      systemSetup.dai
    );
    perpV2Setup = getPerpV2Fixture(owner.address);
    await perpV2Setup.initialize(maker, taker);

    // set funding rate to zero; allows us to avoid calculating small amounts of funding
    // accrued in our test cases
    await perpV2Setup.clearingHouseConfig.setMaxFundingRate(ZERO);

    await perpV2Setup.usdc.mint(perpV2Setup.maker.address, usdc(500000000000));
    await perpV2Setup.deposit(perpV2Setup.maker, BigNumber.from(500000000000), perpV2Setup.usdc);

    // Create PerpV2 liquidity
    await perpV2Setup.setBaseTokenOraclePrice(perpV2Setup.vETH, usdc(1000));
    await perpV2Setup.initializePoolWithLiquidityWide(
      perpV2Setup.vETH,
      ether(1000000000),
      ether(1000000000000)
    );

    await perpV2Setup.setBaseTokenOraclePrice(perpV2Setup.vBTC, BigNumber.from(60000));
    await perpV2Setup.initializePoolWithLiquidityWide(
      perpV2Setup.vBTC,
      ether(10000),
      ether(600000)
    );

    // Create Dex liquidity
    await systemSetup.weth.connect(owner.wallet).approve(uniV3Setup.nftPositionManager.address, ether(1000));
    await perpV2Setup.usdc.connect(owner.wallet).approve(uniV3Setup.nftPositionManager.address, usdc(1000_000));
    await uniV3Setup.createNewPair(systemSetup.weth, perpV2Setup.usdc, 3000, 1000);
    await uniV3Setup.addLiquidityWide(
      systemSetup.weth,
      perpV2Setup.usdc,
      3000,   // 0.3%
      ether(1000),
      usdc(1000_000),
      owner.address
    );

    issuanceModule = await deployer.setDeployer.modules.deploySlippageIssuanceModule(
      systemSetup.controller.address
    );

    tradeModule = await deployer.setDeployer.modules.deployTradeModule(
      systemSetup.controller.address
    );

    positionLib = await deployer.setDeployer.libraries.deployPositionV2();
    perpLib = await deployer.setDeployer.libraries.deployPerpV2LibraryV2();
    perpPositionsLib = await deployer.setDeployer.libraries.deployPerpV2Positions();

    perpBasisTradingModule = await deployer.setDeployer.modules.deployPerpV2BasisTradingModule(
      systemSetup.controller.address,
      perpV2Setup.vault.address,
      perpV2Setup.quoter.address,
      perpV2Setup.marketRegistry.address,
      TWO,
      "contracts/protocol/lib/PositionV2.sol:PositionV2",
      positionLib.address,
      "contracts/protocol/integration/lib/PerpV2LibraryV2.sol:PerpV2LibraryV2",
      perpLib.address,
      "contracts/protocol/integration/lib/PerpV2Positions.sol:PerpV2Positions",
      perpPositionsLib.address
    );

    uniswapV3ExchangeAdapter = await deployer.setDeployer.adapters.deployUniswapV3ExchangeAdapterV2(uniV3Setup.swapRouter.address);

    await systemSetup.controller.addModule(tradeModule.address);
    await systemSetup.controller.addModule(issuanceModule.address);
    await systemSetup.controller.addModule(perpBasisTradingModule.address);

    await systemSetup.integrationRegistry.addIntegration(
      perpBasisTradingModule.address,
      "DefaultIssuanceModule",
      issuanceModule.address
    );

    await systemSetup.integrationRegistry.addIntegration(
      tradeModule.address,
      "UNISWAPV3",
      uniswapV3ExchangeAdapter.address
    );

    // Deploy Chainlink mocks
    perpV2PriceFeedMock = await deployer.mocks.deployPerpV2PriceFeedMock(8);
    await perpV2PriceFeedMock.setPrice(BigNumber.from(1000).mul(10 ** 8));
  });

  const initializeRootScopeContracts = async () => {
    setToken = await systemSetup.createSetToken(
      [perpV2Setup.usdc.address],
      [usdc(100)],
      [
        systemSetup.streamingFeeModule.address,
        perpBasisTradingModule.address,
        issuanceModule.address,
        tradeModule.address
      ]
    );
    await perpBasisTradingModule.updateAnySetAllowed(true);

    // Initialize modules
    await issuanceModule.initialize(setToken.address, ether(1), ZERO, ZERO, owner.address, ADDRESS_ZERO);
    const streamingFeeSettings = {
      feeRecipient: owner.address,
      maxStreamingFeePercentage: ether(.1),
      streamingFeePercentage: ether(.02),
      lastStreamingFeeTimestamp: ZERO,
    };
    await systemSetup.streamingFeeModule.initialize(setToken.address, streamingFeeSettings);
    await perpBasisTradingModule["initialize(address,(address,uint256,uint256))"](
      setToken.address,
      {
        feeRecipient: owner.address,
        maxPerformanceFeePercentage: ether(.2),
        performanceFeePercentage: ether(.1)
      }
    );
    await tradeModule.connect(owner.wallet).initialize(setToken.address);

    baseManager = await deployer.manager.deployBaseManager(
      setToken.address,
      owner.address,
      methodologist.address,
    );

    // Transfer ownership to base manager
    if ((await setToken.manager()) == owner.address) {
      await setToken.connect(owner.wallet).setManager(baseManager.address);
    }

    spotAsset = systemSetup.weth;

    // Deploy adapter
    const vBaseAssetDecimals = await perpV2Setup.vETH.decimals();
    const priceFeedDecimals = await perpV2PriceFeedMock.decimals();
    basePriceDecimalAdjustment = BigNumber.from(vBaseAssetDecimals).sub(priceFeedDecimals);

    const targetLeverageRatio = customTargetLeverageRatio || ether(-1);
    const minLeverageRatio = customMinLeverageRatio || ether(-0.9);
    const maxLeverageRatio = ether(-1.1);
    const recenteringSpeed = ether(0.05);
    const rebalanceInterval = ONE_DAY_IN_SECONDS;
    const reinvestInterval = ONE_DAY_IN_SECONDS.mul(7);

    const exchangeName = "UNISWAPV3";
    const buyExactSpotTradeData = await uniswapV3ExchangeAdapter.generateDataParam(
      [systemSetup.weth.address, perpV2Setup.usdc.address], // exactOutput paths are reversed in Uniswap V3
      [3000],
      false
    );
    const sellExactSpotTradeData = await uniswapV3ExchangeAdapter.generateDataParam(
      [systemSetup.weth.address, perpV2Setup.usdc.address],
      [3000],
      true
    );
    const buySpotQuoteExactInputPath = solidityPack(
      ["address", "uint24", "address"],
      [perpV2Setup.usdc.address, BigNumber.from(3000), systemSetup.weth.address]
    );
    const twapMaxTradeSize = ether(20);
    const twapCooldownPeriod = BigNumber.from(3000);
    const slippageTolerance = ether(0.15);

    const incentivizedTwapMaxTradeSize = ether(25);
    const incentivizedTwapCooldownPeriod = BigNumber.from(60);
    const incentivizedSlippageTolerance = ether(0.15);
    const etherReward = ether(1);
    const incentivizedLeverageRatio = ether(-1.3);

    strategy = {
      setToken: setToken.address,
      basisTradingModule: perpBasisTradingModule.address,
      tradeModule: tradeModule.address,
      quoter: uniV3Setup.quoter.address,
      perpV2AccountBalance: perpV2Setup.accountBalance.address,
      baseUSDPriceOracle: perpV2PriceFeedMock.address,
      twapInterval: ZERO,
      basePriceDecimalAdjustment: basePriceDecimalAdjustment,
      virtualBaseAddress: perpV2Setup.vETH.address,
      virtualQuoteAddress: perpV2Setup.vQuote.address,
      spotAssetAddress: systemSetup.weth.address
    };
    methodology = {
      targetLeverageRatio: targetLeverageRatio,
      minLeverageRatio: minLeverageRatio,
      maxLeverageRatio: maxLeverageRatio,
      recenteringSpeed: recenteringSpeed,
      rebalanceInterval: rebalanceInterval,
      reinvestInterval: reinvestInterval
    };
    execution = {
      twapCooldownPeriod: twapCooldownPeriod,
      slippageTolerance: slippageTolerance,
    };
    incentive = {
      incentivizedTwapCooldownPeriod: incentivizedTwapCooldownPeriod,
      incentivizedSlippageTolerance: incentivizedSlippageTolerance,
      etherReward: etherReward,
      incentivizedLeverageRatio: incentivizedLeverageRatio,
    };
    exchange = {
      exchangeName: exchangeName,
      buyExactSpotTradeData: buyExactSpotTradeData,
      sellExactSpotTradeData: sellExactSpotTradeData,
      buySpotQuoteExactInputPath: buySpotQuoteExactInputPath,
      twapMaxTradeSize: twapMaxTradeSize,
      incentivizedTwapMaxTradeSize: incentivizedTwapMaxTradeSize,
    };

    leverageStrategyExtension = await deployer.extensions.deployDeltaNeutralBasisTradingStrategyExtension(
      baseManager.address,
      strategy,
      methodology,
      execution,
      incentive,
      exchange
    );

    // Add adapter
    await baseManager.connect(owner.wallet).addAdapter(leverageStrategyExtension.address);

    await perpV2Setup.usdc.approve(issuanceModule.address, usdc(10000));
    await issuanceModule.connect(owner.wallet).issue(setToken.address, ether(100), owner.address);

    // Make owner an approved caller
    await leverageStrategyExtension.updateCallerStatus([owner.wallet.address], [true]);
  };

  describe("#constructor", async () => {
    let subjectManagerAddress: Address;
    let subjectContractSettings: PerpV2BasisContractSettings;
    let subjectPerpV2MethodologySettings: PerpV2BasisMethodologySettings;
    let subjectExecutionSettings: PerpV2BasisExecutionSettings;
    let subjectIncentiveSettings: PerpV2BasisIncentiveSettings;
    let subjectPerpV2BasisExchangeSettings: PerpV2BasisExchangeSettings;

    cacheBeforeEach(initializeRootScopeContracts);

    beforeEach(async () => {
      subjectManagerAddress = baseManager.address;
      subjectContractSettings = {
        setToken: setToken.address,
        tradeModule: tradeModule.address,
        quoter: uniV3Setup.quoter.address,
        basisTradingModule: perpBasisTradingModule.address,
        perpV2AccountBalance: perpV2Setup.accountBalance.address,
        baseUSDPriceOracle: perpV2PriceFeedMock.address,
        twapInterval: ZERO,
        basePriceDecimalAdjustment: basePriceDecimalAdjustment,
        virtualBaseAddress: perpV2Setup.vETH.address,
        virtualQuoteAddress: perpV2Setup.vQuote.address,
        spotAssetAddress: systemSetup.weth.address
      };
      subjectPerpV2MethodologySettings = {
        targetLeverageRatio: ether(-1),
        minLeverageRatio: ether(-0.7),
        maxLeverageRatio: ether(-1.3),
        recenteringSpeed: ether(0.05),
        rebalanceInterval: BigNumber.from(86400),
        reinvestInterval: ONE_DAY_IN_SECONDS.mul(7)
      };
      subjectExecutionSettings = {
        twapCooldownPeriod: BigNumber.from(120),
        slippageTolerance: ether(0.01),
      };
      subjectIncentiveSettings = {
        incentivizedTwapCooldownPeriod: BigNumber.from(60),
        incentivizedSlippageTolerance: ether(0.05),
        etherReward: ether(1),
        incentivizedLeverageRatio: ether(-2),
      };
      subjectPerpV2BasisExchangeSettings = {
        exchangeName: "UNISWAPV3",
        buyExactSpotTradeData: await uniswapV3ExchangeAdapter.generateDataParam(
          [systemSetup.weth.address, perpV2Setup.usdc.address], // reversed
          [3000],
          false
        ),
        sellExactSpotTradeData: await uniswapV3ExchangeAdapter.generateDataParam(
          [systemSetup.weth.address, perpV2Setup.usdc.address],
          [3000],
          true
        ),
        buySpotQuoteExactInputPath: solidityPack(
          ["address", "uint24", "address"],
          [perpV2Setup.usdc.address, BigNumber.from(3000), systemSetup.weth.address]
        ),
        twapMaxTradeSize: ether(5),
        incentivizedTwapMaxTradeSize: ether(10),
      };
    });

    async function subject(): Promise<DeltaNeutralBasisTradingStrategyExtension> {
      return await deployer.extensions.deployDeltaNeutralBasisTradingStrategyExtension(
        subjectManagerAddress,
        subjectContractSettings,
        subjectPerpV2MethodologySettings,
        subjectExecutionSettings,
        subjectIncentiveSettings,
        subjectPerpV2BasisExchangeSettings
      );
    }

    it("should set the manager address", async () => {
      const retrievedAdapter = await subject();

      const manager = await retrievedAdapter.manager();

      expect(manager).to.eq(subjectManagerAddress);
    });

    it("should set the contract addresses", async () => {
      const retrievedAdapter = await subject();
      const strategy: PerpV2BasisContractSettings = await retrievedAdapter.getStrategy();

      expect(strategy.setToken).to.eq(subjectContractSettings.setToken);
      expect(strategy.tradeModule).to.eq(subjectContractSettings.tradeModule);
      expect(strategy.basisTradingModule).to.eq(subjectContractSettings.basisTradingModule);
      expect(strategy.perpV2AccountBalance).to.eq(subjectContractSettings.perpV2AccountBalance);
      expect(strategy.baseUSDPriceOracle).to.eq(subjectContractSettings.baseUSDPriceOracle);
      expect(strategy.twapInterval).to.eq(subjectContractSettings.twapInterval);
      expect(strategy.basePriceDecimalAdjustment).to.eq(subjectContractSettings.basePriceDecimalAdjustment);
      expect(strategy.virtualBaseAddress).to.eq(subjectContractSettings.virtualBaseAddress);
      expect(strategy.virtualQuoteAddress).to.eq(subjectContractSettings.virtualQuoteAddress);
      expect(strategy.spotAssetAddress).to.eq(subjectContractSettings.spotAssetAddress);
    });

    it("should set the correct methodology parameters", async () => {
      const retrievedAdapter = await subject();
      const methodology = await retrievedAdapter.getMethodology();

      expect(methodology.targetLeverageRatio).to.eq(subjectPerpV2MethodologySettings.targetLeverageRatio);
      expect(methodology.minLeverageRatio).to.eq(subjectPerpV2MethodologySettings.minLeverageRatio);
      expect(methodology.maxLeverageRatio).to.eq(subjectPerpV2MethodologySettings.maxLeverageRatio);
      expect(methodology.recenteringSpeed).to.eq(subjectPerpV2MethodologySettings.recenteringSpeed);
      expect(methodology.rebalanceInterval).to.eq(subjectPerpV2MethodologySettings.rebalanceInterval);
      expect(methodology.reinvestInterval).to.eq(subjectPerpV2MethodologySettings.reinvestInterval);
    });

    it("should set the correct execution parameters", async () => {
      const retrievedAdapter = await subject();
      const execution = await retrievedAdapter.getExecution();

      expect(execution.twapCooldownPeriod).to.eq(subjectExecutionSettings.twapCooldownPeriod);
      expect(execution.slippageTolerance).to.eq(subjectExecutionSettings.slippageTolerance);
    });

    it("should set the correct incentive parameters", async () => {
      const retrievedAdapter = await subject();
      const incentive = await retrievedAdapter.getIncentive();

      expect(incentive.incentivizedTwapCooldownPeriod).to.eq(subjectIncentiveSettings.incentivizedTwapCooldownPeriod);
      expect(incentive.incentivizedSlippageTolerance).to.eq(subjectIncentiveSettings.incentivizedSlippageTolerance);
      expect(incentive.etherReward).to.eq(subjectIncentiveSettings.etherReward);
      expect(incentive.incentivizedLeverageRatio).to.eq(subjectIncentiveSettings.incentivizedLeverageRatio);
    });

    it("should set the correct exchange settings for the initial exchange", async () => {
      const retrievedAdapter = await subject();
      const exchange = await retrievedAdapter.getExchangeSettings();

      expect(exchange.exchangeName).to.eq(subjectPerpV2BasisExchangeSettings.exchangeName);
      expect(exchange.buyExactSpotTradeData).to.eq(subjectPerpV2BasisExchangeSettings.buyExactSpotTradeData);
      expect(exchange.twapMaxTradeSize).to.eq(subjectPerpV2BasisExchangeSettings.twapMaxTradeSize);
      expect(exchange.incentivizedTwapMaxTradeSize).to.eq(subjectPerpV2BasisExchangeSettings.incentivizedTwapMaxTradeSize);
    });

    describe("when min leverage ratio is 0", async () => {
      beforeEach(async () => {
        subjectPerpV2MethodologySettings.minLeverageRatio = ZERO;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be valid min leverage");
      });
    });

    describe("when min leverage ratio is positive", async () => {
      beforeEach(async () => {
        subjectPerpV2MethodologySettings.minLeverageRatio = ether(0.7);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be valid min leverage");
      });
    });

    describe("when max leverage ratio is positive", async () => {
      beforeEach(async () => {
        subjectPerpV2MethodologySettings.maxLeverageRatio = ether(1.3);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be valid max leverage");
      });
    });

    describe("when target leverage ratio is positive", async () => {
      beforeEach(async () => {
        subjectPerpV2MethodologySettings.targetLeverageRatio = ether(1);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be valid target leverage");
      });
    });

    describe("when min leverage ratio is above target", async () => {
      beforeEach(async () => {
        subjectPerpV2MethodologySettings.minLeverageRatio = ether(-1.1);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be valid min leverage");
      });
    });

    describe("when max leverage ratio is below target", async () => {
      beforeEach(async () => {
        subjectPerpV2MethodologySettings.maxLeverageRatio = ether(-0.9);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be valid max leverage");
      });
    });

    describe("when recentering speed is >100%", async () => {
      beforeEach(async () => {
        subjectPerpV2MethodologySettings.recenteringSpeed = ether(1.1);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be valid recentering speed");
      });
    });

    describe("when recentering speed is 0%", async () => {
      beforeEach(async () => {
        subjectPerpV2MethodologySettings.recenteringSpeed = ZERO;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be valid recentering speed");
      });
    });

    describe("when slippage tolerance is >100%", async () => {
      beforeEach(async () => {
        subjectExecutionSettings.slippageTolerance = ether(1.1);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Slippage tolerance must be <100%");
      });
    });

    describe("when incentivized slippage tolerance is >100%", async () => {
      beforeEach(async () => {
        subjectIncentiveSettings.incentivizedSlippageTolerance = ether(1.1);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Incentivized slippage tolerance must be <100%");
      });
    });

    describe("when incentivized leverage ratio is positive", async () => {
      beforeEach(async () => {
        subjectIncentiveSettings.incentivizedLeverageRatio = ether(2);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be valid incentivized leverage ratio");
      });
    });

    describe("when incentivize leverage ratio is less than max leverage ratio", async () => {
      beforeEach(async () => {
        subjectIncentiveSettings.incentivizedLeverageRatio = ether(-1.2);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Incentivized leverage ratio must be > max leverage ratio");
      });
    });

    describe("when rebalance interval is shorter than TWAP cooldown period", async () => {
      beforeEach(async () => {
        subjectPerpV2MethodologySettings.rebalanceInterval = ZERO;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Rebalance interval must be greater than TWAP cooldown period");
      });
    });

    describe("when TWAP cooldown period is shorter than incentivized TWAP cooldown period", async () => {
      beforeEach(async () => {
        subjectExecutionSettings.twapCooldownPeriod = ZERO;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("TWAP cooldown must be greater than incentivized TWAP cooldown");
      });
    });

    describe("when an exchange has a twapMaxTradeSize of 0", async () => {
      beforeEach(async () => {
        subjectPerpV2BasisExchangeSettings.twapMaxTradeSize = ZERO;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Max TWAP trade size must not be 0");
      });
    });
  });

  context("SetToken has been issued", async () => {

    cacheBeforeEach(initializeRootScopeContracts);

    describe("#deposit", async () => {
      let subjectCaller: Account;
      let subjectCollateralUnits: BigNumber;

      beforeEach(async () => {
        const collateralUnits = await setToken.getDefaultPositionRealUnit(perpV2Setup.usdc.address);

        subjectCaller = owner;
        subjectCollateralUnits = collateralUnits;
      });

      async function subject(): Promise<ContractTransaction> {
        return await leverageStrategyExtension.connect(subjectCaller.wallet).deposit(subjectCollateralUnits);
      }

      it("should deposit assets USDC into Perpetual Protocol", async () => {
        const preUsdcDefaultUnit = await setToken.getDefaultPositionRealUnit(perpV2Setup.usdc.address);

        await subject();

        const postUsdcDefaultUnit = await setToken.getDefaultPositionRealUnit(perpV2Setup.usdc.address);
        const postUsdcExternalUnit = await setToken.getExternalPositionRealUnit(perpV2Setup.usdc.address, perpBasisTradingModule.address);

        expect(postUsdcExternalUnit).to.eq(preUsdcDefaultUnit);
        expect(postUsdcDefaultUnit).to.eq(ZERO);
      });
    });

    describe("#withdraw", async () => {
      let subjectCaller: Account;
      let subjectCollateralUnits: BigNumber;

      beforeEach(async () => {
        const depositUnits = await setToken.getDefaultPositionRealUnit(perpV2Setup.usdc.address);
        await leverageStrategyExtension.deposit(depositUnits);

        const totalSupply = await setToken.totalSupply();
        const collateralAmount = await perpV2Setup.vault.getBalance(setToken.address);
        const collateralUnits = preciseDiv(collateralAmount, totalSupply);

        subjectCaller = owner;
        subjectCollateralUnits = collateralUnits;
      });

      async function subject(): Promise<ContractTransaction> {
        return await leverageStrategyExtension.connect(subjectCaller.wallet).withdraw(subjectCollateralUnits);
      }

      it("should withdraw USDC from Perpetual Protocol", async () => {
        const preUsdcBalance = await perpV2Setup.vault.getBalance(setToken.address);

        await subject();

        const postUsdcExternalUnit = await setToken.getExternalPositionRealUnit(perpV2Setup.usdc.address, perpBasisTradingModule.address);
        const postUsdcDefaultUnit = await setToken.getDefaultPositionRealUnit(perpV2Setup.usdc.address);

        const totalSupply = await setToken.totalSupply();
        const expectedPostUsdcDefaultUnit = preciseDiv(preUsdcBalance, totalSupply);

        expect(postUsdcDefaultUnit).to.eq(expectedPostUsdcDefaultUnit);
        expect(postUsdcExternalUnit).to.eq(ZERO);
      });
    });

    describe("#engage", async () => {
      let subjectCaller: Account;

      beforeEach(async () => {
        subjectCaller = owner;
      });

      async function subject(): Promise<any> {
        return leverageStrategyExtension.connect(subjectCaller.wallet).engage();
      }

      // todo: make sure this is exactly equivalent to how it is done on the contract.
      // helps to remove closeTo.
      async function getTotalEngageRebalanceNotional(_setToken: SetToken): Promise<BigNumber> {
        const collateralBalanceToBeUsedForOpeningPerpPosition = (await perpV2Setup.usdc.balanceOf(_setToken.address))
          .div(2).mul(BigNumber.from(10).pow(18 - 6));
        const targetLeverageRatio = (await leverageStrategyExtension.getMethodology()).targetLeverageRatio;
        const basePrice = (await perpV2Setup.ethPriceFeed.latestAnswer()).div(usdc(1));
        // console.log((await perpV2Setup.ethPriceFeed.latestAnswer()).toString());
        // console.log((await perpV2Setup.usdc.decimals()).toString());
        const totalRebalanceNotional = preciseMul(collateralBalanceToBeUsedForOpeningPerpPosition, targetLeverageRatio).div(basePrice);
        return totalRebalanceNotional;
      }

      context("when rebalance notional is less than max trade size", async () => {
        it("should trade USDC for spot asset on UniswapV3 and deposit the rest to Perpetual protocol", async () => {
          const initialPositions = await setToken.getPositions();

          // Determine expected spot asset unit
          const totalSupply = await setToken.totalSupply();
          const totalRebalanceNotional = await getTotalEngageRebalanceNotional(setToken);
          const expectedSpotAssetUnit = preciseDiv(totalRebalanceNotional.abs(), totalSupply);
          console.log(totalRebalanceNotional.toString());
          // Determine expected USDC unit
          const usdcBalanceBefore = await perpV2Setup.usdc.balanceOf(setToken.address);
          const amountIn = await uniV3Setup.quoter.callStatic.quoteExactOutputSingle(
            perpV2Setup.usdc.address,
            systemSetup.weth.address,
            3000,
            totalRebalanceNotional.abs(),
            0
          );
          console.log(amountIn.toString());
          const expectedUsdcDeposited = usdcBalanceBefore.sub(amountIn);

          await subject();

          const finalPositions = await setToken.getPositions();
          const currentUsdcBalanceInPerp = await perpV2Setup.vault.getBalance(setToken.address);
          console.log(currentUsdcBalanceInPerp.toString());

          // One default USDC position before engage
          expect(initialPositions.length).to.eq(1);
          expect(initialPositions[0].component).to.eq(perpV2Setup.usdc.address);
          expect(initialPositions[0].positionState).to.eq(ZERO);    // Deafult

          // One default WETH position and one external USDC position after engage
          expect(finalPositions.length).to.eq(2);
          expect(finalPositions[0].component).to.eq(systemSetup.weth.address);
          expect(finalPositions[0].positionState).to.eq(ZERO);    // Deafult
          expect(finalPositions[0].unit).to.eq(expectedSpotAssetUnit);

          // Verify deposit
          expect(currentUsdcBalanceInPerp).to.closeTo(expectedUsdcDeposited, 100); // occours due to dust amounts
        });

        it("should open a base token position on Perpetual Protocol", async () => {
          const initialPositions = await perpBasisTradingModule.getPositionNotionalInfo(setToken.address);
          const totalRebalanceNotional = await getTotalEngageRebalanceNotional(setToken);

          await subject();

          const finalPositions = await perpBasisTradingModule.getPositionNotionalInfo(setToken.address);

          expect(initialPositions.length).to.eq(0);
          expect(finalPositions.length).to.eq(1);
          expect(finalPositions[0].baseBalance).to.eq(totalRebalanceNotional);
          expect(finalPositions[0].baseToken).to.eq(strategy.virtualBaseAddress);
        });

        it("should NOT set the TWAP leverage ratio", async () => {
          await subject();

          const twapLeverageRatio = await leverageStrategyExtension.twapLeverageRatio();

          expect(twapLeverageRatio).to.eq(ZERO);
        });

        it("should emit Engaged event", async () => {
          const totalRebalanceNotional = await getTotalEngageRebalanceNotional(setToken);
          await expect(subject()).to.emit(leverageStrategyExtension, "Engaged").withArgs(
            ZERO,
            methodology.targetLeverageRatio,
            totalRebalanceNotional,
            totalRebalanceNotional,
          );
        });
      });

      context("when rebalance notional is greater than max trade size", async () => {
        let newExchangeSettings: PerpV2BasisExchangeSettings;

        beforeEach(async () => {
          newExchangeSettings = {
            exchangeName: exchange.exchangeName,
            buyExactSpotTradeData: exchange.buyExactSpotTradeData,
            sellExactSpotTradeData: exchange.sellExactSpotTradeData,
            buySpotQuoteExactInputPath: exchange.buySpotQuoteExactInputPath,
            twapMaxTradeSize: ether(1),
            incentivizedTwapMaxTradeSize: ether(1),
          };
          await leverageStrategyExtension.setExchangeSettings(newExchangeSettings);
        });

        it("should set the last trade timestamp", async () => {
          await subject();

          const lastTradeTimestamp = await leverageStrategyExtension.lastTradeTimestamp();

          expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
        });

        it("should set the TWAP leverage ratio", async () => {
          await subject();

          const twapLeverageRatio = await leverageStrategyExtension.twapLeverageRatio();

          expect(twapLeverageRatio).to.eq(methodology.targetLeverageRatio);
        });

        it("should trade USDC for spot asset on UniswapV3 and deposit the rest to Perpetual protocol", async () => {
          const initialPositions = await setToken.getPositions();

          // Determine expected spot asset unit
          const totalSupply = await setToken.totalSupply();
          const totalRebalanceNotional = newExchangeSettings.twapMaxTradeSize.mul(-1);
          const expectedSpotAssetUnit = preciseDiv(totalRebalanceNotional.abs(), totalSupply);
          console.log(totalRebalanceNotional.toString());
          // Determine expected USDC unit
          const usdcBalanceBefore = await perpV2Setup.usdc.balanceOf(setToken.address);
          const amountIn = await uniV3Setup.quoter.callStatic.quoteExactOutputSingle(
            perpV2Setup.usdc.address,
            systemSetup.weth.address,
            3000,
            totalRebalanceNotional.abs(),
            0
          );
          console.log(amountIn.toString());
          const expectedUsdcDeposited = usdcBalanceBefore.sub(amountIn);

          await subject();

          const finalPositions = await setToken.getPositions();
          const currentUsdcBalanceInPerp = await perpV2Setup.vault.getBalance(setToken.address);
          console.log(currentUsdcBalanceInPerp.toString());

          // One default USDC position before engage
          expect(initialPositions.length).to.eq(1);
          expect(initialPositions[0].component).to.eq(perpV2Setup.usdc.address);
          expect(initialPositions[0].positionState).to.eq(ZERO);    // Deafult

          // One default WETH position and one external USDC position after engage
          expect(finalPositions.length).to.eq(2);
          expect(finalPositions[0].component).to.eq(systemSetup.weth.address);
          expect(finalPositions[0].positionState).to.eq(ZERO);    // Deafult
          expect(finalPositions[0].unit).to.eq(expectedSpotAssetUnit);

          // Verify deposit
          expect(currentUsdcBalanceInPerp).to.closeTo(expectedUsdcDeposited, 100); // occours due to dust amounts
        });

        it("should open a base token position on Perpetual Protocol", async () => {
          const initialPositions = await perpBasisTradingModule.getPositionNotionalInfo(setToken.address);
          const totalRebalanceNotional = newExchangeSettings.twapMaxTradeSize.mul(-1);

          await subject();

          const finalPositions = await perpBasisTradingModule.getPositionNotionalInfo(setToken.address);

          expect(initialPositions.length).to.eq(0);
          expect(finalPositions.length).to.eq(1);
          expect(finalPositions[0].baseBalance).to.eq(totalRebalanceNotional);
          expect(finalPositions[0].baseToken).to.eq(strategy.virtualBaseAddress);
        });

        it("should emit Engaged event", async () => {
          const chunkRebalanceNotional = newExchangeSettings.twapMaxTradeSize.mul(-1);
          const totalRebalanceNotional = await getTotalEngageRebalanceNotional(setToken);

          await expect(subject()).to.emit(leverageStrategyExtension, "Engaged").withArgs(
            ZERO,
            methodology.targetLeverageRatio,
            chunkRebalanceNotional,
            totalRebalanceNotional,
          );
        });

        describe("when base token position already exists", async () => {
          beforeEach(async () => {
            await subject();
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Base position must NOT exist");
          });
        });

        describe("when the caller is not the operator", async () => {
          beforeEach(async () => {
            subjectCaller = await getRandomAccount();
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Must be operator");
          });
        });
      });

      describe.skip("when collateral balance is zero", async () => {
        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Collateral balance must be > 0");
        });
      });
    });

    describe("#rebalance", async () => {
      let subjectCaller: Account;

      beforeEach(async () => {
        subjectCaller = owner;
      });

      async function subject(): Promise<any> {
        return leverageStrategyExtension.connect(subjectCaller.wallet).rebalance();
      }

      describe("when engaged", async () => {
        cacheBeforeEach(async () => {
          // Engage short position
          await leverageStrategyExtension.engage();
          const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();
          console.log(currentLeverageRatio.toString());
        });

        describe("when current leverage ratio is below target (lever), does not need a TWAP, and is inside bounds", async () => {
          cacheBeforeEach(async () => {
            await perpV2Setup.setBaseTokenOraclePrice(perpV2Setup.vETH, usdc(950));
            await perpV2PriceFeedMock.setPrice(BigNumber.from(950).mul(10 ** 8));

            await increaseTimeAsync(ONE_DAY_IN_SECONDS);
          });

          it("should verify initial leverage conditions", async () => {
            const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();
            console.log(currentLeverageRatio.toString());
            expect(currentLeverageRatio.abs()).to.be.gt(methodology.minLeverageRatio.abs());
            expect(currentLeverageRatio.abs()).to.be.lt(methodology.targetLeverageRatio.abs());
          });

          it("should set the global last trade timestamp", async () => {
            await subject();

            const lastTradeTimestamp = await leverageStrategyExtension.lastTradeTimestamp();

            expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
          });

          it("should not set the TWAP leverage ratio", async () => {
            await subject();

            const twapLeverageRatio = await leverageStrategyExtension.twapLeverageRatio();

            expect(twapLeverageRatio).to.eq(ZERO);
          });

          it.skip("should update the baseToken position (PerpV2) on the SetToken correctly", async () => {
            const initialPositions = await perpBasisTradingModule.getPositionNotionalInfo(setToken.address);
            const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();

            const expectedNewLeverageRatio = calculateNewLeverageRatioPerpV2Basis(
              currentLeverageRatio,
              methodology
            );

            const newPositions = await perpBasisTradingModule.getPositionUnitInfo(setToken.address);
            const updatedPosition = newPositions[0];

            const totalRebalanceNotional = preciseDiv(
              preciseMul(initialPositions[0].baseBalance, expectedNewLeverageRatio.sub(currentLeverageRatio)),    // numerator
              preciseMul(currentLeverageRatio, ether(1).sub(expectedNewLeverageRatio))                            // denominator
            );

            const totalSupply = await setToken.totalSupply();
            const expectedNewPositionUnit = preciseDiv(initialPositions[0].baseBalance.add(totalRebalanceNotional), totalSupply);

            expect(initialPositions.length).to.eq(1);
            expect(newPositions.length).to.eq(1);
            expect(updatedPosition.baseToken).to.eq(perpV2Setup.vETH.address);
            expect(updatedPosition.baseUnit).to.eq(expectedNewPositionUnit);
          });

          it("should update the spot asset positoin unit on the SetToken correctly", async () => {
            const initialPositions = await perpBasisTradingModule.getPositionNotionalInfo(setToken.address);
            const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();

            const expectedNewLeverageRatio = calculateNewLeverageRatioPerpV2Basis(
              currentLeverageRatio,
              methodology
            );
            const spotAssetUnitBefore = await setToken.getDefaultPositionRealUnit(spotAsset.address);
            const totalSupply = await setToken.totalSupply();

            await subject();

            const totalRebalanceNotional = preciseDiv(
              preciseMul(initialPositions[0].baseBalance, expectedNewLeverageRatio.sub(currentLeverageRatio)),    // numerator
              preciseMul(currentLeverageRatio, ether(1).sub(expectedNewLeverageRatio))                            // denominator
            );

            const expectedNewPositionUnit = preciseDiv(
              preciseMul(spotAssetUnitBefore, totalSupply).add(totalRebalanceNotional.abs()),
              totalSupply
            );
            const actualNewPositionUnit = await setToken.getDefaultPositionRealUnit(spotAsset.address);

            expect(actualNewPositionUnit).to.eq(expectedNewPositionUnit);
          });

          it("should emit Rebalanced event", async () => {
            const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();
            const expectedNewLeverageRatio = calculateNewLeverageRatioPerpV2Basis(
              currentLeverageRatio,
              methodology
            );

            const initialPositions = await perpBasisTradingModule.getPositionNotionalInfo(setToken.address);
            const totalRebalanceNotional = preciseDiv(
              preciseMul(initialPositions[0].baseBalance, expectedNewLeverageRatio.sub(currentLeverageRatio)),    // numerator
              preciseMul(currentLeverageRatio, ether(1).sub(expectedNewLeverageRatio))                            // denominator
            );
            await expect(subject()).to.emit(leverageStrategyExtension, "Rebalanced").withArgs(
              currentLeverageRatio,
              expectedNewLeverageRatio,
              totalRebalanceNotional,
              totalRebalanceNotional,
            );
          });
        });

        describe("when rebalance interval has not elapsed but is below min leverage ratio and lower than max trade size", async () => {
          beforeEach(async () => {
            await perpV2Setup.setBaseTokenOraclePrice(perpV2Setup.vETH, usdc(900));
            await perpV2PriceFeedMock.setPrice(BigNumber.from(900).mul(10 ** 8));
          });

          it("should verify initial leverage conditions", async () => {
            const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();
            console.log(currentLeverageRatio.toString());
            expect(currentLeverageRatio.abs()).to.be.lt(methodology.minLeverageRatio.abs());
          });

          it("should set the last trade timestamp", async () => {
            await subject();

            const lastTradeTimestamp = await leverageStrategyExtension.lastTradeTimestamp();

            expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
          });

          it("should not set the TWAP leverage ratio", async () => {
            await subject();

            const twapLeverageRatio = await leverageStrategyExtension.twapLeverageRatio();

            expect(twapLeverageRatio).to.eq(ZERO);
          });

          it("should update the baseToken position (PerpV2) on the SetToken correctly", async () => {
            const initialPositions = await perpBasisTradingModule.getPositionNotionalInfo(setToken.address);
            const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();

            const expectedNewLeverageRatio = calculateNewLeverageRatioPerpV2Basis(
              currentLeverageRatio,
              methodology
            );

            await subject();

            const newPositions = await perpBasisTradingModule.getPositionUnitInfo(setToken.address);
            const updatedPosition = newPositions[0];

            const totalRebalanceNotional = preciseDiv(
              preciseMul(initialPositions[0].baseBalance, expectedNewLeverageRatio.sub(currentLeverageRatio)),    // numerator
              preciseMul(currentLeverageRatio, ether(1).sub(expectedNewLeverageRatio))                            // denominator
            );

            const totalSupply = await setToken.totalSupply();
            const expectedNewPositionUnit = preciseDiv(initialPositions[0].baseBalance.add(totalRebalanceNotional), totalSupply);

            expect(initialPositions.length).to.eq(1);
            expect(newPositions.length).to.eq(1);
            expect(updatedPosition.baseToken).to.eq(perpV2Setup.vETH.address);
            expect(updatedPosition.baseUnit).to.eq(expectedNewPositionUnit);
          });

          it("should update the spot asset position unit on the SetToken correctly", async () => {
            const initialPositions = await perpBasisTradingModule.getPositionNotionalInfo(setToken.address);
            const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();

            const expectedNewLeverageRatio = calculateNewLeverageRatioPerpV2Basis(
              currentLeverageRatio,
              methodology
            );
            const spotAssetUnitBefore = await setToken.getDefaultPositionRealUnit(spotAsset.address);
            const totalSupply = await setToken.totalSupply();

            await subject();

            const totalRebalanceNotional = preciseDiv(
              preciseMul(initialPositions[0].baseBalance, expectedNewLeverageRatio.sub(currentLeverageRatio)),    // numerator
              preciseMul(currentLeverageRatio, ether(1).sub(expectedNewLeverageRatio))                            // denominator
            );

            const expectedNewPositionUnit = preciseDiv(
              preciseMul(spotAssetUnitBefore, totalSupply).add(totalRebalanceNotional.abs()),
              totalSupply
            );
            const actualNewPositionUnit = await setToken.getDefaultPositionRealUnit(spotAsset.address);

            expect(actualNewPositionUnit).to.eq(expectedNewPositionUnit);
          });
        });

        describe("when rebalance interval has not elapsed below min leverage ratio and greater than max trade size", async () => {
          let newExchangeSettings: PerpV2BasisExchangeSettings;

          cacheBeforeEach(async () => {
            await perpV2Setup.setBaseTokenOraclePrice(perpV2Setup.vETH, usdc(900));
            await perpV2PriceFeedMock.setPrice(BigNumber.from(900).mul(10 ** 8));

            newExchangeSettings = {
              ...exchange,
              twapMaxTradeSize: ether(.1),
              incentivizedTwapMaxTradeSize: ether(2),
            };
            await leverageStrategyExtension.setExchangeSettings(newExchangeSettings);
          });

          it("should verify initial leverage conditions", async () => {
            const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();
            expect(currentLeverageRatio.abs()).to.be.lt(methodology.minLeverageRatio.abs());
          });

          it("should set the last trade timestamp", async () => {
            await subject();

            const lastTradeTimestamp = await leverageStrategyExtension.lastTradeTimestamp();

            expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
          });

          it("should set the TWAP leverage ratio", async () => {
            const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();
            const previousTwapLeverageRatio = await leverageStrategyExtension.twapLeverageRatio();

            await subject();

            const currentTwapLeverageRatio = await leverageStrategyExtension.twapLeverageRatio();

            const expectedNewLeverageRatio = calculateNewLeverageRatioPerpV2Basis(
              currentLeverageRatio,
              methodology
            );
            expect(previousTwapLeverageRatio).to.eq(ZERO);
            expect(currentTwapLeverageRatio).to.eq(expectedNewLeverageRatio);
          });

          it("should update the baseToken position (PerpV2) on the SetToken correctly", async () => {
            const initialPositions = await perpBasisTradingModule.getPositionNotionalInfo(setToken.address);

            await subject();

            const newPositions = await perpBasisTradingModule.getPositionUnitInfo(setToken.address);
            const updatedPosition = newPositions[0];


            const totalSupply = await setToken.totalSupply();
            const expectedNewPositionUnit = preciseDiv(initialPositions[0].baseBalance
              .add(newExchangeSettings.twapMaxTradeSize.mul(-1)), totalSupply);

            expect(initialPositions.length).to.eq(1);
            expect(newPositions.length).to.eq(1);
            expect(updatedPosition.baseToken).to.eq(perpV2Setup.vETH.address);
            expect(updatedPosition.baseUnit).to.eq(expectedNewPositionUnit);
          });

          it("should update the spot asset positoin unit on the SetToken correctly", async () => {
            const spotAssetUnitBefore = await setToken.getDefaultPositionRealUnit(spotAsset.address);
            const totalSupply = await setToken.totalSupply();

            await subject();

            const expectedNewPositionUnit = preciseDiv(
              preciseMul(spotAssetUnitBefore, totalSupply).add(newExchangeSettings.twapMaxTradeSize.abs()),
              totalSupply
            );
            const actualNewPositionUnit = await setToken.getDefaultPositionRealUnit(spotAsset.address);

            expect(actualNewPositionUnit).to.eq(expectedNewPositionUnit);
          });
        });

        describe("when rebalance interval has not elapsed and within bounds", async () => {
          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Cooldown not elapsed or not valid leverage ratio");
          });
        });

        context("when current leverage ratio is above target (delever)", async () => {
          cacheBeforeEach(async () => {
            await perpV2PriceFeedMock.setPrice(BigNumber.from(1030).mul(10 ** 8));
            await perpV2Setup.setBaseTokenOraclePrice(perpV2Setup.vETH, usdc(1030));

            await increaseTimeAsync(ONE_DAY_IN_SECONDS);
          });

          it("should verify initial leverage conditions", async () => {
            const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();
            console.log(currentLeverageRatio.toString());
            expect(currentLeverageRatio.abs()).to.be.gt(methodology.targetLeverageRatio.abs());
          });

          it("should set the last trade timestamp", async () => {
            await subject();

            const lastTradeTimestamp = await leverageStrategyExtension.lastTradeTimestamp();

            expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
          });

          it("should not set the TWAP leverage ratio", async () => {
            await subject();

            const twapLeverageRatio = await leverageStrategyExtension.twapLeverageRatio();

            expect(twapLeverageRatio).to.eq(ZERO);
          });

          it("should update the baseToken position on the SetToken correctly", async () => {
            const totalSupply = await setToken.totalSupply();
            const initialPositions = await perpBasisTradingModule.getPositionNotionalInfo(setToken.address);
            const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();
            const expectedNewLeverageRatio = calculateNewLeverageRatioPerpV2Basis(
              currentLeverageRatio,
              methodology
            );

            await subject();

            const newPositions = await perpBasisTradingModule.getPositionUnitInfo(setToken.address);
            const updatedPosition = newPositions[0];

            const totalRebalanceNotional = preciseDiv(
              preciseMul(initialPositions[0].baseBalance, expectedNewLeverageRatio.sub(currentLeverageRatio)),    // numerator
              preciseMul(currentLeverageRatio, ether(1).sub(expectedNewLeverageRatio))                            // denominator
            );

            const expectedNewPositionUnit = preciseDiv(initialPositions[0].baseBalance.add(totalRebalanceNotional), totalSupply);

            expect(initialPositions.length).to.eq(1);
            expect(newPositions.length).to.eq(1);
            expect(updatedPosition.baseToken).to.eq(perpV2Setup.vETH.address);
            expect(updatedPosition.baseUnit).to.closeTo(expectedNewPositionUnit, 1);
          });

          it("should update the spot asset position unit on the SetToken correctly", async () => {
            const initialPositions = await perpBasisTradingModule.getPositionNotionalInfo(setToken.address);
            const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();

            const expectedNewLeverageRatio = calculateNewLeverageRatioPerpV2Basis(
              currentLeverageRatio,
              methodology
            );
            const spotAssetUnitBefore = await setToken.getDefaultPositionRealUnit(spotAsset.address);
            const totalSupply = await setToken.totalSupply();

            await subject();

            const totalRebalanceNotional = preciseDiv(
              preciseMul(initialPositions[0].baseBalance, expectedNewLeverageRatio.sub(currentLeverageRatio)),    // numerator
              preciseMul(currentLeverageRatio, ether(1).sub(expectedNewLeverageRatio))                            // denominator
            );

            const expectedNewPositionUnit = preciseDiv(
              preciseMul(spotAssetUnitBefore, totalSupply).sub(totalRebalanceNotional.abs()),
              totalSupply
            );
            const actualNewPositionUnit = await setToken.getDefaultPositionRealUnit(spotAsset.address);

            expect(actualNewPositionUnit).to.closeTo(expectedNewPositionUnit, 1);
          });
        });

        describe("when rebalance interval has not elapsed, above max leverage ratio and lower than max trade size", async () => {
          cacheBeforeEach(async () => {
            await perpV2Setup.setBaseTokenOraclePrice(perpV2Setup.vETH, usdc(1060));
            await perpV2PriceFeedMock.setPrice(BigNumber.from(1060).mul(10 ** 8));
          });

          it("should verify initial leverage conditions", async () => {
            const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();
            console.log(currentLeverageRatio.toString());
            expect(currentLeverageRatio.abs()).to.be.gt(methodology.maxLeverageRatio.abs());
          });

          it("should set the last trade timestamp", async () => {
            await subject();

            const lastTradeTimestamp = await leverageStrategyExtension.lastTradeTimestamp();

            expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
          });

          it("should not set the TWAP leverage ratio", async () => {
            await subject();

            const twapLeverageRatio = await leverageStrategyExtension.twapLeverageRatio();

            expect(twapLeverageRatio).to.eq(ZERO);
          });

          it("should update the baseToken position on the SetToken correctly", async () => {
            const totalSupply = await setToken.totalSupply();
            const initialPositions = await perpBasisTradingModule.getPositionNotionalInfo(setToken.address);
            const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();
            const expectedNewLeverageRatio = calculateNewLeverageRatioPerpV2Basis(
              currentLeverageRatio,
              methodology
            );

            await subject();

            const newPositions = await perpBasisTradingModule.getPositionUnitInfo(setToken.address);
            const updatedPosition = newPositions[0];

            const totalRebalanceNotional = preciseDiv(
              preciseMul(initialPositions[0].baseBalance, expectedNewLeverageRatio.sub(currentLeverageRatio)),    // numerator
              preciseMul(currentLeverageRatio, ether(1).sub(expectedNewLeverageRatio))                            // denominator
            );

            const expectedNewPositionUnit = preciseDiv(initialPositions[0].baseBalance.add(totalRebalanceNotional), totalSupply);

            expect(initialPositions.length).to.eq(1);
            expect(newPositions.length).to.eq(1);
            expect(updatedPosition.baseToken).to.eq(perpV2Setup.vETH.address);
            expect(updatedPosition.baseUnit).to.closeTo(expectedNewPositionUnit, 1);
          });

          it("should update the spot asset position unit on the SetToken correctly", async () => {
            const initialPositions = await perpBasisTradingModule.getPositionNotionalInfo(setToken.address);
            const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();

            const expectedNewLeverageRatio = calculateNewLeverageRatioPerpV2Basis(
              currentLeverageRatio,
              methodology
            );
            const spotAssetUnitBefore = await setToken.getDefaultPositionRealUnit(spotAsset.address);
            const totalSupply = await setToken.totalSupply();

            await subject();

            const totalRebalanceNotional = preciseDiv(
              preciseMul(initialPositions[0].baseBalance, expectedNewLeverageRatio.sub(currentLeverageRatio)),    // numerator
              preciseMul(currentLeverageRatio, ether(1).sub(expectedNewLeverageRatio))                            // denominator
            );

            const expectedNewPositionUnit = preciseDiv(
              preciseMul(spotAssetUnitBefore, totalSupply).sub(totalRebalanceNotional.abs()),
              totalSupply
            );
            const actualNewPositionUnit = await setToken.getDefaultPositionRealUnit(spotAsset.address);

            expect(actualNewPositionUnit).to.closeTo(expectedNewPositionUnit, 1);
          });
        });

        describe("when rebalance interval has not elapsed, above max leverage ratio and greater than max trade size", async () => {
          let newExchangeSettings: PerpV2BasisExchangeSettings;

          cacheBeforeEach(async () => {
            await perpV2Setup.setBaseTokenOraclePrice(perpV2Setup.vETH, usdc(1060));
            await perpV2PriceFeedMock.setPrice(BigNumber.from(1060).mul(10 ** 8));

            newExchangeSettings = {
              ...exchange,
              twapMaxTradeSize: ether(.1),
              incentivizedTwapMaxTradeSize: ether(2),
            };
            await leverageStrategyExtension.setExchangeSettings(newExchangeSettings);
          });

          it("should verify initial leverage conditions", async () => {
            const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();
            console.log(currentLeverageRatio.toString());
            expect(currentLeverageRatio.abs()).to.be.gt(methodology.maxLeverageRatio.abs());
          });

          it("should set the last trade timestamp", async () => {
            await subject();

            const lastTradeTimestamp = await leverageStrategyExtension.lastTradeTimestamp();

            expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
          });

          it("should set the TWAP leverage ratio", async () => {
            const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();
            const previousTwapLeverageRatio = await leverageStrategyExtension.twapLeverageRatio();

            await subject();

            const currentTwapLeverageRatio = await leverageStrategyExtension.twapLeverageRatio();

            const expectedNewLeverageRatio = calculateNewLeverageRatioPerpV2Basis(
              currentLeverageRatio,
              methodology
            );
            expect(ZERO).to.eq(previousTwapLeverageRatio);
            expect(expectedNewLeverageRatio).to.eq(currentTwapLeverageRatio);
          });

          it("should update the baseToken position on the SetToken correctly", async () => {
            const totalSupply = await setToken.totalSupply();
            const initialPositions = await perpBasisTradingModule.getPositionNotionalInfo(setToken.address);

            await subject();

            const newPositions = await perpBasisTradingModule.getPositionUnitInfo(setToken.address);
            const updatedPosition = newPositions[0];
            const expectedNewPositionUnit = preciseDiv(initialPositions[0].baseBalance.add(newExchangeSettings.twapMaxTradeSize), totalSupply);

            expect(initialPositions.length).to.eq(1);
            expect(newPositions.length).to.eq(1);
            expect(updatedPosition.baseToken).to.eq(perpV2Setup.vETH.address);
            expect(updatedPosition.baseUnit).to.closeTo(expectedNewPositionUnit, 1);
          });

          it("should update the spot asset position unit on the SetToken correctly", async () => {
            const spotAssetUnitBefore = await setToken.getDefaultPositionRealUnit(spotAsset.address);
            const totalSupply = await setToken.totalSupply();

            await subject();

            const expectedNewPositionUnit = preciseDiv(
              preciseMul(spotAssetUnitBefore, totalSupply).sub(newExchangeSettings.twapMaxTradeSize.abs()),
              totalSupply
            );
            const actualNewPositionUnit = await setToken.getDefaultPositionRealUnit(spotAsset.address);

            expect(actualNewPositionUnit).to.closeTo(expectedNewPositionUnit, 1);
          });

          describe("when in a TWAP rebalance", async () => {
            beforeEach(async () => {
              await subject();
            });

            it("should revert", async () => {
              await expect(subject()).to.be.revertedWith("Must call iterate");
            });
          });
        });
      });

      describe("when not engaged", async () => {
        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Current leverage ratio must NOT be 0");
        });
      });
    });

    describe("#iterateRebalance", async () => {
      let subjectCaller: Account;

      beforeEach(async () => {
        subjectCaller = owner;
      });

      async function subject(): Promise<any> {
        return leverageStrategyExtension.connect(subjectCaller.wallet).iterateRebalance();
      }

      describe("when engaged", async () => {
        cacheBeforeEach(async () => {
          // Engage short position
          await leverageStrategyExtension.engage();
          const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();
          console.log("CLR after enagage", currentLeverageRatio.toString());
        });

        context("when currently in the last chunk of a TWAP rebalance", async () => {
          let newExchangeSettings: PerpV2BasisExchangeSettings;
          let preTwapLeverageRatio: BigNumber;

          cacheBeforeEach(async () => {
            await increaseTimeAsync(ONE_DAY_IN_SECONDS);
            await perpV2Setup.setBaseTokenOraclePrice(perpV2Setup.vETH, usdc(920));
            await perpV2PriceFeedMock.setPrice(BigNumber.from(920).mul(10 ** 8));

            newExchangeSettings = {
              ...exchange,
              twapMaxTradeSize: ether(.06),
              incentivizedTwapMaxTradeSize: ether(1)
            };
            preTwapLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();
            console.log("preTwapLeverageRatio", preTwapLeverageRatio.toString());
            await leverageStrategyExtension.setExchangeSettings(newExchangeSettings);
            await leverageStrategyExtension.connect(owner.wallet).rebalance();
            const postlr = await leverageStrategyExtension.getCurrentLeverageRatio();
            console.log("postlr", postlr.toString());
            await increaseTimeAsync(BigNumber.from(4000));    // >3s (twapCoolDown period)
          });

          it("should verify initial leverage conditions", async () => {
            const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();
            const twapLeverageRatio = await leverageStrategyExtension.twapLeverageRatio();
            expect(currentLeverageRatio.abs()).to.be.lt(methodology.minLeverageRatio.abs());
            expect(twapLeverageRatio.abs()).to.be.eq(methodology.minLeverageRatio.abs());
          });

          it("should set the global last trade timestamp", async () => {
            await subject();
            const postlr = await leverageStrategyExtension.getCurrentLeverageRatio();
            console.log("postlr", postlr.toString());
            const lastTradeTimestamp = await leverageStrategyExtension.lastTradeTimestamp();

            expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
          });

          it("should remove the TWAP leverage ratio", async () => {
            await subject();

            const twapLeverageRatio = await leverageStrategyExtension.twapLeverageRatio();

            expect(twapLeverageRatio).to.eq(ZERO);
          });

          it("should update the baseToken position on the SetToken correctly", async () => {
            const initialPositions = await perpBasisTradingModule.getPositionNotionalInfo(setToken.address);

            const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();

            const expectedNewLeverageRatio = calculateNewLeverageRatioPerpV2Basis(
              preTwapLeverageRatio,
              methodology
            );

            await subject();

            const newPositions = await perpBasisTradingModule.getPositionUnitInfo(setToken.address);
            const newPosition = newPositions[0];

            const totalRebalanceNotional = preciseDiv(
              preciseMul(initialPositions[0].baseBalance, expectedNewLeverageRatio.sub(currentLeverageRatio)),    // numerator
              preciseMul(currentLeverageRatio, ether(1).sub(expectedNewLeverageRatio))                            // denominator
            );

            const chunkRebalanceNotional = totalRebalanceNotional.abs().gt(newExchangeSettings.twapMaxTradeSize)
              ? (totalRebalanceNotional.gt(ZERO) ? newExchangeSettings.twapMaxTradeSize : newExchangeSettings.twapMaxTradeSize.mul(-1))
              : totalRebalanceNotional;

            const totalSupply = await setToken.totalSupply();
            const expectedNewPositionUnit = preciseDiv(initialPositions[0].baseBalance.add(chunkRebalanceNotional), totalSupply);

            expect(initialPositions.length).to.eq(1);
            expect(newPositions.length).to.eq(1);
            expect(newPosition.baseToken).to.eq(perpV2Setup.vETH.address);
            expect(newPosition.baseUnit).to.eq(expectedNewPositionUnit);
          });

          it("should update the spot asset position unit on the SetToken correctly", async () => {
            const initialPositions = await perpBasisTradingModule.getPositionNotionalInfo(setToken.address);
            const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();

            const expectedNewLeverageRatio = calculateNewLeverageRatioPerpV2Basis(
              currentLeverageRatio,
              methodology
            );
            const spotAssetUnitBefore = await setToken.getDefaultPositionRealUnit(spotAsset.address);
            const totalSupply = await setToken.totalSupply();

            await subject();

            const totalRebalanceNotional = preciseDiv(
              preciseMul(initialPositions[0].baseBalance, expectedNewLeverageRatio.sub(currentLeverageRatio)),    // numerator
              preciseMul(currentLeverageRatio, ether(1).sub(expectedNewLeverageRatio))                            // denominator
            );

            const chunkRebalanceNotional = totalRebalanceNotional.abs().gt(newExchangeSettings.twapMaxTradeSize)
              ? (totalRebalanceNotional.gt(ZERO) ? newExchangeSettings.twapMaxTradeSize : newExchangeSettings.twapMaxTradeSize.mul(-1))
              : totalRebalanceNotional;

            const expectedNewPositionUnit = preciseDiv(
              preciseMul(spotAssetUnitBefore, totalSupply).add(chunkRebalanceNotional.abs()),
              totalSupply
            );
            const actualNewPositionUnit = await setToken.getDefaultPositionRealUnit(spotAsset.address);

            expect(actualNewPositionUnit).to.eq(expectedNewPositionUnit);
          });
        });

        context("when current leverage ratio is below target and in the middle of a TWAP", async () => {
          let newExchangeSettings: PerpV2BasisExchangeSettings;
          let preTwapLeverageRatio: BigNumber;

          cacheBeforeEach(async () => {
            await increaseTimeAsync(ONE_DAY_IN_SECONDS);
            await perpV2Setup.setBaseTokenOraclePrice(perpV2Setup.vETH, usdc(900));
            await perpV2PriceFeedMock.setPrice(BigNumber.from(900).mul(10 ** 8));

            newExchangeSettings = {
              ...exchange,
              twapMaxTradeSize: ether(.01),
              // -.205422934289947960
              incentivizedTwapMaxTradeSize: ether(1)
            };
            await leverageStrategyExtension.setExchangeSettings(newExchangeSettings);

            preTwapLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();
            await leverageStrategyExtension.connect(owner.wallet).rebalance();
            console.log((await leverageStrategyExtension.getCurrentLeverageRatio()).toString());
            await increaseTimeAsync(BigNumber.from(4000));    // >3s (twapCoolDown period)
          });

          it("should verify initial leverage conditions", async () => {
            const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();
            const twapLeverageRatio = await leverageStrategyExtension.twapLeverageRatio();
            expect(currentLeverageRatio.abs()).to.be.lt(methodology.targetLeverageRatio.abs());
            expect(twapLeverageRatio.abs()).to.be.gt(ZERO);
          });

          it("should set the global last trade timestamp", async () => {
            await subject();

            const lastTradeTimestamp = await leverageStrategyExtension.lastTradeTimestamp();

            expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
          });

          it("should set the TWAP leverage ratio", async () => {
            const previousTwapLeverageRatio = await leverageStrategyExtension.twapLeverageRatio();

            await subject();

            const currentTwapLeverageRatio = await leverageStrategyExtension.twapLeverageRatio();

            const expectedNewLeverageRatio = calculateNewLeverageRatioPerpV2Basis(
              preTwapLeverageRatio,
              methodology
            );
            expect(previousTwapLeverageRatio).to.eq(expectedNewLeverageRatio);
            expect(currentTwapLeverageRatio).to.eq(expectedNewLeverageRatio);
          });

          it("should update the baseToken position on the SetToken correctly", async () => {
            const initialPositions = await perpBasisTradingModule.getPositionNotionalInfo(setToken.address);

            const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();

            const expectedNewLeverageRatio = calculateNewLeverageRatioPerpV2Basis(
              preTwapLeverageRatio,
              methodology
            );

            await subject();
            console.log((await leverageStrategyExtension.getCurrentLeverageRatio()).toString());

            const newPositions = await perpBasisTradingModule.getPositionUnitInfo(setToken.address);
            const newPosition = newPositions[0];

            const totalRebalanceNotional = preciseDiv(
              preciseMul(initialPositions[0].baseBalance, expectedNewLeverageRatio.sub(currentLeverageRatio)),    // numerator
              preciseMul(currentLeverageRatio, ether(1).sub(expectedNewLeverageRatio))                            // denominator
            );
            console.log(totalRebalanceNotional.toString());

            const chunkRebalanceNotional = totalRebalanceNotional.abs().gt(newExchangeSettings.twapMaxTradeSize)
              ? (totalRebalanceNotional.gt(ZERO) ? newExchangeSettings.twapMaxTradeSize : newExchangeSettings.twapMaxTradeSize.mul(-1))
              : totalRebalanceNotional;

            console.log(chunkRebalanceNotional.toString());

            const totalSupply = await setToken.totalSupply();
            const expectedNewPositionUnit = preciseDiv(initialPositions[0].baseBalance.add(chunkRebalanceNotional), totalSupply);

            expect(initialPositions.length).to.eq(1);
            expect(newPositions.length).to.eq(1);
            expect(newPosition.baseToken).to.eq(perpV2Setup.vETH.address);
            expect(newPosition.baseUnit).to.closeTo(expectedNewPositionUnit, 1);
          });

          it("should update the spot asset position unit on the SetToken correctly", async () => {
            const initialPositions = await perpBasisTradingModule.getPositionNotionalInfo(setToken.address);
            const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();

            const expectedNewLeverageRatio = calculateNewLeverageRatioPerpV2Basis(
              currentLeverageRatio,
              methodology
            );
            const spotAssetUnitBefore = await setToken.getDefaultPositionRealUnit(spotAsset.address);
            const totalSupply = await setToken.totalSupply();

            await subject();

            const totalRebalanceNotional = preciseDiv(
              preciseMul(initialPositions[0].baseBalance, expectedNewLeverageRatio.sub(currentLeverageRatio)),    // numerator
              preciseMul(currentLeverageRatio, ether(1).sub(expectedNewLeverageRatio))                            // denominator
            );

            const chunkRebalanceNotional = totalRebalanceNotional.abs().gt(newExchangeSettings.twapMaxTradeSize)
              ? (totalRebalanceNotional.gt(ZERO) ? newExchangeSettings.twapMaxTradeSize : newExchangeSettings.twapMaxTradeSize.mul(-1))
              : totalRebalanceNotional;

            const expectedNewPositionUnit = preciseDiv(
              preciseMul(spotAssetUnitBefore, totalSupply).add(chunkRebalanceNotional.abs()),
              totalSupply
            );
            const actualNewPositionUnit = await setToken.getDefaultPositionRealUnit(spotAsset.address);

            expect(actualNewPositionUnit).to.eq(expectedNewPositionUnit);
          });
        });

        context("when current leverage ratio is above target and in the middle of a TWAP", async () => {
          let newExchangeSettings: PerpV2BasisExchangeSettings;
          let preTwapLeverageRatio: BigNumber;

          cacheBeforeEach(async () => {
            await increaseTimeAsync(ONE_DAY_IN_SECONDS);
            await perpV2Setup.setBaseTokenOraclePrice(perpV2Setup.vETH, usdc(1100));
            await perpV2PriceFeedMock.setPrice(BigNumber.from(1100).mul(10 ** 8));

            newExchangeSettings = {
              ...exchange,
              twapMaxTradeSize: ether(.02),
              incentivizedTwapMaxTradeSize: ether(1)
            };
            await leverageStrategyExtension.setExchangeSettings(newExchangeSettings);

            preTwapLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();
            await leverageStrategyExtension.connect(owner.wallet).rebalance();

            await increaseTimeAsync(BigNumber.from(4000));    // >3s (twapCoolDown period)
          });

          it("should verify initial leverage conditions", async () => {
            const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();
            const twapLeverageRatio = await leverageStrategyExtension.twapLeverageRatio();
            expect(currentLeverageRatio.abs()).to.be.gt(methodology.targetLeverageRatio.abs());
            expect(twapLeverageRatio.abs()).to.be.gt(ZERO);
          });

          it("should set the global last trade timestamp", async () => {
            await subject();

            const lastTradeTimestamp = await leverageStrategyExtension.lastTradeTimestamp();

            expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
          });

          it("should set the TWAP leverage ratio", async () => {
            const previousTwapLeverageRatio = await leverageStrategyExtension.twapLeverageRatio();

            await subject();

            const currentTwapLeverageRatio = await leverageStrategyExtension.twapLeverageRatio();

            const expectedNewLeverageRatio = calculateNewLeverageRatioPerpV2Basis(
              preTwapLeverageRatio,
              methodology
            );
            expect(previousTwapLeverageRatio).to.eq(expectedNewLeverageRatio);
            expect(currentTwapLeverageRatio).to.eq(expectedNewLeverageRatio);
          });

          it("should update the baseToken position on the SetToken correctly", async () => {
            const initialPositions = await perpBasisTradingModule.getPositionNotionalInfo(setToken.address);
            const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();
            const expectedNewLeverageRatio = calculateNewLeverageRatioPerpV2Basis(
              preTwapLeverageRatio,
              methodology
            );

            await subject();

            const newPositions = await perpBasisTradingModule.getPositionUnitInfo(setToken.address);
            const newPosition = newPositions[0];

            const totalRebalanceNotional = preciseDiv(
              preciseMul(initialPositions[0].baseBalance, expectedNewLeverageRatio.sub(currentLeverageRatio)),    // numerator
              preciseMul(currentLeverageRatio, ether(1).sub(expectedNewLeverageRatio))                            // denominator
            );

            const chunkRebalanceNotional = totalRebalanceNotional.abs().gt(newExchangeSettings.twapMaxTradeSize)
              ? (totalRebalanceNotional.gt(ZERO) ? newExchangeSettings.twapMaxTradeSize : newExchangeSettings.twapMaxTradeSize.mul(-1))
              : totalRebalanceNotional;

            const totalSupply = await setToken.totalSupply();
            const expectedNewPositionUnit = preciseDiv(initialPositions[0].baseBalance.add(chunkRebalanceNotional), totalSupply);

            expect(initialPositions.length).to.eq(1);
            expect(newPositions.length).to.eq(1);
            expect(newPosition.baseToken).to.eq(perpV2Setup.vETH.address);
            expect(newPosition.baseUnit).to.closeTo(expectedNewPositionUnit, 1);
          });

          it("should update the spot asset position unit on the SetToken correctly", async () => {
            const initialPositions = await perpBasisTradingModule.getPositionNotionalInfo(setToken.address);
            const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();

            const expectedNewLeverageRatio = calculateNewLeverageRatioPerpV2Basis(
              currentLeverageRatio,
              methodology
            );
            const spotAssetUnitBefore = await setToken.getDefaultPositionRealUnit(spotAsset.address);
            const totalSupply = await setToken.totalSupply();

            await subject();

            const totalRebalanceNotional = preciseDiv(
              preciseMul(initialPositions[0].baseBalance, expectedNewLeverageRatio.sub(currentLeverageRatio)),    // numerator
              preciseMul(currentLeverageRatio, ether(1).sub(expectedNewLeverageRatio))                            // denominator
            );

            const chunkRebalanceNotional = totalRebalanceNotional.abs().gt(newExchangeSettings.twapMaxTradeSize)
              ? (totalRebalanceNotional.gt(ZERO) ? newExchangeSettings.twapMaxTradeSize : newExchangeSettings.twapMaxTradeSize.mul(-1))
              : totalRebalanceNotional;

            const expectedNewPositionUnit = preciseDiv(
              preciseMul(spotAssetUnitBefore, totalSupply).sub(chunkRebalanceNotional.abs()),
              totalSupply
            );
            const actualNewPositionUnit = await setToken.getDefaultPositionRealUnit(spotAsset.address);

            expect(actualNewPositionUnit).to.eq(expectedNewPositionUnit);
          });
        });

        describe("when price has moved advantageously towards target leverage ratio", async () => {
          let newExchangeSettings: PerpV2BasisExchangeSettings;

          cacheBeforeEach(async () => {
            await increaseTimeAsync(ONE_DAY_IN_SECONDS);
            await perpV2Setup.setBaseTokenOraclePrice(perpV2Setup.vETH, usdc(900));
            await perpV2PriceFeedMock.setPrice(BigNumber.from(900).mul(10 ** 8));

            newExchangeSettings = {
              ...exchange,
              twapMaxTradeSize: ether(.01),
              incentivizedTwapMaxTradeSize: ether(1)
            };
            await leverageStrategyExtension.setExchangeSettings(newExchangeSettings);
            console.log((await leverageStrategyExtension.getCurrentLeverageRatio()).toString());
            await leverageStrategyExtension.connect(owner.wallet).rebalance();
            console.log((await leverageStrategyExtension.getCurrentLeverageRatio()).toString());

            await increaseTimeAsync(BigNumber.from(4000));    // >3s (twapCoolDown period)

            // Move price advantageously towards TLR; increase price, so leverage increases towards TLR
            await perpV2Setup.setBaseTokenOraclePrice(perpV2Setup.vETH, usdc(950));
            await perpV2PriceFeedMock.setPrice(BigNumber.from(950).mul(10 ** 8));
          });

          it("should verify initial leverage conditions", async () => {
            const twapLeverageRatio = await leverageStrategyExtension.twapLeverageRatio();
            expect(twapLeverageRatio.abs()).to.be.gt(ZERO);
          });

          it("should set the global last trade timestamp", async () => {
            await subject();

            const lastTradeTimestamp = await leverageStrategyExtension.lastTradeTimestamp();

            expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
          });

          it("should remove the TWAP leverage ratio", async () => {
            await subject();

            const twapLeverageRatio = await leverageStrategyExtension.twapLeverageRatio();

            expect(twapLeverageRatio).to.eq(ZERO);
          });

          it("should not update Perp positions on the SetToken", async () => {
            const initialPositions = await perpBasisTradingModule.getPositionUnitInfo(setToken.address);
            await subject();
            const currentPositions = await perpBasisTradingModule.getPositionUnitInfo(setToken.address);

            expect(currentPositions[0].baseToken).to.eq(initialPositions[0].baseToken);
            expect(currentPositions[0].baseUnit).to.eq(initialPositions[0].baseUnit);
          });

          it("should not update spot positions on the SetToken", async () => {
            const spotAssetUnitBefore = await setToken.getDefaultPositionRealUnit(strategy.spotAssetAddress);
            await subject();
            const spotAssetUnitAfter = await setToken.getDefaultPositionRealUnit(strategy.spotAssetAddress);

            expect(spotAssetUnitBefore).to.eq(spotAssetUnitAfter);
          });
        });

        describe("when above incentivized leverage ratio threshold", async () => {
          beforeEach(async () => {
            await increaseTimeAsync(ONE_DAY_IN_SECONDS);
            await perpV2Setup.setBaseTokenOraclePrice(perpV2Setup.vETH, usdc(1200));
            await perpV2PriceFeedMock.setPrice(BigNumber.from(1200).mul(10 ** 8));
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Must be below incentivized leverage ratio");
          });
        });

        context("when not in TWAP state", async () => {
          beforeEach(async () => {
            await increaseTimeAsync(ONE_DAY_IN_SECONDS);
            await perpV2Setup.setBaseTokenOraclePrice(perpV2Setup.vETH, usdc(950));
            await perpV2PriceFeedMock.setPrice(BigNumber.from(950).mul(10 ** 8));
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Not in TWAP state");
          });
        });
      });

      describe("when not engaged", async () => {
        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Current leverage ratio must NOT be 0");
        });
      });
    });

    describe("#ripcord", async () => {
      let transferredEth: BigNumber;
      let subjectCaller: Account;

      beforeEach(async () => {
        subjectCaller = owner;
      });

      async function subject(): Promise<any> {
        return leverageStrategyExtension.connect(subjectCaller.wallet).ripcord();
      }

      context("when engaged", async () => {
        cacheBeforeEach(async () => {
          // Engage short position
          await leverageStrategyExtension.engage();
          await increaseTimeAsync(BigNumber.from(100000));
        });

        context("when not in a TWAP rebalance", async () => {
          cacheBeforeEach(async () => {
            // Set to above incentivized ratio
            await perpV2Setup.setBaseTokenOraclePrice(perpV2Setup.vETH, usdc(1150));
            await perpV2PriceFeedMock.setPrice(BigNumber.from(1150).mul(10 ** 8));

            // Deposit ETH to incentivize calling ripcord
            transferredEth = ether(1);
            await owner.wallet.sendTransaction({ to: leverageStrategyExtension.address, value: transferredEth });
          });

          it("should validate leverage ratio and NOT in TWAP", async () => {
            const twapLeverageRatio = await leverageStrategyExtension.twapLeverageRatio();
            const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();

            expect(currentLeverageRatio.abs()).to.be.gt(incentive.incentivizedLeverageRatio.abs());
            expect(twapLeverageRatio).to.be.eq(ZERO);
          });

          it("should set the last trade timestamp", async () => {
            await subject();

            const lastTradeTimestamp = await leverageStrategyExtension.lastTradeTimestamp();

            expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
          });

          it("should not set the TWAP leverage ratio", async () => {
            await subject();

            const twapLeverageRatio = await leverageStrategyExtension.twapLeverageRatio();

            expect(twapLeverageRatio).to.eq(ZERO);
          });

          it("should update the baseToken position on the SetToken correctly", async () => {
            const initialPositions = await perpBasisTradingModule.getPositionNotionalInfo(setToken.address);
            const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();
            const expectedNewLeverageRatio = methodology.maxLeverageRatio;

            await subject();

            const newPositions = await perpBasisTradingModule.getPositionUnitInfo(setToken.address);
            const newPosition = newPositions[0];

            const totalRebalanceNotional = preciseDiv(
              preciseMul(initialPositions[0].baseBalance, expectedNewLeverageRatio.sub(currentLeverageRatio)),    // numerator
              preciseMul(currentLeverageRatio, ether(1).sub(expectedNewLeverageRatio))                            // denominator
            );

            const chunkRebalanceNotional = totalRebalanceNotional.abs().gt(exchange.incentivizedTwapMaxTradeSize)
              ? (totalRebalanceNotional.gt(ZERO) ? exchange.incentivizedTwapMaxTradeSize : exchange.incentivizedTwapMaxTradeSize.mul(-1))
              : totalRebalanceNotional;

            const totalSupply = await setToken.totalSupply();
            const expectedNewPositionUnit = preciseDiv(initialPositions[0].baseBalance.add(chunkRebalanceNotional), totalSupply);

            expect(initialPositions.length).to.eq(1);
            expect(newPositions.length).to.eq(1);
            expect(newPosition.baseToken).to.eq(perpV2Setup.vETH.address);
            expect(newPosition.baseUnit).to.closeTo(expectedNewPositionUnit, 1);
          });

          it("should update the spot asset position on the SetToken correctly", async () => {
            const totalSupply = await setToken.totalSupply();
            const initialPositions = await perpBasisTradingModule.getPositionNotionalInfo(setToken.address);
            const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();
            const expectedNewLeverageRatio = methodology.maxLeverageRatio;
            const initialSpotPositionUnit = await setToken.getDefaultPositionRealUnit(spotAsset.address);

            await subject();

            const totalRebalanceNotional = preciseDiv(
              preciseMul(initialPositions[0].baseBalance, expectedNewLeverageRatio.sub(currentLeverageRatio)),    // numerator
              preciseMul(currentLeverageRatio, ether(1).sub(expectedNewLeverageRatio))                            // denominator
            );

            const chunkRebalanceNotional = totalRebalanceNotional.abs().gt(exchange.incentivizedTwapMaxTradeSize)
              ? (totalRebalanceNotional.gt(ZERO) ? exchange.incentivizedTwapMaxTradeSize : exchange.incentivizedTwapMaxTradeSize.mul(-1))
              : totalRebalanceNotional;

            const newSpotPositionUnit = await setToken.getDefaultPositionRealUnit(spotAsset.address);
            const expectedNewPositionUnit = initialSpotPositionUnit.sub(preciseDiv(chunkRebalanceNotional.abs(), totalSupply));

            expect(newSpotPositionUnit).to.eq(expectedNewPositionUnit);
          });

          it("should transfer incentive", async () => {
            const previousContractEthBalance = await getEthBalance(leverageStrategyExtension.address);
            const previousOwnerEthBalance = await getEthBalance(owner.address);

            const txHash = await subject();
            const txReceipt = await provider.getTransactionReceipt(txHash.hash);
            const currentContractEthBalance = await getEthBalance(leverageStrategyExtension.address);
            const currentOwnerEthBalance = await getEthBalance(owner.address);
            const expectedOwnerEthBalance = previousOwnerEthBalance.add(incentive.etherReward).sub(txReceipt.gasUsed.mul(txHash.gasPrice));

            expect(previousContractEthBalance).to.eq(transferredEth);
            expect(currentContractEthBalance).to.eq(transferredEth.sub(incentive.etherReward));
            expect(expectedOwnerEthBalance).to.eq(currentOwnerEthBalance);
          });

          it("should emit RipcordCalled event", async () => {
            const initialPositions = await perpBasisTradingModule.getPositionNotionalInfo(setToken.address);
            const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();
            const expectedNewLeverageRatio = methodology.maxLeverageRatio;
            const totalRebalanceNotional = preciseDiv(
              preciseMul(initialPositions[0].baseBalance, expectedNewLeverageRatio.sub(currentLeverageRatio)),    // numerator
              preciseMul(currentLeverageRatio, ether(1).sub(expectedNewLeverageRatio))                            // denominator
            );

            const chunkRebalanceNotional = totalRebalanceNotional.abs().gt(exchange.incentivizedTwapMaxTradeSize)
              ? (totalRebalanceNotional.gt(ZERO) ? exchange.incentivizedTwapMaxTradeSize : exchange.incentivizedTwapMaxTradeSize.mul(-1))
              : totalRebalanceNotional;


            await expect(subject()).to.emit(leverageStrategyExtension, "RipcordCalled").withArgs(
              currentLeverageRatio,
              methodology.maxLeverageRatio,
              chunkRebalanceNotional,
              incentive.etherReward,
            );
          });

          describe("when greater than incentivized max trade size", async () => {
            let newIncentivizedMaxTradeSize: BigNumber;

            cacheBeforeEach(async () => {
              newIncentivizedMaxTradeSize = ether(0.01);
              const newPerpV2BasisExchangeSettings: PerpV2BasisExchangeSettings = {
                ...exchange,
                twapMaxTradeSize: ether(0.001),
                incentivizedTwapMaxTradeSize: newIncentivizedMaxTradeSize
              };
              await leverageStrategyExtension.setExchangeSettings(newPerpV2BasisExchangeSettings);
            });

            it("should set the global last trade timestamp", async () => {
              await subject();

              const lastTradeTimestamp = await leverageStrategyExtension.lastTradeTimestamp();

              expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
            });

            it("should update the baseToken position on the SetToken correctly", async () => {
              const initialPositions = await perpBasisTradingModule.getPositionNotionalInfo(setToken.address);

              await subject();

              const newPositions = await perpBasisTradingModule.getPositionUnitInfo(setToken.address);
              const newPosition = newPositions[0];

              const totalSupply = await setToken.totalSupply();
              const expectedNewPositionUnit = preciseDiv(initialPositions[0].baseBalance.add(newIncentivizedMaxTradeSize), totalSupply);

              expect(initialPositions.length).to.eq(1);
              expect(newPositions.length).to.eq(1);
              expect(newPosition.baseToken).to.eq(perpV2Setup.vETH.address);
              expect(newPosition.baseUnit).to.closeTo(expectedNewPositionUnit, 1);
            });

            it("should update the baseToken position on the SetToken correctly", async () => {
              const totalSupply = await setToken.totalSupply();
              const initialSpotPositionUnit = await setToken.getDefaultPositionRealUnit(spotAsset.address);

              await subject();

              const newSpotPositionUnit = await setToken.getDefaultPositionRealUnit(spotAsset.address);
              const expectedNewPositionUnit = initialSpotPositionUnit.sub(preciseDiv(newIncentivizedMaxTradeSize.abs(), totalSupply));

              expect(newSpotPositionUnit).to.eq(expectedNewPositionUnit);
            });
          });

          describe("when incentivized cooldown period has not elapsed", async () => {
            let newIncentivizedMaxTradeSize: BigNumber;

            cacheBeforeEach(async () => {
              newIncentivizedMaxTradeSize = ether(0.01);
              const newPerpV2BasisExchangeSettings: PerpV2BasisExchangeSettings = {
                ...exchange,
                twapMaxTradeSize: ether(0.001),
                incentivizedTwapMaxTradeSize: newIncentivizedMaxTradeSize
              };
              await leverageStrategyExtension.setExchangeSettings(newPerpV2BasisExchangeSettings);
            });

            beforeEach(async () => {
              await subject();
            });

            it("should revert", async () => {
              await expect(subject()).to.be.revertedWith("TWAP cooldown must have elapsed");
            });
          });

          describe("when below incentivized leverage ratio threshold", async () => {
            beforeEach(async () => {
              await perpV2Setup.setBaseTokenOraclePrice(perpV2Setup.vETH, usdc(1010));
              await perpV2PriceFeedMock.setPrice(BigNumber.from(1010).mul(10 ** 8));
            });

            it("should revert", async () => {
              await expect(subject()).to.be.revertedWith("Must be above incentivized leverage ratio");
            });
          });
        });

        context("when in the midst of a TWAP rebalance", async () => {
          let newIncentivizedMaxTradeSize: BigNumber;

          cacheBeforeEach(async () => {
            transferredEth = ether(1);
            await owner.wallet.sendTransaction({ to: leverageStrategyExtension.address, value: transferredEth });

            newIncentivizedMaxTradeSize = ether(0.001);
            const newPerpV2BasisExchangeSettings: PerpV2BasisExchangeSettings = {
              ...exchange,
              twapMaxTradeSize: ether(0.001),
              incentivizedTwapMaxTradeSize: newIncentivizedMaxTradeSize
            };
            await leverageStrategyExtension.setExchangeSettings(newPerpV2BasisExchangeSettings);

            await perpV2Setup.setBaseTokenOraclePrice(perpV2Setup.vETH, usdc(950));
            await perpV2PriceFeedMock.setPrice(BigNumber.from(950).mul(10 ** 8));

            // Start TWAP rebalance
            await leverageStrategyExtension.rebalance();
            await increaseTimeAsync(BigNumber.from(100));

            // Set to above incentivized ratio
            await perpV2Setup.setBaseTokenOraclePrice(perpV2Setup.vETH, usdc(1150));
            await perpV2PriceFeedMock.setPrice(BigNumber.from(1150).mul(10 ** 8));
          });

          it("should validate leverage ratio and in TWAP", async () => {
            const twapLeverageRatio = await leverageStrategyExtension.twapLeverageRatio();
            const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();

            expect(currentLeverageRatio.abs()).to.be.gt(incentive.incentivizedLeverageRatio.abs());
            expect(twapLeverageRatio.abs()).to.be.gt(ZERO);
          });

          it("should set the global last trade timestamp", async () => {
            await subject();

            const lastTradeTimestamp = await leverageStrategyExtension.lastTradeTimestamp();

            expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
          });

          it("should set the TWAP leverage ratio to 0", async () => {
            await subject();

            const twapLeverageRatio = await leverageStrategyExtension.twapLeverageRatio();

            expect(twapLeverageRatio).to.eq(ZERO);
          });
        });
      });

      describe("when not engaged", async () => {
        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Current leverage ratio must NOT be 0");
        });
      });
    });

    describe("#disengage", async () => {
      let subjectCaller: Account;

      beforeEach(async () => {
        subjectCaller = owner;
      });

      async function subject(): Promise<any> {
        return leverageStrategyExtension.connect(subjectCaller.wallet).disengage();
      }

      context("when engaged", async () => {
        cacheBeforeEach(async () => {
          await leverageStrategyExtension.engage();
          await increaseTimeAsync(BigNumber.from(4000));
        });

        context("when notional is less than max trade size", async () => {
          it("should remove the base position from the SetToken", async () => {
            const initialPositions = await perpBasisTradingModule.getPositionUnitInfo(setToken.address);

            await subject();

            const newPositions = await perpBasisTradingModule.getPositionUnitInfo(setToken.address);

            expect(initialPositions.length).to.eq(1);
            expect(newPositions.length).to.eq(0);
          });

          it("should sell all the spot assets", async () => {
            const initialSpotAssetUnit = await setToken.getDefaultPositionRealUnit(spotAsset.address);

            await subject();

            const newSpotAssetUnit = await setToken.getDefaultPositionRealUnit(spotAsset.address);

            expect(initialSpotAssetUnit).to.be.gt(ZERO);
            expect(newSpotAssetUnit).to.be.eq(ZERO);
          });

          it("should set the last trade timestamp", async () => {
            await subject();

            const lastTradeTimestamp = await leverageStrategyExtension.lastTradeTimestamp();

            expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
          });

          describe("when SetToken has 0 supply", async () => {
            beforeEach(async () => {
              const totalSupply = await setToken.totalSupply();
              await issuanceModule.redeem(setToken.address, totalSupply, owner.address);
            });

            it("should revert", async () => {
              await expect(subject()).to.be.revertedWith("SetToken must have > 0 supply");
            });
          });
        });

        context("when notional is greater than max trade size", async () => {
          let newExchangeSettings: PerpV2BasisExchangeSettings;

          const intializeContracts = async () => {
            newExchangeSettings = {
              ...exchange,
              twapMaxTradeSize: ether(1.9),
              incentivizedTwapMaxTradeSize: exchange.incentivizedTwapMaxTradeSize
            };
            await leverageStrategyExtension.setExchangeSettings(newExchangeSettings);
          };

          cacheBeforeEach(intializeContracts);

          it("should update the base position on the SetToken correctly", async () => {
            const totalSupply = await setToken.totalSupply();
            const initialPositions = await perpBasisTradingModule.getPositionNotionalInfo(setToken.address);

            await subject();

            const newPositions = await perpBasisTradingModule.getPositionUnitInfo(setToken.address);
            const newPosition = newPositions[0];

            const expectedNewPositionUnit = preciseDiv(initialPositions[0].baseBalance.add(newExchangeSettings.twapMaxTradeSize), totalSupply);

            expect(initialPositions.length).to.eq(1);
            expect(newPositions.length).to.eq(1);
            expect(newPosition.baseToken).to.eq(perpV2Setup.vETH.address);
            expect(newPosition.baseUnit).to.closeTo(expectedNewPositionUnit, 1);
          });

          it("should update the spot position on the SetToken correctly", async () => {
            const totalSupply = await setToken.totalSupply();
            const initialPositionUnit = await setToken.getDefaultPositionRealUnit(spotAsset.address);
            const expectedNewPositionUnit = initialPositionUnit.sub(preciseDiv(newExchangeSettings.twapMaxTradeSize, totalSupply));

            await subject();

            const newPositionUnit = await setToken.getDefaultPositionRealUnit(spotAsset.address);

            expect(newPositionUnit).to.eq(expectedNewPositionUnit);
          });

          it("should set the last trade timestamp", async () => {
            await subject();

            const lastTradeTimestamp = await leverageStrategyExtension.lastTradeTimestamp();

            expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
          });

          describe("when cooldown has not elapsed", async () => {
            beforeEach(async () => {
              await subject();
            });

            it("should revert", async () => {
              await expect(subject()).to.be.revertedWith("TWAP cooldown must have elapsed");
            });
          });

          describe("when SetToken has 0 supply", async () => {
            beforeEach(async () => {
              const totalSupply = await setToken.totalSupply();
              await issuanceModule.redeem(setToken.address, totalSupply, owner.address);
            });

            it("should revert", async () => {
              await expect(subject()).to.be.revertedWith("SetToken must have > 0 supply");
            });
          });
        });
      });

      describe("when not engaged", async () => {
        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Current leverage ratio must NOT be 0");
        });
      });
    });

    describe("#reinvest", async () => {
      let subjectCaller: Account;

      cacheBeforeEach(async () => {
        // set funding rate to NON-ZERO, to allow funding to accrue which would be reinvested
        await perpV2Setup.clearingHouseConfig.setMaxFundingRate(BigNumber.from(0.1e6));
      });

      beforeEach(async () => {
        subjectCaller = owner;
      });

      async function subject(): Promise<any> {
        return await leverageStrategyExtension.connect(subjectCaller.wallet).reinvest();
      }

      describe("when engaged", async () => {
        let performanceFeePercentage: BigNumber;

        cacheBeforeEach(async () => {
          await leverageStrategyExtension.engage();

          // Set index price below mark price to accrue positive funding to short position
          await perpV2Setup.setBaseTokenOraclePrice(perpV2Setup.vETH, usdc(990));
          await perpV2PriceFeedMock.setPrice(BigNumber.from(990).mul(10 ** 8));
          await increaseTimeAsync(ONE_DAY_IN_SECONDS.mul(7));

          performanceFeePercentage = (await perpBasisTradingModule.feeSettings(setToken.address)).performanceFeePercentage;
        });

        it("verify initial testing state", async () => {
          const pendingFunding = await perpV2Setup.exchange.getAllPendingFundingPayment(setToken.address);
          expect(pendingFunding.mul(-1)).to.gt(ZERO);
        });

        it("should withdraw tracked settled funding from Perpetual protocol", async () => {
          const trackedSettledFunding = await perpBasisTradingModule.settledFunding(setToken.address);
          const pendingFunding = await perpV2Setup.exchange.getAllPendingFundingPayment(setToken.address);
          const initialTrackedSettledFunding = trackedSettledFunding.add(pendingFunding.mul(-1));
          const fundingWithdrawnNetFees = initialTrackedSettledFunding.sub(preciseMul(initialTrackedSettledFunding, performanceFeePercentage));

          // Doesn't contain owedRealizedPnl
          const initialVaultCollateralBalance = await perpV2Setup.vault.getBalance(setToken.address);

          await subject();

          const currentTrackedSettledFunding = await perpBasisTradingModule.settledFunding(setToken.address);
          const currentVaultCollateralBalance = await perpV2Setup.vault.getBalance(setToken.address);

          expect(currentTrackedSettledFunding).to.be.lt(ether(0.000001));
          // Depositing back half to PerpV2.
          expect(
            currentVaultCollateralBalance.sub(initialVaultCollateralBalance)
          ).closeTo(fundingWithdrawnNetFees.div(BigNumber.from(10).pow(12)).div(2), 300);
        });

        it("should reinvest into perp position", async () => {
          const initialPositions = await perpBasisTradingModule.getPositionNotionalInfo(setToken.address);

          const trackedSettledFunding = await perpBasisTradingModule.settledFunding(setToken.address);
          const pendingFunding = await perpV2Setup.exchange.getAllPendingFundingPayment(setToken.address);
          const initialTrackedSettledFunding = trackedSettledFunding.add(pendingFunding.mul(-1));
          const fundingWithdrawnNetFees = initialTrackedSettledFunding.sub(preciseMul(initialTrackedSettledFunding, performanceFeePercentage));

          const usdAmountInvested = fundingWithdrawnNetFees.div(BigNumber.from(10).pow(12)).div(2);
          // .155427105277853193
          const amountOutOnDex = await uniV3Setup.quoter.callStatic.quoteExactInput(exchange.buySpotQuoteExactInputPath, usdAmountInvested);

          await subject();

          const currentPositions = await perpBasisTradingModule.getPositionNotionalInfo(setToken.address);
          const expectedBaseBalance = initialPositions[0].baseBalance.add(amountOutOnDex.mul(-1));

          expect(currentPositions[0].baseBalance).closeTo(expectedBaseBalance, ether(0.0001).toNumber());
          expect(currentPositions[0].baseToken).eq(strategy.virtualBaseAddress);
        });

        it("should reinvest into spot position", async () => {
          const setSupply = await setToken.totalSupply();
          const iniitalSpotPostionUnit = await setToken.getDefaultPositionRealUnit(strategy.spotAssetAddress);

          const trackedSettledFunding = await perpBasisTradingModule.settledFunding(setToken.address);
          const pendingFunding = await perpV2Setup.exchange.getAllPendingFundingPayment(setToken.address);
          const initialTrackedSettledFunding = trackedSettledFunding.add(pendingFunding.mul(-1));
          const fundingWithdrawnNetFees = initialTrackedSettledFunding.sub(preciseMul(initialTrackedSettledFunding, performanceFeePercentage));

          const usdAmountInvested = fundingWithdrawnNetFees.div(BigNumber.from(10).pow(12)).div(2);
          // .155427105277853193
          const amountOutOnDex = await uniV3Setup.quoter.callStatic.quoteExactInput(exchange.buySpotQuoteExactInputPath, usdAmountInvested);

          await subject();

          const currentSpotPositionUnit = await setToken.getDefaultPositionRealUnit(strategy.spotAssetAddress);
          const expectedNewPositionUnit = iniitalSpotPostionUnit.add(preciseDiv(amountOutOnDex, setSupply));

          expect(currentSpotPositionUnit).to.closeTo(expectedNewPositionUnit, ether(0.000001).toNumber());
        });

        describe("when reinvest interval has NOT elapsed", async () => {
          beforeEach(async () => {
            await subject();
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Reinvestment interval not elapsed");
          });
        });
      });

      describe("when not engaged", async () => {
        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Current leverage ratio must NOT be 0");
        });
      });
    });

    describe("#setMethodologySettings", async () => {
      let subjectMethodologySettings: PerpV2BasisMethodologySettings;
      let subjectCaller: Account;

      const initializeSubjectVariables = () => {
        subjectMethodologySettings = {
          targetLeverageRatio: ether(-1),
          minLeverageRatio: ether(-0.8),
          maxLeverageRatio: ether(-1.1),
          recenteringSpeed: ether(0.1),
          rebalanceInterval: BigNumber.from(43200),
          reinvestInterval: ONE_DAY_IN_SECONDS.mul(7)
        };
        subjectCaller = owner;
      };

      async function subject(): Promise<any> {
        leverageStrategyExtension = leverageStrategyExtension.connect(subjectCaller.wallet);
        return leverageStrategyExtension.setMethodologySettings(subjectMethodologySettings);
      }

      describe("when rebalance is not in progress", () => {
        cacheBeforeEach(initializeRootScopeContracts);
        beforeEach(initializeSubjectVariables);

        it("should set the correct methodology parameters", async () => {
          await subject();
          const methodology = await leverageStrategyExtension.getMethodology();

          expect(methodology.targetLeverageRatio).to.eq(subjectMethodologySettings.targetLeverageRatio);
          expect(methodology.minLeverageRatio).to.eq(subjectMethodologySettings.minLeverageRatio);
          expect(methodology.maxLeverageRatio).to.eq(subjectMethodologySettings.maxLeverageRatio);
          expect(methodology.recenteringSpeed).to.eq(subjectMethodologySettings.recenteringSpeed);
          expect(methodology.rebalanceInterval).to.eq(subjectMethodologySettings.rebalanceInterval);
          expect(methodology.reinvestInterval).to.eq(subjectMethodologySettings.reinvestInterval);
        });

        it("should emit PerpV2MethodologySettingsUpdated event", async () => {
          await expect(subject()).to.emit(leverageStrategyExtension, "MethodologySettingsUpdated").withArgs(
            subjectMethodologySettings.targetLeverageRatio,
            subjectMethodologySettings.minLeverageRatio,
            subjectMethodologySettings.maxLeverageRatio,
            subjectMethodologySettings.recenteringSpeed,
            subjectMethodologySettings.rebalanceInterval,
            subjectMethodologySettings.reinvestInterval
          );
        });

        describe("when the caller is not the operator", async () => {
          beforeEach(async () => {
            subjectCaller = await getRandomAccount();
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Must be operator");
          });
        });
      });

      describe("when rebalance is in progress", async () => {
        let newExchangeSettings: PerpV2BasisExchangeSettings;

        beforeEach(async () => {
          await initializeRootScopeContracts();
          initializeSubjectVariables();

          newExchangeSettings = {
            ...exchange,
            twapMaxTradeSize: ether(.1),
            incentivizedTwapMaxTradeSize: ether(1)
          };
          await leverageStrategyExtension.setExchangeSettings(newExchangeSettings);

          // Engage to initial leverage
          await leverageStrategyExtension.engage();
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Rebalance is currently in progress");
        });
      });
    });

    describe("#setExecutionSettings", async () => {
      let subjectExecutionSettings: PerpV2BasisExecutionSettings;
      let subjectCaller: Account;

      const initializeSubjectVariables = () => {
        subjectExecutionSettings = {
          twapCooldownPeriod: BigNumber.from(360),
          slippageTolerance: ether(0.02),
        };
        subjectCaller = owner;
      };

      async function subject(): Promise<any> {
        leverageStrategyExtension = leverageStrategyExtension.connect(subjectCaller.wallet);
        return leverageStrategyExtension.setExecutionSettings(subjectExecutionSettings);
      }

      describe("when rebalance is not in progress", () => {
        cacheBeforeEach(initializeRootScopeContracts);
        beforeEach(initializeSubjectVariables);

        it("should set the correct execution parameters", async () => {
          await subject();
          const execution = await leverageStrategyExtension.getExecution();

          expect(execution.twapCooldownPeriod).to.eq(subjectExecutionSettings.twapCooldownPeriod);
          expect(execution.slippageTolerance).to.eq(subjectExecutionSettings.slippageTolerance);
        });

        it("should emit ExecutionSettingsUpdated event", async () => {
          await expect(subject()).to.emit(leverageStrategyExtension, "ExecutionSettingsUpdated").withArgs(
            subjectExecutionSettings.twapCooldownPeriod,
            subjectExecutionSettings.slippageTolerance
          );
        });

        describe("when the caller is not the operator", async () => {
          beforeEach(async () => {
            subjectCaller = await getRandomAccount();
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Must be operator");
          });
        });
      });

      describe("when rebalance is in progress", async () => {
        let newExchangeSettings: PerpV2BasisExchangeSettings;

        beforeEach(async () => {
          await initializeRootScopeContracts();
          initializeSubjectVariables();

          newExchangeSettings = {
            ...exchange,
            twapMaxTradeSize: ether(.1),
            incentivizedTwapMaxTradeSize: ether(1)
          };
          await leverageStrategyExtension.setExchangeSettings(newExchangeSettings);
          // Engage to initial leverage
          await leverageStrategyExtension.engage();
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Rebalance is currently in progress");
        });
      });
    });

    describe("#setIncentiveSettings", async () => {
      let subjectIncentiveSettings: PerpV2BasisIncentiveSettings;
      let subjectCaller: Account;

      const initializeSubjectVariables = () => {
        subjectIncentiveSettings = {
          incentivizedTwapCooldownPeriod: BigNumber.from(30),
          incentivizedSlippageTolerance: ether(0.1),
          etherReward: ether(5),
          incentivizedLeverageRatio: ether(-1.3),
        };
        subjectCaller = owner;
      };

      async function subject(): Promise<any> {
        leverageStrategyExtension = leverageStrategyExtension.connect(subjectCaller.wallet);
        return leverageStrategyExtension.setIncentiveSettings(subjectIncentiveSettings);
      }

      describe("when rebalance is not in progress", () => {
        cacheBeforeEach(initializeRootScopeContracts);
        beforeEach(initializeSubjectVariables);

        it("should set the correct incentive parameters", async () => {
          await subject();
          const incentive = await leverageStrategyExtension.getIncentive();

          expect(incentive.incentivizedTwapCooldownPeriod).to.eq(subjectIncentiveSettings.incentivizedTwapCooldownPeriod);
          expect(incentive.incentivizedSlippageTolerance).to.eq(subjectIncentiveSettings.incentivizedSlippageTolerance);
          expect(incentive.etherReward).to.eq(subjectIncentiveSettings.etherReward);
          expect(incentive.incentivizedLeverageRatio).to.eq(subjectIncentiveSettings.incentivizedLeverageRatio);
        });

        it("should emit IncentiveSettingsUpdated event", async () => {
          await expect(subject()).to.emit(leverageStrategyExtension, "IncentiveSettingsUpdated").withArgs(
            subjectIncentiveSettings.etherReward,
            subjectIncentiveSettings.incentivizedLeverageRatio,
            subjectIncentiveSettings.incentivizedSlippageTolerance,
            subjectIncentiveSettings.incentivizedTwapCooldownPeriod
          );
        });

        describe("when the caller is not the operator", async () => {
          beforeEach(async () => {
            subjectCaller = await getRandomAccount();
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Must be operator");
          });
        });
      });

      describe("when rebalance is in progress", async () => {
        let newExchangeSettings: PerpV2BasisExchangeSettings;

        beforeEach(async () => {
          await initializeRootScopeContracts();
          initializeSubjectVariables();

          newExchangeSettings = {
            ...exchange,
            twapMaxTradeSize: ether(.1),
            incentivizedTwapMaxTradeSize: ether(1)
          };
          await leverageStrategyExtension.setExchangeSettings(newExchangeSettings);
          // Engage to initial leverage
          await leverageStrategyExtension.engage();
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Rebalance is currently in progress");
        });
      });
    });

    describe("#setExchangeSettings", async () => {
      let subjectExchangeSettings: PerpV2BasisExchangeSettings;
      let subjectCaller: Account;

      cacheBeforeEach(initializeRootScopeContracts);
      beforeEach(async () => {
        subjectExchangeSettings = {
          exchangeName: exchange.exchangeName,
          buyExactSpotTradeData: exchange.buyExactSpotTradeData,
          sellExactSpotTradeData: exchange.sellExactSpotTradeData,
          buySpotQuoteExactInputPath: exchange.buySpotQuoteExactInputPath,
          twapMaxTradeSize: ether(10),
          incentivizedTwapMaxTradeSize: ether(20)
        };
        subjectCaller = owner;
      });

      async function subject(): Promise<any> {
        leverageStrategyExtension = leverageStrategyExtension.connect(subjectCaller.wallet);
        return leverageStrategyExtension.setExchangeSettings(subjectExchangeSettings);
      }

      it("should set the correct exchange parameters", async () => {
        await subject();
        const exchange = await leverageStrategyExtension.getExchangeSettings();

        expect(exchange.exchangeName).to.eq(subjectExchangeSettings.exchangeName);
        expect(exchange.buyExactSpotTradeData).to.eq(subjectExchangeSettings.buyExactSpotTradeData);
        expect(exchange.sellExactSpotTradeData).to.eq(subjectExchangeSettings.sellExactSpotTradeData);
        expect(exchange.buySpotQuoteExactInputPath).to.eq(subjectExchangeSettings.buySpotQuoteExactInputPath);
        expect(exchange.twapMaxTradeSize).to.eq(subjectExchangeSettings.twapMaxTradeSize);
        expect(exchange.incentivizedTwapMaxTradeSize).to.eq(subjectExchangeSettings.incentivizedTwapMaxTradeSize);
      });

      it("should emit ExchangeSettingsUpdated event", async () => {
        await expect(subject()).to.emit(leverageStrategyExtension, "ExchangeSettingsUpdated").withArgs(
          subjectExchangeSettings.exchangeName,
          subjectExchangeSettings.buyExactSpotTradeData,
          subjectExchangeSettings.sellExactSpotTradeData,
          subjectExchangeSettings.buySpotQuoteExactInputPath,
          subjectExchangeSettings.twapMaxTradeSize,
          subjectExchangeSettings.incentivizedTwapMaxTradeSize
        );
      });

      describe("when the caller is not the operator", async () => {
        beforeEach(async () => {
          subjectCaller = await getRandomAccount();
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be operator");
        });
      });
    });

    describe("#withdrawEtherBalance", async () => {
      let etherReward: BigNumber;
      let subjectCaller: Account;

      const initializeSubjectVariables = async () => {
        etherReward = ether(0.1);
        // Send ETH to contract as reward
        await owner.wallet.sendTransaction({ to: leverageStrategyExtension.address, value: etherReward });
        subjectCaller = owner;
      };

      async function subject(): Promise<any> {
        leverageStrategyExtension = leverageStrategyExtension.connect(subjectCaller.wallet);
        return leverageStrategyExtension.withdrawEtherBalance();
      }

      describe("when rebalance is not in progress", () => {
        cacheBeforeEach(initializeRootScopeContracts);
        beforeEach(initializeSubjectVariables);

        it("should withdraw ETH balance on contract to operator", async () => {
          const previousContractEthBalance = await getEthBalance(leverageStrategyExtension.address);
          const previousOwnerEthBalance = await getEthBalance(owner.address);

          const txHash = await subject();
          const txReceipt = await provider.getTransactionReceipt(txHash.hash);
          const currentContractEthBalance = await getEthBalance(leverageStrategyExtension.address);
          const currentOwnerEthBalance = await getEthBalance(owner.address);
          const expectedOwnerEthBalance = previousOwnerEthBalance.add(etherReward).sub(txReceipt.gasUsed.mul(txHash.gasPrice));

          expect(previousContractEthBalance).to.eq(etherReward);
          expect(currentContractEthBalance).to.eq(ZERO);
          expect(expectedOwnerEthBalance).to.eq(currentOwnerEthBalance);
        });

        describe("when the caller is not the operator", async () => {
          beforeEach(async () => {
            subjectCaller = await getRandomAccount();
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Must be operator");
          });
        });
      });

      describe("when rebalance is in progress", async () => {
        let newExchangeSettings: PerpV2BasisExchangeSettings;

        beforeEach(async () => {
          await initializeRootScopeContracts();
          initializeSubjectVariables();

          newExchangeSettings = {
            ...exchange,
            twapMaxTradeSize: ether(.1),
            incentivizedTwapMaxTradeSize: ether(1)
          };
          await leverageStrategyExtension.setExchangeSettings(newExchangeSettings);
          // Engage to initial leverage
          await leverageStrategyExtension.engage();
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Rebalance is currently in progress");
        });
      });
    });

    describe("#getCurrentEtherIncentive", async () => {
      cacheBeforeEach(async () => {
        await initializeRootScopeContracts();
        // Engage to initial leverage
        await leverageStrategyExtension.engage();
        await increaseTimeAsync(BigNumber.from(100000));
      });

      async function subject(): Promise<any> {
        return leverageStrategyExtension.getCurrentEtherIncentive();
      }

      describe("when above incentivized leverage ratio", async () => {
        cacheBeforeEach(async () => {
          // Send ETHER to contract
          await owner.wallet.sendTransaction({ to: leverageStrategyExtension.address, value: ether(1) });

          // Set oracle prices
          await perpV2Setup.setBaseTokenOraclePrice(perpV2Setup.vETH, usdc(1150));
          await perpV2PriceFeedMock.setPrice(BigNumber.from(1150).mul(10 ** 8));
        });

        it("should return the correct value", async () => {
          const etherIncentive = await subject();

          expect(etherIncentive).to.eq(incentive.etherReward);
        });

        describe("when ETH balance is below ETH reward amount", async () => {
          beforeEach(async () => {
            await leverageStrategyExtension.withdrawEtherBalance();
            // Transfer 0.01 ETH to contract
            await owner.wallet.sendTransaction({ to: leverageStrategyExtension.address, value: ether(0.01) });
          });

          it("should return the correct value", async () => {
            const etherIncentive = await subject();

            expect(etherIncentive).to.eq(ether(0.01));
          });
        });
      });

      describe("when below incentivized leverage ratio", async () => {
        beforeEach(async () => {
          await perpV2Setup.setBaseTokenOraclePrice(perpV2Setup.vETH, usdc(900));
          await perpV2PriceFeedMock.setPrice(BigNumber.from(900).mul(10 ** 8));
        });

        it("should return the correct value", async () => {
          const etherIncentive = await subject();

          expect(etherIncentive).to.eq(ZERO);
        });
      });
    });

    describe("#shouldRebalance", async () => {
      let subjectCaller: Account;

      beforeEach(async () => {
        subjectCaller = owner;
      });

      cacheBeforeEach(async () => {
        await initializeRootScopeContracts();
        await leverageStrategyExtension.engage();
      });

      async function subject(): Promise<number> {
        return leverageStrategyExtension.connect(subjectCaller.wallet).shouldRebalance();
      }

      context("when in the midst of a TWAP rebalance", async () => {
        let newExchangeSettings: PerpV2BasisExchangeSettings;

        cacheBeforeEach(async () => {
          // Set up new rebalance TWAP
          await increaseTimeAsync(ONE_DAY_IN_SECONDS);
          await perpV2PriceFeedMock.setPrice(BigNumber.from(1040).mul(10 ** 8));

          newExchangeSettings = {
            ...exchange,
            twapMaxTradeSize: ether(.01),
            incentivizedTwapMaxTradeSize: ether(1)
          };
          await leverageStrategyExtension.setExchangeSettings(newExchangeSettings);

          await leverageStrategyExtension.connect(owner.wallet).rebalance();
        });

        it("should verify in TWAP rebalance", async () => {
          const twapLeverageRatio = await leverageStrategyExtension.twapLeverageRatio();
          expect(twapLeverageRatio.abs()).to.be.gt(ZERO);
        });

        describe("when above incentivized leverage ratio and incentivized TWAP cooldown has elapsed", async () => {
          beforeEach(async () => {
            // Set to above incentivized ratio
            await perpV2PriceFeedMock.setPrice(BigNumber.from(1200).mul(10 ** 8));
            await increaseTimeAsync(BigNumber.from(100));    // >60 (incentivized cooldown period)
          });

          it("should verify initial leverage conditions", async () => {
            const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();

            expect(currentLeverageRatio.abs()).to.be.gt(incentive.incentivizedLeverageRatio.abs());
          });

          it("should return ripcord", async () => {
            const shouldRebalance = await subject();

            expect(shouldRebalance).to.eq(BigNumber.from(3));
          });
        });

        describe("when below incentivized leverage ratio and regular TWAP cooldown has elapsed", async () => {
          beforeEach(async () => {
            // Set to below incentivized ratio
            await perpV2PriceFeedMock.setPrice(BigNumber.from(1050).mul(10 ** 8));
            await increaseTimeAsync(BigNumber.from(4000));    // >3000 (regular cooldown period)
          });

          it("should verify initial leverage conditions", async () => {
            const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();

            expect(currentLeverageRatio.abs()).to.be.lt(incentive.incentivizedLeverageRatio.abs());
          });

          it("should return iterate rebalance", async () => {
            const shouldRebalance = await subject();

            expect(shouldRebalance).to.eq(TWO);
          });
        });

        describe("when above incentivized leverage ratio and incentivized TWAP cooldown has NOT elapsed", async () => {
          beforeEach(async () => {
            // Set to above incentivized ratio
            await perpV2PriceFeedMock.setPrice(BigNumber.from(1200).mul(10 ** 8));
            await increaseTimeAsync(BigNumber.from(50));    // <60 (incentivized cooldown period)
          });

          it("should verify initial leverage conditions", async () => {
            const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();

            expect(currentLeverageRatio.abs()).to.be.gt(incentive.incentivizedLeverageRatio.abs());
          });

          it("should not rebalance", async () => {
            const shouldRebalance = await subject();

            expect(shouldRebalance).to.eq(ZERO);
          });
        });

        describe("when below incentivized leverage ratio and regular TWAP cooldown has NOT elapsed", async () => {
          beforeEach(async () => {
            // Set to below incentivized ratio
            await perpV2PriceFeedMock.setPrice(BigNumber.from(1020).mul(10 ** 8));
            await increaseTimeAsync(BigNumber.from(2000));    // <3000 (regular cooldown period)
          });

          it("should verify initial leverage conditions", async () => {
            const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();

            expect(currentLeverageRatio.abs()).to.be.lt(incentive.incentivizedLeverageRatio.abs());
          });

          it("should not rebalance", async () => {
            const shouldRebalance = await subject();

            expect(shouldRebalance).to.eq(ZERO);
          });
        });
      });

      context("when not in a TWAP rebalance", async () => {
        it("should verify NOT in TWAP rebalance", async () => {
          const twapLeverageRatio = await leverageStrategyExtension.twapLeverageRatio();
          expect(twapLeverageRatio).to.be.eq(ZERO);
        });

        describe("when above incentivized leverage ratio and cooldown period has elapsed", async () => {
          beforeEach(async () => {
            // Set to above incentivized ratio
            await perpV2PriceFeedMock.setPrice(BigNumber.from(1200).mul(10 ** 8));
            await increaseTimeAsync(BigNumber.from(100));
          });

          it("should verify initial leverage conditions", async () => {
            const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();

            expect(currentLeverageRatio.abs()).to.be.gt(incentive.incentivizedLeverageRatio.abs());
          });

          it("should return ripcord", async () => {
            const shouldRebalance = await subject();

            expect(shouldRebalance).to.eq(BigNumber.from(3));
          });
        });

        describe("when between max and min leverage ratio and rebalance interval has elapsed", async () => {
          beforeEach(async () => {
            await perpV2PriceFeedMock.setPrice(BigNumber.from(1010).mul(10 ** 8));
            await increaseTimeAsync(BigNumber.from(ONE_DAY_IN_SECONDS));
          });

          it("should verify initial leverage conditions", async () => {
            const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();

            expect(currentLeverageRatio.abs()).to.be.gt(methodology.minLeverageRatio.abs());
            expect(currentLeverageRatio.abs()).to.be.lt(methodology.maxLeverageRatio.abs());
          });

          it("should return rebalance", async () => {
            const shouldRebalance = await subject();

            expect(shouldRebalance).to.eq(BigNumber.from(1));
          });
        });

        describe("when above max leverage ratio but below incentivized leverage ratio", async () => {
          beforeEach(async () => {
            await perpV2PriceFeedMock.setPrice(BigNumber.from(1050).mul(10 ** 8));
            await increaseTimeAsync(BigNumber.from(ONE_DAY_IN_SECONDS));
          });

          it("should verify initial leverage conditions", async () => {
            const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();

            expect(currentLeverageRatio.abs()).to.be.gt(methodology.maxLeverageRatio.abs());
            expect(currentLeverageRatio.abs()).to.be.lt(incentive.incentivizedLeverageRatio.abs());
          });

          it("should return rebalance", async () => {
            const shouldRebalance = await subject();

            expect(shouldRebalance).to.eq(BigNumber.from(1));
          });
        });

        describe("when below min leverage ratio", async () => {
          beforeEach(async () => {
            await perpV2PriceFeedMock.setPrice(BigNumber.from(800).mul(10 ** 8));
          });

          it("should verify initial leverage conditions", async () => {
            const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();

            expect(currentLeverageRatio.abs()).to.be.lt(methodology.minLeverageRatio.abs());
          });

          it("should return rebalance", async () => {
            const shouldRebalance = await subject();

            expect(shouldRebalance).to.eq(BigNumber.from(1));
          });
        });

        describe("when above incentivized leverage ratio and incentivized TWAP cooldown has NOT elapsed", async () => {
          beforeEach(async () => {
            await perpV2PriceFeedMock.setPrice(BigNumber.from(1200).mul(10 ** 8));
          });

          it("should verify initial leverage conditions", async () => {
            const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();

            expect(currentLeverageRatio.abs()).to.be.gt(incentive.incentivizedLeverageRatio.abs());
          });

          it("should not rebalance", async () => {
            const shouldRebalance = await subject();

            expect(shouldRebalance).to.eq(ZERO);
          });
        });

        describe("when between max and min leverage ratio and both rebalance and reinvest interval has NOT elapsed", async () => {
          beforeEach(async () => {
            await perpV2PriceFeedMock.setPrice(BigNumber.from(1010).mul(10 ** 8));
          });

          it("should verify initial leverage conditions", async () => {
            const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();

            expect(currentLeverageRatio.abs()).to.be.gt(methodology.minLeverageRatio.abs());
            expect(currentLeverageRatio.abs()).to.be.lt(methodology.maxLeverageRatio.abs());
          });

          it("should not rebalance and nor reinvest", async () => {
            const shouldRebalance = await subject();

            expect(shouldRebalance).to.eq(ZERO);
          });
        });

        describe("when between max and min leverage ratio and rebalance intereval has NOT elapsed but reinvest interval has elapsed", async () => {
          let newMethodology: PerpV2BasisMethodologySettings;

          beforeEach(async () => {
            newMethodology = {
              ...methodology,
              reinvestInterval: ONE_DAY_IN_SECONDS.div(2)     // Set reinvest interval < rebalance interval
            };
            await leverageStrategyExtension.setMethodologySettings(newMethodology);
            await increaseTimeAsync(ONE_DAY_IN_SECONDS.div(2));

            await perpV2PriceFeedMock.setPrice(BigNumber.from(1010).mul(10 ** 8));
          });

          it("should verify initial conditions", async () => {
            const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();
            const reinvestInterval = (await leverageStrategyExtension.getMethodology()).reinvestInterval;
            const lastReinvestTimestamp = await leverageStrategyExtension.lastReinvestTimestamp();
            const lastBlockTimestamp = await getLastBlockTimestamp();

            expect(lastReinvestTimestamp.add(reinvestInterval)).lt(lastBlockTimestamp);
            expect(currentLeverageRatio.abs()).to.be.gt(methodology.minLeverageRatio.abs());
            expect(currentLeverageRatio.abs()).to.be.lt(methodology.maxLeverageRatio.abs());
          });

          it("should reinvest", async () => {
            const shouldRebalance = await subject();

            expect(shouldRebalance).to.eq(BigNumber.from(4));
          });
        });
      });
    });

    describe("#shouldRebalanceWithBounds", async () => {
      let subjectMinLeverageRatio: BigNumber;
      let subjectMaxLeverageRatio: BigNumber;

      cacheBeforeEach(async () => {
        await initializeRootScopeContracts();
        await leverageStrategyExtension.engage();
      });

      beforeEach(() => {
        subjectMinLeverageRatio = ether(-0.85);
        subjectMaxLeverageRatio = ether(-1.15);
      });

      async function subject(): Promise<number> {
        return leverageStrategyExtension.shouldRebalanceWithBounds(
          subjectMinLeverageRatio,
          subjectMaxLeverageRatio
        );
      }

      context("when in the midst of a TWAP rebalance", async () => {
        let newExchangeSettings: PerpV2BasisExchangeSettings;

        cacheBeforeEach(async () => {
          // Set up new rebalance TWAP
          await increaseTimeAsync(ONE_DAY_IN_SECONDS);
          await perpV2PriceFeedMock.setPrice(BigNumber.from(1040).mul(10 ** 8));

          newExchangeSettings = {
            ...exchange,
            twapMaxTradeSize: ether(.01),
            incentivizedTwapMaxTradeSize: ether(1)
          };
          await leverageStrategyExtension.setExchangeSettings(newExchangeSettings);

          await leverageStrategyExtension.connect(owner.wallet).rebalance();
        });

        it("should verify in TWAP rebalance", async () => {
          const twapLeverageRatio = await leverageStrategyExtension.twapLeverageRatio();
          expect(twapLeverageRatio.abs()).to.be.gt(ZERO);
        });

        describe("when above incentivized leverage ratio and incentivized TWAP cooldown has elapsed", async () => {
          beforeEach(async () => {
            // Set to above incentivized ratio
            await perpV2PriceFeedMock.setPrice(BigNumber.from(1200).mul(10 ** 8));
            await increaseTimeAsync(BigNumber.from(100));    // >60 (incentivized cooldown period)
          });

          it("should verify initial leverage conditions", async () => {
            const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();

            expect(currentLeverageRatio.abs()).to.be.gt(incentive.incentivizedLeverageRatio.abs());
          });

          it("should return ripcord", async () => {
            const shouldRebalance = await subject();

            expect(shouldRebalance).to.eq(BigNumber.from(3));
          });
        });

        describe("when below incentivized leverage ratio and regular TWAP cooldown has elapsed", async () => {
          beforeEach(async () => {
            // Set to below incentivized ratio
            await perpV2PriceFeedMock.setPrice(BigNumber.from(1050).mul(10 ** 8));
            await increaseTimeAsync(BigNumber.from(4000));    // >3000 (regular cooldown period)
          });

          it("should verify initial leverage conditions", async () => {
            const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();

            expect(currentLeverageRatio.abs()).to.be.lt(incentive.incentivizedLeverageRatio.abs());
          });

          it("should return iterate rebalance", async () => {
            const shouldRebalance = await subject();

            expect(shouldRebalance).to.eq(TWO);
          });
        });

        describe("when above incentivized leverage ratio and incentivized TWAP cooldown has NOT elapsed", async () => {
          beforeEach(async () => {
            // Set to above incentivized ratio
            await perpV2PriceFeedMock.setPrice(BigNumber.from(1200).mul(10 ** 8));
            await increaseTimeAsync(BigNumber.from(50));    // <60 (incentivized cooldown period)
          });

          it("should verify initial leverage conditions", async () => {
            const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();

            expect(currentLeverageRatio.abs()).to.be.gt(incentive.incentivizedLeverageRatio.abs());
          });

          it("should not rebalance", async () => {
            const shouldRebalance = await subject();

            expect(shouldRebalance).to.eq(ZERO);
          });
        });

        describe("when below incentivized leverage ratio and regular TWAP cooldown has NOT elapsed", async () => {
          beforeEach(async () => {
            // Set to below incentivized ratio
            await perpV2PriceFeedMock.setPrice(BigNumber.from(1050).mul(10 ** 8));
            await increaseTimeAsync(BigNumber.from(2000));    // <3000 (regular cooldown period)
          });

          it("should verify initial leverage conditions", async () => {
            const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();

            expect(currentLeverageRatio.abs()).to.be.lt(incentive.incentivizedLeverageRatio.abs());
          });

          it("should not rebalance", async () => {
            const shouldRebalance = await subject();

            expect(shouldRebalance).to.eq(ZERO);
          });
        });
      });

      context("when not in a TWAP rebalance", async () => {
        it("should verify NOT in TWAP rebalance", async () => {
          const twapLeverageRatio = await leverageStrategyExtension.twapLeverageRatio();
          expect(twapLeverageRatio).to.be.eq(ZERO);
        });

        describe("when above incentivized leverage ratio and cooldown period has elapsed", async () => {
          beforeEach(async () => {
            // Set to above incentivized ratio
            await perpV2PriceFeedMock.setPrice(BigNumber.from(1200).mul(10 ** 8));
            await increaseTimeAsync(BigNumber.from(100));
          });

          it("should verify initial leverage conditions", async () => {
            const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();

            expect(currentLeverageRatio.abs()).to.be.gt(incentive.incentivizedLeverageRatio.abs());
          });

          it("should return ripcord", async () => {
            const shouldRebalance = await subject();

            expect(shouldRebalance).to.eq(BigNumber.from(3));
          });
        });

        describe("when between max and min leverage ratio and rebalance interval has elapsed", async () => {
          beforeEach(async () => {
            await perpV2PriceFeedMock.setPrice(BigNumber.from(1010).mul(10 ** 8));
            await increaseTimeAsync(BigNumber.from(ONE_DAY_IN_SECONDS));
          });

          it("should verify initial leverage conditions", async () => {
            const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();

            expect(currentLeverageRatio.abs()).to.be.gt(methodology.minLeverageRatio.abs());
            expect(currentLeverageRatio.abs()).to.be.lt(methodology.maxLeverageRatio.abs());
          });

          it("should return rebalance", async () => {
            const shouldRebalance = await subject();

            expect(shouldRebalance).to.eq(BigNumber.from(1));
          });
        });

        describe("when above max leverage ratio but below incentivized leverage ratio", async () => {
          beforeEach(async () => {
            await perpV2PriceFeedMock.setPrice(BigNumber.from(1050).mul(10 ** 8));
            await increaseTimeAsync(BigNumber.from(ONE_DAY_IN_SECONDS));
          });

          it("should verify initial leverage conditions", async () => {
            const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();

            expect(currentLeverageRatio.abs()).to.be.gt(methodology.maxLeverageRatio.abs());
            expect(currentLeverageRatio.abs()).to.be.lt(incentive.incentivizedLeverageRatio.abs());
          });

          it("should return rebalance", async () => {
            const shouldRebalance = await subject();

            expect(shouldRebalance).to.eq(BigNumber.from(1));
          });
        });

        describe("when below min leverage ratio", async () => {
          beforeEach(async () => {
            await perpV2PriceFeedMock.setPrice(BigNumber.from(800).mul(10 ** 8));
          });

          it("should verify initial leverage conditions", async () => {
            const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();

            expect(currentLeverageRatio.abs()).to.be.lt(methodology.minLeverageRatio.abs());
          });

          it("should return rebalance", async () => {
            const shouldRebalance = await subject();

            expect(shouldRebalance).to.eq(BigNumber.from(1));
          });
        });

        describe("when above incentivized leverage ratio and incentivized TWAP cooldown has NOT elapsed", async () => {
          beforeEach(async () => {
            await perpV2PriceFeedMock.setPrice(BigNumber.from(1200).mul(10 ** 8));
          });

          it("should verify initial leverage conditions", async () => {
            const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();

            expect(currentLeverageRatio.abs()).to.be.gt(incentive.incentivizedLeverageRatio.abs());
          });

          it("should not ripcord", async () => {
            const shouldRebalance = await subject();

            expect(shouldRebalance).to.eq(ZERO);
          });
        });

        describe("when between max and min leverage ratio and both rebalance and reinvest interval has NOT elapsed", async () => {
          beforeEach(async () => {
            await perpV2PriceFeedMock.setPrice(BigNumber.from(1010).mul(10 ** 8));
          });

          it("should verify initial leverage conditions", async () => {
            const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();

            expect(currentLeverageRatio.abs()).to.be.gt(methodology.minLeverageRatio.abs());
            expect(currentLeverageRatio.abs()).to.be.lt(methodology.maxLeverageRatio.abs());
          });

          it("should not rebalance and nor reinvest", async () => {
            const shouldRebalance = await subject();

            expect(shouldRebalance).to.eq(ZERO);
          });
        });

        describe("when between max and min leverage ratio and rebalance intereval has NOT elapsed but reinvest interval has elapsed", async () => {
          let newMethodology: PerpV2BasisMethodologySettings;

          beforeEach(async () => {
            newMethodology = {
              ...methodology,
              reinvestInterval: ONE_DAY_IN_SECONDS.div(2)     // Set reinvest interval < rebalance interval
            };
            await leverageStrategyExtension.setMethodologySettings(newMethodology);
            await increaseTimeAsync(ONE_DAY_IN_SECONDS.div(2));

            await perpV2PriceFeedMock.setPrice(BigNumber.from(1010).mul(10 ** 8));
          });

          it("should verify initial conditions", async () => {
            const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();
            const reinvestInterval = (await leverageStrategyExtension.getMethodology()).reinvestInterval;
            const lastReinvestTimestamp = await leverageStrategyExtension.lastReinvestTimestamp();
            const lastBlockTimestamp = await getLastBlockTimestamp();

            expect(lastReinvestTimestamp.add(reinvestInterval)).lt(lastBlockTimestamp);
            expect(currentLeverageRatio.abs()).to.be.gt(methodology.minLeverageRatio.abs());
            expect(currentLeverageRatio.abs()).to.be.lt(methodology.maxLeverageRatio.abs());
          });

          it("should reinvest", async () => {
            const shouldRebalance = await subject();

            expect(shouldRebalance).to.eq(BigNumber.from(4));
          });
        });

        describe("when custom min leverage ratio is above methodology min leverage ratio", async () => {
          beforeEach(async () => {
            subjectMinLeverageRatio = ether(1.9).mul(-1);
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Custom bounds must be valid");
          });
        });

        describe("when custom max leverage ratio is below methodology max leverage ratio", async () => {
          beforeEach(async () => {
            subjectMinLeverageRatio = ether(2.2).mul(-1);
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Custom bounds must be valid");
          });
        });
      });
    });

    describe("#getChunkRebalanceNotional", async () => {
      let collateralToken: Address;

      cacheBeforeEach(async () => {
        await initializeRootScopeContracts();

        collateralToken = await perpBasisTradingModule.collateralToken();

        await leverageStrategyExtension.engage();
        await increaseTimeAsync(ONE_DAY_IN_SECONDS);
      });

      async function subject(): Promise<[BigNumber, Address, Address, Address, Address]> {
        return await leverageStrategyExtension.getChunkRebalanceNotional();
      }

      context("when in the midst of a TWAP rebalance", async () => {
        let exchangeSettings: PerpV2BasisExchangeSettings;
        let preTwapLeverageRatio: BigNumber;

        cacheBeforeEach(async () => {
          // Set up new rebalance TWAP
          await perpV2PriceFeedMock.setPrice(BigNumber.from(1040).mul(10 ** 8));

          exchangeSettings = {
            ...exchange,
            twapMaxTradeSize: ether(.01),
            incentivizedTwapMaxTradeSize: ether(1)
          };
          await leverageStrategyExtension.setExchangeSettings(exchangeSettings);

          preTwapLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();

          await leverageStrategyExtension.connect(owner.wallet).rebalance();
        });

        it("should verify in TWAP rebalance", async () => {
          const twapLeverageRatio = await leverageStrategyExtension.twapLeverageRatio();
          expect(twapLeverageRatio.abs()).to.be.gt(ZERO);
        });

        describe("when above incentivized leverage ratio", async () => {
          beforeEach(async () => {
            // Set to above incentivized ratio
            await perpV2PriceFeedMock.setPrice(BigNumber.from(1200).mul(10 ** 8));
          });

          it("should verify initial leverage conditions", async () => {
            const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();

            expect(currentLeverageRatio.abs()).to.be.gt(incentive.incentivizedLeverageRatio.abs());
          });

          it("should return correct total rebalance size, sell assets and buy assets", async () => {
            const initialPositions = await perpBasisTradingModule.getPositionNotionalInfo(setToken.address);
            const newLeverageRatio = methodology.maxLeverageRatio;
            const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();

            const [chunkRebalance, sellAssetOnPerp, buyAssetOnPerp, sellAssetOnDex, buyAssetOnDex] = await subject();

            const totalRebalanceNotional = preciseDiv(
              preciseMul(initialPositions[0].baseBalance, newLeverageRatio.sub(currentLeverageRatio)),    // numerator
              preciseMul(currentLeverageRatio, ether(1).sub(newLeverageRatio))                            // denominator
            );
            const expectedTotalRebalance = totalRebalanceNotional.abs().gt(exchangeSettings.incentivizedTwapMaxTradeSize)
              ? (
                totalRebalanceNotional.lt(ZERO)
                  ? exchangeSettings.incentivizedTwapMaxTradeSize.mul(-1)
                  : exchangeSettings.incentivizedTwapMaxTradeSize
              )
              : totalRebalanceNotional;

            expect(sellAssetOnPerp).to.eq(strategy.virtualQuoteAddress);
            expect(buyAssetOnPerp).to.eq(strategy.virtualBaseAddress);
            expect(sellAssetOnDex).to.eq(strategy.spotAssetAddress);
            expect(buyAssetOnDex).to.eq(collateralToken);
            expect(chunkRebalance).to.eq(expectedTotalRebalance);
          });
        });

        describe("when below incentivized leverage ratio", async () => {
          beforeEach(async () => {
            // Set to below incentivized ratio
            await perpV2PriceFeedMock.setPrice(BigNumber.from(1040).mul(10 ** 8));
          });

          it("should verify initial leverage conditions", async () => {
            const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();

            expect(currentLeverageRatio.abs()).to.be.lt(incentive.incentivizedLeverageRatio.abs());
          });

          it("should return correct total rebalance size, sell asset and buy asset", async () => {
            const initialPositions = await perpBasisTradingModule.getPositionNotionalInfo(setToken.address);
            const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();
            const newLeverageRatio = calculateNewLeverageRatioPerpV2Basis(
              preTwapLeverageRatio,
              methodology
            );

            const [chunkRebalance, sellAssetOnPerp, buyAssetOnPerp, sellAssetOnDex, buyAssetOnDex] = await subject();

            const totalRebalanceNotional = preciseDiv(
              preciseMul(initialPositions[0].baseBalance, newLeverageRatio.sub(currentLeverageRatio)),    // numerator
              preciseMul(currentLeverageRatio, ether(1).sub(newLeverageRatio))                            // denominator
            );
            const expectedTotalRebalance = totalRebalanceNotional.abs().gt(exchangeSettings.twapMaxTradeSize)
              ? (totalRebalanceNotional.lt(ZERO)
                ? exchangeSettings.twapMaxTradeSize.mul(-1)
                : exchangeSettings.twapMaxTradeSize
              )
              : totalRebalanceNotional;

            expect(sellAssetOnPerp).to.eq(strategy.virtualQuoteAddress);
            expect(buyAssetOnPerp).to.eq(strategy.virtualBaseAddress);
            expect(sellAssetOnDex).to.eq(strategy.spotAssetAddress);
            expect(buyAssetOnDex).to.eq(collateralToken);
            expect(chunkRebalance).to.eq(expectedTotalRebalance);
          });
        });
      });

      context("when not in a TWAP rebalance", async () => {
        describe("when above incentivized leverage ratio", async () => {
          beforeEach(async () => {
            // Set to above incentivized ratio
            await perpV2PriceFeedMock.setPrice(BigNumber.from(1200).mul(10 ** 8));
          });

          it("should verify initial leverage conditions", async () => {
            const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();

            expect(currentLeverageRatio.abs()).to.be.gt(incentive.incentivizedLeverageRatio.abs());
          });

          it("should return correct total rebalance size, sell asset and buy asset", async () => {
            const initialPositions = await perpBasisTradingModule.getPositionNotionalInfo(setToken.address);
            const newLeverageRatio = methodology.maxLeverageRatio;
            const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();

            const [chunkRebalance, sellAssetOnPerp, buyAssetOnPerp, sellAssetOnDex, buyAssetOnDex] = await subject();

            const expectedTotalRebalanceNotional = preciseDiv(
              preciseMul(initialPositions[0].baseBalance, newLeverageRatio.sub(currentLeverageRatio)),    // numerator
              preciseMul(currentLeverageRatio, ether(1).sub(newLeverageRatio))                            // denominator
            );

            expect(sellAssetOnPerp).to.eq(strategy.virtualQuoteAddress);
            expect(buyAssetOnPerp).to.eq(strategy.virtualBaseAddress);
            expect(sellAssetOnDex).to.eq(strategy.spotAssetAddress);
            expect(buyAssetOnDex).to.eq(collateralToken);
            expect(chunkRebalance).to.eq(expectedTotalRebalanceNotional);
          });
        });

        describe("when between max and min leverage ratio", async () => {
          beforeEach(async () => {
            await perpV2PriceFeedMock.setPrice(BigNumber.from(990).mul(10 ** 8));
          });

          it("should verify initial leverage conditions", async () => {
            const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();

            expect(currentLeverageRatio.abs()).to.be.gt(methodology.minLeverageRatio.abs());
            expect(currentLeverageRatio.abs()).to.be.lt(methodology.maxLeverageRatio.abs());
          });

          it("should return correct total rebalance size, sell asset and buy asset", async () => {
            const initialPositions = await perpBasisTradingModule.getPositionNotionalInfo(setToken.address);
            const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();
            const newLeverageRatio = calculateNewLeverageRatioPerpV2Basis(
              currentLeverageRatio,
              methodology
            );

            const [chunkRebalance, sellAssetOnPerp, buyAssetOnPerp, sellAssetOnDex, buyAssetOnDex] = await subject();

            const expectedTotalRebalanceNotional = preciseDiv(
              preciseMul(initialPositions[0].baseBalance, newLeverageRatio.sub(currentLeverageRatio)),    // numerator
              preciseMul(currentLeverageRatio, ether(1).sub(newLeverageRatio))                            // denominator
            );

            expect(buyAssetOnPerp).to.eq(strategy.virtualQuoteAddress);
            expect(sellAssetOnPerp).to.eq(strategy.virtualBaseAddress);
            expect(buyAssetOnDex).to.eq(strategy.spotAssetAddress);
            expect(sellAssetOnDex).to.eq(collateralToken);
            expect(chunkRebalance).to.eq(expectedTotalRebalanceNotional);
          });
        });

        describe("when above max leverage ratio but below incentivized leverage ratio", async () => {
          beforeEach(async () => {
            await perpV2PriceFeedMock.setPrice(BigNumber.from(1050).mul(10 ** 8));
          });

          it("should verify initial leverage conditions", async () => {
            const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();

            expect(currentLeverageRatio.abs()).to.be.gt(methodology.maxLeverageRatio.abs());
            expect(currentLeverageRatio.abs()).to.be.lt(incentive.incentivizedLeverageRatio.abs());
          });

          it("should return correct total rebalance size, sell asset and buy asset", async () => {
            const initialPositions = await perpBasisTradingModule.getPositionNotionalInfo(setToken.address);
            const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();
            const newLeverageRatio = calculateNewLeverageRatioPerpV2Basis(
              currentLeverageRatio,
              methodology
            );

            const [chunkRebalance, sellAssetOnPerp, buyAssetOnPerp, sellAssetOnDex, buyAssetOnDex] = await subject();

            const expectedTotalRebalanceNotional = preciseDiv(
              preciseMul(initialPositions[0].baseBalance, newLeverageRatio.sub(currentLeverageRatio)),    // numerator
              preciseMul(currentLeverageRatio, ether(1).sub(newLeverageRatio))                            // denominator
            );

            expect(buyAssetOnPerp).to.eq(strategy.virtualBaseAddress);
            expect(sellAssetOnPerp).to.eq(strategy.virtualQuoteAddress);
            expect(chunkRebalance).to.eq(expectedTotalRebalanceNotional);
            expect(sellAssetOnDex).to.eq(strategy.spotAssetAddress);
            expect(buyAssetOnDex).to.eq(collateralToken);;
          });
        });

        describe("when below min leverage ratio", async () => {
          beforeEach(async () => {
            await perpV2PriceFeedMock.setPrice(BigNumber.from(900).mul(10 ** 8));
          });

          it("should verify initial leverage conditions", async () => {
            const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();

            expect(currentLeverageRatio.abs()).to.be.lt(methodology.minLeverageRatio.abs());
          });

          it("should return correct total rebalance size, sell asset and buy asset", async () => {
            const initialPositions = await perpBasisTradingModule.getPositionNotionalInfo(setToken.address);
            const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();
            const newLeverageRatio = calculateNewLeverageRatioPerpV2Basis(
              currentLeverageRatio,
              methodology
            );

            const [chunkRebalance, sellAssetOnPerp, buyAssetOnPerp, sellAssetOnDex, buyAssetOnDex] = await subject();

            const expectedTotalRebalanceNotional = preciseDiv(
              preciseMul(initialPositions[0].baseBalance, newLeverageRatio.sub(currentLeverageRatio)),    // numerator
              preciseMul(currentLeverageRatio, ether(1).sub(newLeverageRatio))                            // denominator
            );

            expect(buyAssetOnPerp).to.eq(strategy.virtualQuoteAddress);
            expect(sellAssetOnPerp).to.eq(strategy.virtualBaseAddress);
            expect(buyAssetOnDex).to.eq(strategy.spotAssetAddress);
            expect(sellAssetOnDex).to.eq(collateralToken);
            expect(chunkRebalance).to.eq(expectedTotalRebalanceNotional);
          });
        });
      });
    });

    describe("#getCurrentLeverageRatio", async () => {

      cacheBeforeEach(initializeRootScopeContracts);

      async function subject(): Promise<BigNumber> {
        return await leverageStrategyExtension.getCurrentLeverageRatio();
      }

      describe("when account value is zero", async () => {
        it("should return zero", async () => {
          const leverageRatio = await subject();

          expect(leverageRatio).to.equal(ZERO);
        });
      });
    });
  });
});