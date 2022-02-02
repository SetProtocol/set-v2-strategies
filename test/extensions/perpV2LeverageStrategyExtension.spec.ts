import "module-alias/register";
import { BigNumber, ContractTransaction } from "ethers";
import { ethers } from "hardhat";

import {
  Address,
  Account,
  PerpV2ContractSettings,
  PerpV2MethodologySettings,
  PerpV2ExecutionSettings,
  PerpV2IncentiveSettings,
  PerpV2ExchangeSettings
} from "@utils/types";

import { ADDRESS_ZERO, ZERO, ONE_DAY_IN_SECONDS, TWO } from "../../utils/constants";
import {
  PerpV2LeverageModule,
  SetToken,
  PerpV2,
  SlippageIssuanceModule,
  ContractCallerMock
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
  calculateNewLeverageRatioPerpV2,
  calculateTotalRebalanceNotionalPerpV2
} from "../../utils/index";
import { PerpV2PriceFeedMock } from "@utils/contracts";

import { PerpV2Fixture, SystemFixture } from "@setprotocol/set-protocol-v2/utils/fixtures";
import { getPerpV2Fixture, getSystemFixture } from "@setprotocol/set-protocol-v2/utils/test";

import { BaseManager, PerpV2LeverageStrategyExtension } from "@utils/contracts/index";

const expect = getWaffleExpect();
const provider = ethers.provider;

describe("PerpV2LeverageStrategyExtension", () => {
  let owner: Account;
  let methodologist: Account;
  let maker: Account;
  let taker: Account;
  let systemSetup: SystemFixture;
  let perpV2Setup: PerpV2Fixture;

  let deployer: DeployHelper;
  let setToken: SetToken;

  let strategy: PerpV2ContractSettings;
  let methodology: PerpV2MethodologySettings;
  let execution: PerpV2ExecutionSettings;
  let incentive: PerpV2IncentiveSettings;
  let exchange: PerpV2ExchangeSettings;
  let customTargetLeverageRatio: any;
  let customMinLeverageRatio: any;
  let basePriceDecimalAdjustment: BigNumber;

  let leverageStrategyExtension: PerpV2LeverageStrategyExtension;
  let perpV2LeverageModule: PerpV2LeverageModule;
  let perpLib: PerpV2;
  let issuanceModule: SlippageIssuanceModule;
  let baseManager: BaseManager;

  let perpV2PriceFeedMock: PerpV2PriceFeedMock;

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
    perpV2Setup = getPerpV2Fixture(owner.address);
    await perpV2Setup.initialize(maker, taker);

    // set funding rate to zero; allows us to avoid calculating small amounts of funding
    // accrued in our test cases
    await perpV2Setup.clearingHouseConfig.setMaxFundingRate(ZERO);

    // Create liquidity
    await perpV2Setup.setBaseTokenOraclePrice(perpV2Setup.vETH, usdc(1000));
    // is there a way to set price tick in uni v3 dynamically
    // as the price just remains constant throughout and hence leads to a difference in the final expected leverage ratio
    await perpV2Setup.usdc.mint(perpV2Setup.maker.address, usdc(500000000000));
    await perpV2Setup.deposit(perpV2Setup.maker, BigNumber.from(500000000000), perpV2Setup.usdc);
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

    issuanceModule = await deployer.setDeployer.modules.deploySlippageIssuanceModule(
      systemSetup.controller.address
    );

    perpLib = await deployer.setDeployer.libraries.deployPerpV2();
    perpV2LeverageModule = await deployer.setDeployer.modules.deployPerpV2LeverageModule(
      systemSetup.controller.address,
      perpV2Setup.vault.address,
      perpV2Setup.quoter.address,
      perpV2Setup.marketRegistry.address,
      "contracts/protocol/integration/lib/PerpV2.sol:PerpV2",
      perpLib.address
    );

    await systemSetup.controller.addModule(issuanceModule.address);
    await systemSetup.controller.addModule(perpV2LeverageModule.address);

    await systemSetup.integrationRegistry.addIntegration(
      perpV2LeverageModule.address,
      "DefaultIssuanceModule",
      issuanceModule.address
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
        perpV2LeverageModule.address,
        issuanceModule.address
      ]
    );
    await perpV2LeverageModule.updateAnySetAllowed(true);

    // Initialize modules
    await issuanceModule.initialize(setToken.address, ether(1), ZERO, ZERO, owner.address, ADDRESS_ZERO);
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
    await perpV2LeverageModule.initialize(setToken.address);

    baseManager = await deployer.manager.deployBaseManager(
      setToken.address,
      owner.address,
      methodologist.address,
    );

    // Transfer ownership to base manager
    if ((await setToken.manager()) == owner.address) {
      await setToken.connect(owner.wallet).setManager(baseManager.address);
    }

    // Deploy adapter
    const vBaseAssetDecimals = await perpV2Setup.vETH.decimals();
    const priceFeedDecimals = await perpV2PriceFeedMock.decimals();
    basePriceDecimalAdjustment = BigNumber.from(vBaseAssetDecimals).sub(priceFeedDecimals);

    const targetLeverageRatio = customTargetLeverageRatio || ether(2);
    const minLeverageRatio = customMinLeverageRatio || ether(1.7);
    const maxLeverageRatio = ether(2.3);
    const recenteringSpeed = ether(0.05);
    const rebalanceInterval = ONE_DAY_IN_SECONDS;

    const twapMaxTradeSize = ether(20);
    const twapCooldownPeriod = BigNumber.from(3000);
    const slippageTolerance = ether(0.015);

    const incentivizedTwapMaxTradeSize = ether(25);
    const incentivizedTwapCooldownPeriod = BigNumber.from(60);
    const incentivizedSlippageTolerance = ether(0.05);
    const etherReward = ether(1);
    const incentivizedLeverageRatio = ether(2.6);

    strategy = {
      setToken: setToken.address,
      perpV2LeverageModule: perpV2LeverageModule.address,
      perpV2AccountBalance: perpV2Setup.accountBalance.address,
      baseUSDPriceOracle: perpV2PriceFeedMock.address,
      twapInterval: ZERO,
      basePriceDecimalAdjustment: basePriceDecimalAdjustment,
      virtualBaseAddress: perpV2Setup.vETH.address,
      virtualQuoteAddress: perpV2Setup.vQuote.address,
    };
    methodology = {
      targetLeverageRatio: targetLeverageRatio,
      minLeverageRatio: minLeverageRatio,
      maxLeverageRatio: maxLeverageRatio,
      recenteringSpeed: recenteringSpeed,
      rebalanceInterval: rebalanceInterval,
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
      twapMaxTradeSize: twapMaxTradeSize,
      incentivizedTwapMaxTradeSize: incentivizedTwapMaxTradeSize,
    };

    leverageStrategyExtension = await deployer.extensions.deployPerpV2LeverageStrategyExtension(
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
  };

  describe("#constructor", async () => {
    let subjectManagerAddress: Address;
    let subjectContractSettings: PerpV2ContractSettings;
    let subjectPerpV2MethodologySettings: PerpV2MethodologySettings;
    let subjectExecutionSettings: PerpV2ExecutionSettings;
    let subjectIncentiveSettings: PerpV2IncentiveSettings;
    let subjectPerpV2ExchangeSettings: PerpV2ExchangeSettings;

    cacheBeforeEach(initializeRootScopeContracts);

    beforeEach(async () => {
      subjectManagerAddress = baseManager.address;
      subjectContractSettings = {
        setToken: setToken.address,
        perpV2LeverageModule: perpV2LeverageModule.address,
        perpV2AccountBalance: perpV2Setup.accountBalance.address,
        baseUSDPriceOracle: perpV2PriceFeedMock.address,
        twapInterval: ZERO,
        basePriceDecimalAdjustment: basePriceDecimalAdjustment,
        virtualBaseAddress: perpV2Setup.vETH.address,
        virtualQuoteAddress: perpV2Setup.vQuote.address,
      };
      subjectPerpV2MethodologySettings = {
        targetLeverageRatio: ether(2),
        minLeverageRatio: ether(1.7),
        maxLeverageRatio: ether(2.3),
        recenteringSpeed: ether(0.05),
        rebalanceInterval: BigNumber.from(86400),
      };
      subjectExecutionSettings = {
        twapCooldownPeriod: BigNumber.from(120),
        slippageTolerance: ether(0.01),
      };
      subjectIncentiveSettings = {
        incentivizedTwapCooldownPeriod: BigNumber.from(60),
        incentivizedSlippageTolerance: ether(0.05),
        etherReward: ether(1),
        incentivizedLeverageRatio: ether(3.5),
      };
      subjectPerpV2ExchangeSettings = {
        twapMaxTradeSize: ether(5),
        incentivizedTwapMaxTradeSize: ether(10),
      };
    });

    async function subject(): Promise<PerpV2LeverageStrategyExtension> {
      return await deployer.extensions.deployPerpV2LeverageStrategyExtension(
        subjectManagerAddress,
        subjectContractSettings,
        subjectPerpV2MethodologySettings,
        subjectExecutionSettings,
        subjectIncentiveSettings,
        subjectPerpV2ExchangeSettings
      );
    }

    it("should set the manager address", async () => {
      const retrievedAdapter = await subject();

      const manager = await retrievedAdapter.manager();

      expect(manager).to.eq(subjectManagerAddress);
    });

    it("should set the contract addresses", async () => {
      const retrievedAdapter = await subject();
      const strategy = await retrievedAdapter.getStrategy();

      expect(strategy.setToken).to.eq(subjectContractSettings.setToken);
      expect(strategy.perpV2LeverageModule).to.eq(subjectContractSettings.perpV2LeverageModule);
      expect(strategy.perpV2AccountBalance).to.eq(subjectContractSettings.perpV2AccountBalance);
      expect(strategy.baseUSDPriceOracle).to.eq(subjectContractSettings.baseUSDPriceOracle);
      expect(strategy.twapInterval).to.eq(subjectContractSettings.twapInterval);
      expect(strategy.basePriceDecimalAdjustment).to.eq(subjectContractSettings.basePriceDecimalAdjustment);
      expect(strategy.virtualBaseAddress).to.eq(subjectContractSettings.virtualBaseAddress);
      expect(strategy.virtualQuoteAddress).to.eq(subjectContractSettings.virtualQuoteAddress);
    });

    it("should set the correct methodology parameters", async () => {
      const retrievedAdapter = await subject();
      const methodology = await retrievedAdapter.getMethodology();

      expect(methodology.targetLeverageRatio).to.eq(subjectPerpV2MethodologySettings.targetLeverageRatio);
      expect(methodology.minLeverageRatio).to.eq(subjectPerpV2MethodologySettings.minLeverageRatio);
      expect(methodology.maxLeverageRatio).to.eq(subjectPerpV2MethodologySettings.maxLeverageRatio);
      expect(methodology.recenteringSpeed).to.eq(subjectPerpV2MethodologySettings.recenteringSpeed);
      expect(methodology.rebalanceInterval).to.eq(subjectPerpV2MethodologySettings.rebalanceInterval);
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

      expect(exchange.twapMaxTradeSize).to.eq(subjectPerpV2ExchangeSettings.twapMaxTradeSize);
      expect(exchange.incentivizedTwapMaxTradeSize).to.eq(subjectPerpV2ExchangeSettings.incentivizedTwapMaxTradeSize);
    });

    describe("when min leverage ratio is 0", async () => {
      beforeEach(async () => {
        subjectPerpV2MethodologySettings.minLeverageRatio = ZERO;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be valid min leverage");
      });
    });

    describe("when min leverage ratio is above target", async () => {
      beforeEach(async () => {
        subjectPerpV2MethodologySettings.minLeverageRatio = ether(2.1);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be valid min leverage");
      });
    });

    describe("when max leverage ratio is below target", async () => {
      beforeEach(async () => {
        subjectPerpV2MethodologySettings.maxLeverageRatio = ether(1.9);
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

    describe("when incentivize leverage ratio is less than max leverage ratio", async () => {
      beforeEach(async () => {
        subjectIncentiveSettings.incentivizedLeverageRatio = ether(2.29);
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
        subjectPerpV2ExchangeSettings.twapMaxTradeSize = ZERO;
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
        const postUsdcExternalUnit = await setToken.getExternalPositionRealUnit(perpV2Setup.usdc.address, perpV2LeverageModule.address);

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

        const postUsdcExternalUnit = await setToken.getExternalPositionRealUnit(perpV2Setup.usdc.address, perpV2LeverageModule.address);
        const postUsdcDefaultUnit = await setToken.getDefaultPositionRealUnit(perpV2Setup.usdc.address);

        const totalSupply = await setToken.totalSupply();
        const expectedPostUsdcDefaultUnit = preciseDiv(preUsdcBalance, totalSupply);

        expect(postUsdcDefaultUnit).to.eq(expectedPostUsdcDefaultUnit);
        expect(postUsdcExternalUnit).to.eq(ZERO);
      });
    });

    describe("#engage", async () => {
      let subjectCaller: Account;
      let shouldDeposit: boolean = true;

      beforeEach(async () => {
        if (shouldDeposit) {
          await leverageStrategyExtension.deposit(await setToken.getDefaultPositionRealUnit(perpV2Setup.usdc.address));
        }

        subjectCaller = owner;
      });

      async function subject(): Promise<any> {
        leverageStrategyExtension = leverageStrategyExtension.connect(subjectCaller.wallet);
        return leverageStrategyExtension.engage();
      }

      context("when rebalance notional is less than max trade size", async () => {
        it("should open a base token position on Perpetual Protocol", async () => {
          const initialPositions = await perpV2LeverageModule.getPositionNotionalInfo(setToken.address);

          const currentCollateral = (await perpV2LeverageModule.getAccountInfo(setToken.address)).collateralBalance;
          const targetLeverageRatio = (await leverageStrategyExtension.getMethodology()).targetLeverageRatio;
          const basePrice = (await perpV2Setup.ethPriceFeed.latestAnswer()).div(usdc(1));

          const totalRebalanceNotional = preciseMul(currentCollateral, targetLeverageRatio).div(basePrice);

          await subject();

          const finalPositions = await perpV2LeverageModule.getPositionNotionalInfo(setToken.address);

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
          const currentCollateral = (await perpV2LeverageModule.getAccountInfo(setToken.address)).collateralBalance;
          const targetLeverageRatio = (await leverageStrategyExtension.getMethodology()).targetLeverageRatio;
          const basePrice = (await perpV2Setup.ethPriceFeed.latestAnswer()).div(usdc(1));

          const totalRebalanceNotional = preciseMul(currentCollateral, targetLeverageRatio).div(basePrice);

          await expect(subject()).to.emit(leverageStrategyExtension, "Engaged").withArgs(
            ZERO,
            methodology.targetLeverageRatio,
            totalRebalanceNotional,
            totalRebalanceNotional,
          );
        });
      });

      context("when rebalance notional is greater than max trade size", async () => {
        describe("when the collateral balance is not zero", () => {
          let newPerpV2ExchangeSettings: PerpV2ExchangeSettings;

          beforeEach(async () => {
            newPerpV2ExchangeSettings = {
              twapMaxTradeSize: ether(10),
              incentivizedTwapMaxTradeSize: ether(15),
            };
            await leverageStrategyExtension.setExchangeSettings(newPerpV2ExchangeSettings);
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

          it("should open a base token position on Perpetual Protocol", async () => {
            const initialPositions = await perpV2LeverageModule.getPositionNotionalInfo(setToken.address);

            await subject();

            const finalPositions = await perpV2LeverageModule.getPositionNotionalInfo(setToken.address);

            expect(initialPositions.length).to.eq(0);
            expect(finalPositions.length).to.eq(1);
            expect(finalPositions[0].baseBalance).to.eq(newPerpV2ExchangeSettings.twapMaxTradeSize);
            expect(finalPositions[0].baseToken).to.eq(strategy.virtualBaseAddress);
          });

          it("should emit Engaged event", async () => {
            const currentCollateral = (await perpV2LeverageModule.getAccountInfo(setToken.address)).collateralBalance;
            const basePrice = (await perpV2Setup.ethPriceFeed.latestAnswer()).div(usdc(1));

            const chunkRebalanceNotional = newPerpV2ExchangeSettings.twapMaxTradeSize;
            const totalRebalanceNotional = preciseMul(currentCollateral, methodology.targetLeverageRatio).div(basePrice);

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

        describe("when collateral balance is zero", async () => {
          before(async () => {
            shouldDeposit = false;
          });

          after(async () => {
            shouldDeposit = true;
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Collateral balance must be > 0");
          });
        });
      });

      context("when engaging a short position", async () => {
        let newMethodologySettings: PerpV2MethodologySettings;

        beforeEach(async () => {
          newMethodologySettings = {
            targetLeverageRatio: ether(2).mul(-1),
            minLeverageRatio: ether(1.5).mul(-1),
            maxLeverageRatio: ether(2.5).mul(-1),
            recenteringSpeed: ether(0.1),
            rebalanceInterval: BigNumber.from(43200),
          };
          await leverageStrategyExtension.setMethodologySettings(newMethodologySettings);
        });

        it("should open a base token position on Perpetual Protocol", async () => {
          const initialPositions = await perpV2LeverageModule.getPositionNotionalInfo(setToken.address);

          const currentCollateral = (await perpV2LeverageModule.getAccountInfo(setToken.address)).collateralBalance;
          const targetLeverageRatio = (await leverageStrategyExtension.getMethodology()).targetLeverageRatio;
          const basePrice = (await perpV2Setup.ethPriceFeed.latestAnswer()).div(usdc(1));

          const totalRebalanceNotional = preciseMul(currentCollateral, targetLeverageRatio).div(basePrice);

          await subject();

          const finalPositions = await perpV2LeverageModule.getPositionNotionalInfo(setToken.address);

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
          const currentCollateral = (await perpV2LeverageModule.getAccountInfo(setToken.address)).collateralBalance;
          const targetLeverageRatio = (await leverageStrategyExtension.getMethodology()).targetLeverageRatio;
          const basePrice = (await perpV2Setup.ethPriceFeed.latestAnswer()).div(usdc(1));

          const totalRebalanceNotional = preciseMul(currentCollateral, targetLeverageRatio).div(basePrice);

          await expect(subject()).to.emit(leverageStrategyExtension, "Engaged").withArgs(
            ZERO,
            newMethodologySettings.targetLeverageRatio,
            totalRebalanceNotional,
            totalRebalanceNotional,
          );
        });

        describe("when rebalance notional is greater than max trade size ", async () => {
          let newPerpV2ExchangeSettings: PerpV2ExchangeSettings;

          beforeEach(async () => {
            newPerpV2ExchangeSettings = {
              twapMaxTradeSize: ether(10),
              incentivizedTwapMaxTradeSize: ether(15),
            };
            await leverageStrategyExtension.setExchangeSettings(newPerpV2ExchangeSettings);
          });

          it("should open a base token position on Perpetual Protocol", async () => {
            const initialPositions = await perpV2LeverageModule.getPositionNotionalInfo(setToken.address);

            const totalRebalanceNotional = newPerpV2ExchangeSettings.twapMaxTradeSize.mul(-1);

            await subject();

            const finalPositions = await perpV2LeverageModule.getPositionNotionalInfo(setToken.address);

            expect(initialPositions.length).to.eq(0);
            expect(finalPositions.length).to.eq(1);
            expect(finalPositions[0].baseBalance).to.eq(totalRebalanceNotional);
            expect(finalPositions[0].baseToken).to.eq(strategy.virtualBaseAddress);
          });

          it("should set the TWAP leverage ratio", async () => {
            await subject();

            const twapLeverageRatio = await leverageStrategyExtension.twapLeverageRatio();

            expect(twapLeverageRatio).to.eq(newMethodologySettings.targetLeverageRatio);
          });

          it("should emit Engaged event", async () => {
            const currentCollateral = (await perpV2LeverageModule.getAccountInfo(setToken.address)).collateralBalance;
            const targetLeverageRatio = (await leverageStrategyExtension.getMethodology()).targetLeverageRatio;
            const basePrice = (await perpV2Setup.ethPriceFeed.latestAnswer()).div(usdc(1));

            const chunkRebalanceNotional = newPerpV2ExchangeSettings.twapMaxTradeSize.mul(-1);
            const totalRebalanceNotional = preciseMul(currentCollateral, targetLeverageRatio).div(basePrice);

            await expect(subject()).to.emit(leverageStrategyExtension, "Engaged").withArgs(
              ZERO,
              newMethodologySettings.targetLeverageRatio,
              chunkRebalanceNotional,
              totalRebalanceNotional,
            );
          });
        });
      });
    });

    describe("#rebalance", async () => {
      let subjectCaller: Account;

      cacheBeforeEach(async () => {
        await leverageStrategyExtension.deposit(await setToken.getDefaultPositionRealUnit(perpV2Setup.usdc.address));
        await leverageStrategyExtension.updateCallerStatus([owner.address], [true]);
      });

      beforeEach(async () => {
        subjectCaller = owner;
      });

      async function subject(): Promise<any> {
        return leverageStrategyExtension.connect(subjectCaller.wallet).rebalance();
      }

      context("when rebalancing a long position", async () => {
        cacheBeforeEach(async () => {
          await leverageStrategyExtension.engage();
        });

        describe("when current leverage ratio is below target (lever), does not need a TWAP, and is inside bounds", async () => {
          cacheBeforeEach(async () => {
            await perpV2Setup.setBaseTokenOraclePrice(perpV2Setup.vETH, usdc(1100));
            await perpV2PriceFeedMock.setPrice(BigNumber.from(1100).mul(10 ** 8));

            await increaseTimeAsync(ONE_DAY_IN_SECONDS);
          });

          it("should verify initial leverage conditions", async () => {
            const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();
            expect(currentLeverageRatio).to.be.gt(methodology.minLeverageRatio);
            expect(currentLeverageRatio).to.be.lt(methodology.targetLeverageRatio);
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

          it("should update the baseToken position on the SetToken correctly", async () => {
            const initialPositions = await perpV2LeverageModule.getPositionNotionalInfo(setToken.address);
            const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();

            const expectedNewLeverageRatio = calculateNewLeverageRatioPerpV2(
              currentLeverageRatio,
              methodology.targetLeverageRatio,
              methodology.minLeverageRatio,
              methodology.maxLeverageRatio,
              methodology.recenteringSpeed
            );

            await subject();

            const newPositions = await perpV2LeverageModule.getPositionUnitInfo(setToken.address);
            const updatedPosition = newPositions[0];

            const totalRebalanceNotional = preciseMul(
              preciseDiv(expectedNewLeverageRatio.sub(currentLeverageRatio), currentLeverageRatio),
              initialPositions[0].baseBalance
            );

            const totalSupply = await setToken.totalSupply();
            const expectedNewPositionUnit = preciseDiv(initialPositions[0].baseBalance.add(totalRebalanceNotional), totalSupply);

            expect(initialPositions.length).to.eq(1);
            expect(newPositions.length).to.eq(1);
            expect(updatedPosition.baseToken).to.eq(perpV2Setup.vETH.address);
            expect(updatedPosition.baseUnit).to.eq(expectedNewPositionUnit);
          });

          it("should emit Rebalanced event", async () => {
            const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();
            const expectedNewLeverageRatio = calculateNewLeverageRatioPerpV2(
              currentLeverageRatio,
              methodology.targetLeverageRatio,
              methodology.minLeverageRatio,
              methodology.maxLeverageRatio,
              methodology.recenteringSpeed
            );

            const initialPositions = await perpV2LeverageModule.getPositionNotionalInfo(setToken.address);
            const totalRebalanceNotional = preciseMul(
              preciseDiv(expectedNewLeverageRatio.sub(currentLeverageRatio), currentLeverageRatio),
              initialPositions[0].baseBalance
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
            await perpV2Setup.setBaseTokenOraclePrice(perpV2Setup.vETH, usdc(1250));
            await perpV2PriceFeedMock.setPrice(BigNumber.from(1250).mul(10 ** 8));
          });

          it("should verify initial leverage conditions", async () => {
            const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();
            expect(currentLeverageRatio).to.be.lt(methodology.minLeverageRatio);
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
            const initialPositions = await perpV2LeverageModule.getPositionNotionalInfo(setToken.address);

            const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();

            await subject();

            const expectedNewLeverageRatio = calculateNewLeverageRatioPerpV2(
              currentLeverageRatio,
              methodology.targetLeverageRatio,
              methodology.minLeverageRatio,
              methodology.maxLeverageRatio,
              methodology.recenteringSpeed
            );

            const newPositions = await perpV2LeverageModule.getPositionUnitInfo(setToken.address);
            const updatedPosition = newPositions[0];

            const totalRebalanceNotional = preciseMul(
              preciseDiv(expectedNewLeverageRatio.sub(currentLeverageRatio), currentLeverageRatio),
              initialPositions[0].baseBalance
            );

            const totalSupply = await setToken.totalSupply();
            const expectedNewPositionUnit = preciseDiv(initialPositions[0].baseBalance.add(totalRebalanceNotional), totalSupply);

            expect(initialPositions.length).to.eq(1);
            expect(newPositions.length).to.eq(1);
            expect(updatedPosition.baseToken).to.eq(perpV2Setup.vETH.address);
            expect(updatedPosition.baseUnit).to.eq(expectedNewPositionUnit);
          });
        });

        describe("when rebalance interval has not elapsed below min leverage ratio and greater than max trade size", async () => {
          let newSettings: PerpV2ExchangeSettings;

          cacheBeforeEach(async () => {
            await perpV2Setup.setBaseTokenOraclePrice(perpV2Setup.vETH, usdc(1500));
            await perpV2PriceFeedMock.setPrice(BigNumber.from(1500).mul(10 ** 8));

            newSettings = {
              twapMaxTradeSize: ether(1),
              incentivizedTwapMaxTradeSize: ether(2),
            };
            await leverageStrategyExtension.setExchangeSettings(newSettings);
          });

          it("should verify initial leverage conditions", async () => {
            const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();
            expect(currentLeverageRatio).to.be.lt(methodology.minLeverageRatio);
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

            const expectedNewLeverageRatio = calculateNewLeverageRatioPerpV2(
              currentLeverageRatio,
              methodology.targetLeverageRatio,
              methodology.minLeverageRatio,
              methodology.maxLeverageRatio,
              methodology.recenteringSpeed
            );
            expect(previousTwapLeverageRatio).to.eq(ZERO);
            expect(currentTwapLeverageRatio).to.eq(expectedNewLeverageRatio);
          });

          it("should update the baseToken position on the SetToken correctly", async () => {
            const initialPositions = await perpV2LeverageModule.getPositionNotionalInfo(setToken.address);

            await subject();

            const newPositions = await perpV2LeverageModule.getPositionUnitInfo(setToken.address);
            const updatedPosition = newPositions[0];
            const totalSupply = await setToken.totalSupply();

            const expectedNewPositionUnit = preciseDiv(initialPositions[0].baseBalance.add(newSettings.twapMaxTradeSize), totalSupply);

            expect(initialPositions.length).to.eq(1);
            expect(newPositions.length).to.eq(1);
            expect(updatedPosition.baseToken).to.eq(perpV2Setup.vETH.address);
            expect(updatedPosition.baseUnit).to.eq(expectedNewPositionUnit);
          });
        });

        describe("when rebalance interval has not elapsed and within bounds", async () => {
          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Cooldown not elapsed or not valid leverage ratio");
          });
        });

        describe("when current leverage ratio is above target (delever)", async () => {
          cacheBeforeEach(async () => {
            await perpV2PriceFeedMock.setPrice(BigNumber.from(950).mul(10 ** 8));
            await perpV2Setup.setBaseTokenOraclePrice(perpV2Setup.vETH, usdc(950));

            await increaseTimeAsync(ONE_DAY_IN_SECONDS);
          });

          it("should verify initial leverage conditions", async () => {
            const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();
            expect(currentLeverageRatio).to.be.gt(methodology.targetLeverageRatio);
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
            const initialPositions = await perpV2LeverageModule.getPositionNotionalInfo(setToken.address);

            const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();

            await subject();

            const expectedNewLeverageRatio = calculateNewLeverageRatioPerpV2(
              currentLeverageRatio,
              methodology.targetLeverageRatio,
              methodology.minLeverageRatio,
              methodology.maxLeverageRatio,
              methodology.recenteringSpeed
            );

            const newPositions = await perpV2LeverageModule.getPositionUnitInfo(setToken.address);
            const updatedPosition = newPositions[0];

            const totalRebalanceNotional = preciseMul(
              preciseDiv(expectedNewLeverageRatio.sub(currentLeverageRatio), currentLeverageRatio),
              initialPositions[0].baseBalance
            );

            const totalSupply = await setToken.totalSupply();
            const expectedNewPositionUnit = preciseDiv(initialPositions[0].baseBalance.add(totalRebalanceNotional), totalSupply);

            expect(initialPositions.length).to.eq(1);
            expect(newPositions.length).to.eq(1);
            expect(updatedPosition.baseToken).to.eq(perpV2Setup.vETH.address);
            expect(updatedPosition.baseUnit).to.closeTo(expectedNewPositionUnit, 1);
          });
        });

        describe("when rebalance interval has not elapsed, above max leverage ratio and lower than max trade size", async () => {
          cacheBeforeEach(async () => {
            await perpV2Setup.setBaseTokenOraclePrice(perpV2Setup.vETH, usdc(850));
            await perpV2PriceFeedMock.setPrice(BigNumber.from(850).mul(10 ** 8));
          });

          it("should verify initial leverage conditions", async () => {
            const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();
            expect(currentLeverageRatio).to.be.gt(methodology.maxLeverageRatio);
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
            const initialPositions = await perpV2LeverageModule.getPositionNotionalInfo(setToken.address);
            const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();

            await subject();

            const expectedNewLeverageRatio = calculateNewLeverageRatioPerpV2(
              currentLeverageRatio,
              methodology.targetLeverageRatio,
              methodology.minLeverageRatio,
              methodology.maxLeverageRatio,
              methodology.recenteringSpeed
            );

            const newPositions = await perpV2LeverageModule.getPositionUnitInfo(setToken.address);
            const updatedPosition = newPositions[0];

            const totalRebalanceNotional = preciseMul(
              preciseDiv(expectedNewLeverageRatio.sub(currentLeverageRatio), currentLeverageRatio),
              initialPositions[0].baseBalance
            );
            const totalSupply = await setToken.totalSupply();
            const expectedNewPositionUnit = preciseDiv(initialPositions[0].baseBalance.add(totalRebalanceNotional), totalSupply);


            expect(initialPositions.length).to.eq(1);
            expect(newPositions.length).to.eq(1);
            expect(perpV2Setup.vETH.address).to.eq(updatedPosition.baseToken);
            expect(expectedNewPositionUnit).to.closeTo(updatedPosition.baseUnit, 1);
          });
        });

        describe("when rebalance interval has not elapsed, above max leverage ratio and greater than max trade size", async () => {
          let newSettings: PerpV2ExchangeSettings;

          cacheBeforeEach(async () => {
            await perpV2Setup.setBaseTokenOraclePrice(perpV2Setup.vETH, usdc(850));
            await perpV2PriceFeedMock.setPrice(BigNumber.from(850).mul(10 ** 8));

            newSettings = {
              twapMaxTradeSize: ether(1),
              incentivizedTwapMaxTradeSize: ether(2),
            };
            await leverageStrategyExtension.setExchangeSettings(newSettings);
          });

          it("should verify initial leverage conditions", async () => {
            const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();
            expect(currentLeverageRatio).to.be.gt(methodology.maxLeverageRatio);
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

            const expectedNewLeverageRatio = calculateNewLeverageRatioPerpV2(
              currentLeverageRatio,
              methodology.targetLeverageRatio,
              methodology.minLeverageRatio,
              methodology.maxLeverageRatio,
              methodology.recenteringSpeed
            );
            expect(ZERO).to.eq(previousTwapLeverageRatio);
            expect(expectedNewLeverageRatio).to.eq(currentTwapLeverageRatio);
          });

          it("should update the baseToken position on the SetToken correctly", async () => {
            const initialPositions = await perpV2LeverageModule.getPositionNotionalInfo(setToken.address);

            await subject();

            const newPositions = await perpV2LeverageModule.getPositionUnitInfo(setToken.address);
            const updatedPosition = newPositions[0];
            const totalSupply = await setToken.totalSupply();

            const expectedNewPositionUnit = preciseDiv(initialPositions[0].baseBalance.sub(newSettings.twapMaxTradeSize), totalSupply);

            expect(initialPositions.length).to.eq(1);
            expect(newPositions.length).to.eq(1);
            expect(perpV2Setup.vETH.address).to.eq(updatedPosition.baseToken);
            expect(expectedNewPositionUnit).to.eq(updatedPosition.baseUnit);
          });
        });

        describe("when in a TWAP rebalance", async () => {
          let newSettings: PerpV2ExchangeSettings;

          beforeEach(async () => {
            // Setup a TWAP rebalance
            await perpV2Setup.setBaseTokenOraclePrice(perpV2Setup.vETH, usdc(1500));
            await perpV2PriceFeedMock.setPrice(BigNumber.from(1500).mul(10 ** 8));
            newSettings = {
              twapMaxTradeSize: ether(0.01),
              incentivizedTwapMaxTradeSize: ether(2),
            };
            await leverageStrategyExtension.setExchangeSettings(newSettings);

            await subject();
            await increaseTimeAsync(ONE_DAY_IN_SECONDS);
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Must call iterate");
          });
        });

        describe("when caller is not an allowed trader", async () => {
          beforeEach(async () => {
            subjectCaller = await getRandomAccount();
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Address not permitted to call");
          });
        });

        describe("when caller is a contract", async () => {
          let subjectTarget: Address;
          let subjectCallData: string;
          let subjectValue: BigNumber;

          let contractCaller: ContractCallerMock;

          beforeEach(async () => {
            contractCaller = await deployer.mocks.deployContractCallerMock();

            subjectTarget = leverageStrategyExtension.address;
            subjectCallData = leverageStrategyExtension.interface.encodeFunctionData("rebalance");
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

      context("when rebalancing a short position", async () => {
        let newMethodologySettings: PerpV2MethodologySettings;

        cacheBeforeEach(async () => {
          newMethodologySettings = {
            targetLeverageRatio: methodology.targetLeverageRatio.mul(-1),
            minLeverageRatio: methodology.minLeverageRatio.mul(-1),
            maxLeverageRatio: methodology.maxLeverageRatio.mul(-1),
            recenteringSpeed: methodology.recenteringSpeed,
            rebalanceInterval: methodology.rebalanceInterval,
          };
          await leverageStrategyExtension.setMethodologySettings(newMethodologySettings);

          // Engage short position
          await leverageStrategyExtension.engage();
        });

        context("when current leverage ratio is below target (lever), does not need a TWAP, and is inside bounds", async () => {
          cacheBeforeEach(async () => {
            await perpV2Setup.setBaseTokenOraclePrice(perpV2Setup.vETH, usdc(990));
            await perpV2PriceFeedMock.setPrice(BigNumber.from(990).mul(10 ** 8));

            await increaseTimeAsync(ONE_DAY_IN_SECONDS);
          });

          it("should verify initial leverage conditions", async () => {
            const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();
            expect(currentLeverageRatio.abs()).to.be.gt(newMethodologySettings.minLeverageRatio.abs());
            expect(currentLeverageRatio.abs()).to.be.lt(newMethodologySettings.targetLeverageRatio.abs());
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

          it("should update the baseToken position on the SetToken correctly", async () => {
            const initialPositions = await perpV2LeverageModule.getPositionNotionalInfo(setToken.address);
            const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();

            const expectedNewLeverageRatio = calculateNewLeverageRatioPerpV2(
              currentLeverageRatio,
              newMethodologySettings.targetLeverageRatio,
              newMethodologySettings.minLeverageRatio,
              newMethodologySettings.maxLeverageRatio,
              newMethodologySettings.recenteringSpeed
            );

            await subject();

            const newPositions = await perpV2LeverageModule.getPositionUnitInfo(setToken.address);
            const updatedPosition = newPositions[0];

            const totalRebalanceNotional = preciseMul(
              preciseDiv(expectedNewLeverageRatio.sub(currentLeverageRatio), currentLeverageRatio),
              initialPositions[0].baseBalance
            );

            const totalSupply = await setToken.totalSupply();
            const expectedNewPositionUnit = preciseDiv(initialPositions[0].baseBalance.add(totalRebalanceNotional), totalSupply);

            expect(initialPositions.length).to.eq(1);
            expect(newPositions.length).to.eq(1);
            expect(updatedPosition.baseToken).to.eq(perpV2Setup.vETH.address);
            expect(updatedPosition.baseUnit).to.eq(expectedNewPositionUnit);
          });

          it("should emit Rebalanced event", async () => {
            const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();
            const expectedNewLeverageRatio = calculateNewLeverageRatioPerpV2(
              currentLeverageRatio,
              newMethodologySettings.targetLeverageRatio,
              newMethodologySettings.minLeverageRatio,
              newMethodologySettings.maxLeverageRatio,
              newMethodologySettings.recenteringSpeed
            );

            const initialPositions = await perpV2LeverageModule.getPositionNotionalInfo(setToken.address);
            const totalRebalanceNotional = preciseMul(
              preciseDiv(expectedNewLeverageRatio.sub(currentLeverageRatio), currentLeverageRatio),
              initialPositions[0].baseBalance
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
            expect(currentLeverageRatio.abs()).to.be.lt(newMethodologySettings.minLeverageRatio.abs());
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
            const initialPositions = await perpV2LeverageModule.getPositionNotionalInfo(setToken.address);

            const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();

            await subject();

            const expectedNewLeverageRatio = calculateNewLeverageRatioPerpV2(
              currentLeverageRatio,
              newMethodologySettings.targetLeverageRatio,
              newMethodologySettings.minLeverageRatio,
              newMethodologySettings.maxLeverageRatio,
              newMethodologySettings.recenteringSpeed
            );

            const newPositions = await perpV2LeverageModule.getPositionUnitInfo(setToken.address);
            const updatedPosition = newPositions[0];

            const totalRebalanceNotional = preciseMul(
              preciseDiv(expectedNewLeverageRatio.sub(currentLeverageRatio), currentLeverageRatio),
              initialPositions[0].baseBalance
            );

            const totalSupply = await setToken.totalSupply();
            const expectedNewPositionUnit = preciseDiv(initialPositions[0].baseBalance.add(totalRebalanceNotional), totalSupply);

            expect(initialPositions.length).to.eq(1);
            expect(newPositions.length).to.eq(1);
            expect(updatedPosition.baseToken).to.eq(perpV2Setup.vETH.address);
            expect(updatedPosition.baseUnit).to.eq(expectedNewPositionUnit);
          });
        });

        describe("when rebalance interval has not elapsed below min leverage ratio and greater than max trade size", async () => {
          let newExchangeSettings: PerpV2ExchangeSettings;

          cacheBeforeEach(async () => {
            await perpV2Setup.setBaseTokenOraclePrice(perpV2Setup.vETH, usdc(900));
            await perpV2PriceFeedMock.setPrice(BigNumber.from(900).mul(10 ** 8));

            newExchangeSettings = {
              twapMaxTradeSize: ether(1),
              incentivizedTwapMaxTradeSize: ether(2),
            };
            await leverageStrategyExtension.setExchangeSettings(newExchangeSettings);
          });

          it("should verify initial leverage conditions", async () => {
            const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();
            expect(currentLeverageRatio.abs()).to.be.lt(newMethodologySettings.minLeverageRatio.abs());
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

            const expectedNewLeverageRatio = calculateNewLeverageRatioPerpV2(
              currentLeverageRatio,
              newMethodologySettings.targetLeverageRatio,
              newMethodologySettings.minLeverageRatio,
              newMethodologySettings.maxLeverageRatio,
              newMethodologySettings.recenteringSpeed
            );
            expect(previousTwapLeverageRatio).to.eq(ZERO);
            expect(currentTwapLeverageRatio).to.eq(expectedNewLeverageRatio);
          });

          it("should update the baseToken position on the SetToken correctly", async () => {
            const initialPositions = await perpV2LeverageModule.getPositionNotionalInfo(setToken.address);

            await subject();

            const newPositions = await perpV2LeverageModule.getPositionUnitInfo(setToken.address);
            const updatedPosition = newPositions[0];
            const totalSupply = await setToken.totalSupply();

            // subtract since shorting
            const expectedNewPositionUnit = preciseDiv(initialPositions[0].baseBalance.sub(newExchangeSettings.twapMaxTradeSize), totalSupply);

            expect(initialPositions.length).to.eq(1);
            expect(newPositions.length).to.eq(1);
            expect(updatedPosition.baseToken).to.eq(perpV2Setup.vETH.address);
            expect(updatedPosition.baseUnit).to.eq(expectedNewPositionUnit);
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
            expect(currentLeverageRatio.abs()).to.be.gt(newMethodologySettings.targetLeverageRatio.abs());
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
            const initialPositions = await perpV2LeverageModule.getPositionNotionalInfo(setToken.address);

            const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();

            await subject();

            const expectedNewLeverageRatio = calculateNewLeverageRatioPerpV2(
              currentLeverageRatio,
              newMethodologySettings.targetLeverageRatio,
              newMethodologySettings.minLeverageRatio,
              newMethodologySettings.maxLeverageRatio,
              newMethodologySettings.recenteringSpeed
            );

            const newPositions = await perpV2LeverageModule.getPositionUnitInfo(setToken.address);
            const updatedPosition = newPositions[0];

            const totalRebalanceNotional = preciseMul(
              preciseDiv(expectedNewLeverageRatio.sub(currentLeverageRatio), currentLeverageRatio),
              initialPositions[0].baseBalance
            );

            const totalSupply = await setToken.totalSupply();
            const expectedNewPositionUnit = preciseDiv(initialPositions[0].baseBalance.add(totalRebalanceNotional), totalSupply);

            expect(initialPositions.length).to.eq(1);
            expect(newPositions.length).to.eq(1);
            expect(updatedPosition.baseToken).to.eq(perpV2Setup.vETH.address);
            expect(updatedPosition.baseUnit).to.closeTo(expectedNewPositionUnit, 1);
          });
        });

        describe("when rebalance interval has not elapsed, above max leverage ratio and lower than max trade size", async () => {
          cacheBeforeEach(async () => {
            await perpV2Setup.setBaseTokenOraclePrice(perpV2Setup.vETH, usdc(1060));
            await perpV2PriceFeedMock.setPrice(BigNumber.from(1060).mul(10 ** 8));
          });

          it("should verify initial leverage conditions", async () => {
            const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();
            expect(currentLeverageRatio.abs()).to.be.gt(newMethodologySettings.maxLeverageRatio.abs());
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
            const initialPositions = await perpV2LeverageModule.getPositionNotionalInfo(setToken.address);
            const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();

            await subject();

            const expectedNewLeverageRatio = calculateNewLeverageRatioPerpV2(
              currentLeverageRatio,
              newMethodologySettings.targetLeverageRatio,
              newMethodologySettings.minLeverageRatio,
              newMethodologySettings.maxLeverageRatio,
              newMethodologySettings.recenteringSpeed
            );

            const newPositions = await perpV2LeverageModule.getPositionUnitInfo(setToken.address);
            const updatedPosition = newPositions[0];

            const totalRebalanceNotional = preciseMul(
              preciseDiv(expectedNewLeverageRatio.sub(currentLeverageRatio), currentLeverageRatio),
              initialPositions[0].baseBalance
            );
            const totalSupply = await setToken.totalSupply();
            const expectedNewPositionUnit = preciseDiv(initialPositions[0].baseBalance.add(totalRebalanceNotional), totalSupply);


            expect(initialPositions.length).to.eq(1);
            expect(newPositions.length).to.eq(1);
            expect(perpV2Setup.vETH.address).to.eq(updatedPosition.baseToken);
            expect(expectedNewPositionUnit).to.closeTo(updatedPosition.baseUnit, 1);
          });
        });

        describe("when rebalance interval has not elapsed, above max leverage ratio and greater than max trade size", async () => {
          let newSettings: PerpV2ExchangeSettings;

          cacheBeforeEach(async () => {
            await perpV2Setup.setBaseTokenOraclePrice(perpV2Setup.vETH, usdc(1060));
            await perpV2PriceFeedMock.setPrice(BigNumber.from(1060).mul(10 ** 8));

            newSettings = {
              twapMaxTradeSize: ether(1),
              incentivizedTwapMaxTradeSize: ether(2),
            };
            await leverageStrategyExtension.setExchangeSettings(newSettings);
          });

          it("should verify initial leverage conditions", async () => {
            const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();
            expect(currentLeverageRatio.abs()).to.be.gt(newMethodologySettings.maxLeverageRatio.abs());
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

            const expectedNewLeverageRatio = calculateNewLeverageRatioPerpV2(
              currentLeverageRatio,
              newMethodologySettings.targetLeverageRatio,
              newMethodologySettings.minLeverageRatio,
              newMethodologySettings.maxLeverageRatio,
              newMethodologySettings.recenteringSpeed
            );
            expect(ZERO).to.eq(previousTwapLeverageRatio);
            expect(expectedNewLeverageRatio).to.eq(currentTwapLeverageRatio);
          });

          it("should update the baseToken position on the SetToken correctly", async () => {
            const initialPositions = await perpV2LeverageModule.getPositionNotionalInfo(setToken.address);

            await subject();

            const newPositions = await perpV2LeverageModule.getPositionUnitInfo(setToken.address);
            const updatedPosition = newPositions[0];
            const totalSupply = await setToken.totalSupply();

            // Add since delevering
            const expectedNewPositionUnit = preciseDiv(initialPositions[0].baseBalance.add(newSettings.twapMaxTradeSize), totalSupply);

            expect(initialPositions.length).to.eq(1);
            expect(newPositions.length).to.eq(1);
            expect(perpV2Setup.vETH.address).to.eq(updatedPosition.baseToken);
            expect(expectedNewPositionUnit).to.eq(updatedPosition.baseUnit);
          });
        });

        describe("when in a TWAP rebalance", async () => {
          let newSettings: PerpV2ExchangeSettings;

          beforeEach(async () => {
            // Setup a TWAP rebalance
            await perpV2Setup.setBaseTokenOraclePrice(perpV2Setup.vETH, usdc(800));
            await perpV2PriceFeedMock.setPrice(BigNumber.from(800).mul(10 ** 8));
            newSettings = {
              twapMaxTradeSize: ether(0.01),
              incentivizedTwapMaxTradeSize: ether(2),
            };
            await leverageStrategyExtension.setExchangeSettings(newSettings);

            await subject();
            await increaseTimeAsync(ONE_DAY_IN_SECONDS);
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Must call iterate");
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

      cacheBeforeEach(async () => {
        await leverageStrategyExtension.deposit(await setToken.getDefaultPositionRealUnit(perpV2Setup.usdc.address));
        await leverageStrategyExtension.updateCallerStatus([owner.address], [true]);
      });

      beforeEach(async () => {
        subjectCaller = owner;
      });

      async function subject(): Promise<any> {
        return leverageStrategyExtension.connect(subjectCaller.wallet).iterateRebalance();
      }

      context("when rebalancing long position", async () => {
        cacheBeforeEach(async () => {
          await leverageStrategyExtension.engage();
        });

        context("when currently in the last chunk of a TWAP rebalance", async () => {
          let newExchangeSettings: PerpV2ExchangeSettings;

          cacheBeforeEach(async () => {
            await increaseTimeAsync(ONE_DAY_IN_SECONDS);
            await perpV2Setup.setBaseTokenOraclePrice(perpV2Setup.vETH, usdc(1340));
            await perpV2PriceFeedMock.setPrice(BigNumber.from(1340).mul(10 ** 8));

            newExchangeSettings = {
              twapMaxTradeSize: ether(1),
              incentivizedTwapMaxTradeSize: ether(1)
            };
            await leverageStrategyExtension.setExchangeSettings(newExchangeSettings);

            await leverageStrategyExtension.connect(owner.wallet).rebalance();
            await increaseTimeAsync(BigNumber.from(4000));    // >3s (twapCoolDown period)
          });

          it("should verify initial leverage conditions", async () => {
            const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();
            const twapLeverageRatio = await leverageStrategyExtension.twapLeverageRatio();

            expect(currentLeverageRatio).to.be.lt(methodology.minLeverageRatio);
            expect(twapLeverageRatio).to.be.eq(methodology.minLeverageRatio);
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

          it("should update the baseToken position on the SetToken correctly", async () => {
            const initialPositions = await perpV2LeverageModule.getPositionNotionalInfo(setToken.address);

            const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();

            const expectedNewLeverageRatio = calculateNewLeverageRatioPerpV2(
              currentLeverageRatio,
              methodology.targetLeverageRatio,
              methodology.minLeverageRatio,
              methodology.maxLeverageRatio,
              methodology.recenteringSpeed
            );

            await subject();

            const newPositions = await perpV2LeverageModule.getPositionUnitInfo(setToken.address);
            const newPosition = newPositions[0];

            const totalRebalanceNotional = preciseMul(
              preciseDiv(expectedNewLeverageRatio.sub(currentLeverageRatio), currentLeverageRatio),
              initialPositions[0].baseBalance
            );

            const totalSupply = await setToken.totalSupply();
            const expectedNewPositionUnit = preciseDiv(initialPositions[0].baseBalance.add(totalRebalanceNotional), totalSupply);

            expect(initialPositions.length).to.eq(1);
            expect(newPositions.length).to.eq(1);
            expect(newPosition.baseToken).to.eq(perpV2Setup.vETH.address);
            expect(newPosition.baseUnit).to.eq(expectedNewPositionUnit);
          });
        });

        context("when current leverage ratio is below target and in the middle of a TWAP", async () => {
          let newExchangeSettings: PerpV2ExchangeSettings;
          let preTwapLeverageRatio: BigNumber;

          cacheBeforeEach(async () => {
            await increaseTimeAsync(ONE_DAY_IN_SECONDS);
            await perpV2Setup.setBaseTokenOraclePrice(perpV2Setup.vETH, usdc(1250));
            await perpV2PriceFeedMock.setPrice(BigNumber.from(1250).mul(10 ** 8));

            newExchangeSettings = {
              twapMaxTradeSize: ether(.1),
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

            expect(currentLeverageRatio).to.be.lt(methodology.targetLeverageRatio);
            expect(twapLeverageRatio).to.be.gt(ZERO);
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

            const expectedNewLeverageRatio = calculateNewLeverageRatioPerpV2(
              preTwapLeverageRatio,
              methodology.targetLeverageRatio,
              methodology.minLeverageRatio,
              methodology.maxLeverageRatio,
              methodology.recenteringSpeed
            );
            expect(previousTwapLeverageRatio).to.eq(expectedNewLeverageRatio);
            expect(currentTwapLeverageRatio).to.eq(expectedNewLeverageRatio);
          });

          it("should update the baseToken position on the SetToken correctly", async () => {
            const initialPositions = await perpV2LeverageModule.getPositionNotionalInfo(setToken.address);

            const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();

            const expectedNewLeverageRatio = calculateNewLeverageRatioPerpV2(
              currentLeverageRatio,
              methodology.targetLeverageRatio,
              methodology.minLeverageRatio,
              methodology.maxLeverageRatio,
              methodology.recenteringSpeed
            );

            await subject();

            const newPositions = await perpV2LeverageModule.getPositionUnitInfo(setToken.address);
            const newPosition = newPositions[0];

            const totalRebalanceNotional = preciseMul(
              preciseDiv(expectedNewLeverageRatio.sub(currentLeverageRatio), currentLeverageRatio),
              initialPositions[0].baseBalance
            );

            const chunkRebalanceNotional = newExchangeSettings.twapMaxTradeSize.gt(totalRebalanceNotional)
              ? totalRebalanceNotional
              : newExchangeSettings.twapMaxTradeSize;

            const totalSupply = await setToken.totalSupply();
            const expectedNewPositionUnit = preciseDiv(initialPositions[0].baseBalance.add(chunkRebalanceNotional), totalSupply);

            expect(initialPositions.length).to.eq(1);
            expect(newPositions.length).to.eq(1);
            expect(newPosition.baseToken).to.eq(perpV2Setup.vETH.address);
            expect(newPosition.baseUnit).to.closeTo(expectedNewPositionUnit, 1);
          });
        });

        context("when current leverage ratio is above target and in the middle of a TWAP", async () => {
          let newExchangeSettings: PerpV2ExchangeSettings;
          let preTwapLeverageRatio: BigNumber;

          cacheBeforeEach(async () => {
            await increaseTimeAsync(ONE_DAY_IN_SECONDS);
            await perpV2Setup.setBaseTokenOraclePrice(perpV2Setup.vETH, usdc(850));
            await perpV2PriceFeedMock.setPrice(BigNumber.from(850).mul(10 ** 8));

            newExchangeSettings = {
              twapMaxTradeSize: ether(.1),
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

            expect(currentLeverageRatio).to.be.gt(methodology.targetLeverageRatio);
            expect(twapLeverageRatio).to.be.gt(ZERO);
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

            const expectedNewLeverageRatio = calculateNewLeverageRatioPerpV2(
              preTwapLeverageRatio,
              methodology.targetLeverageRatio,
              methodology.minLeverageRatio,
              methodology.maxLeverageRatio,
              methodology.recenteringSpeed
            );
            expect(previousTwapLeverageRatio).to.eq(expectedNewLeverageRatio);
            expect(currentTwapLeverageRatio).to.eq(expectedNewLeverageRatio);
          });

          it("should update the baseToken position on the SetToken correctly", async () => {
            const initialPositions = await perpV2LeverageModule.getPositionNotionalInfo(setToken.address);
            const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();
            const expectedNewLeverageRatio = calculateNewLeverageRatioPerpV2(
              preTwapLeverageRatio,
              methodology.targetLeverageRatio,
              methodology.minLeverageRatio,
              methodology.maxLeverageRatio,
              methodology.recenteringSpeed
            );

            await subject();

            const newPositions = await perpV2LeverageModule.getPositionUnitInfo(setToken.address);
            const newPosition = newPositions[0];

            const totalRebalanceNotional = preciseMul(
              preciseDiv(expectedNewLeverageRatio.sub(currentLeverageRatio), currentLeverageRatio),
              initialPositions[0].baseBalance
            );

            const chunkRebalanceNotional = newExchangeSettings.twapMaxTradeSize.gt(totalRebalanceNotional.abs())
              ? totalRebalanceNotional
              : totalRebalanceNotional.gt(ZERO) ? newExchangeSettings.twapMaxTradeSize : newExchangeSettings.twapMaxTradeSize.mul(-1);

            const totalSupply = await setToken.totalSupply();
            const expectedNewPositionUnit = preciseDiv(initialPositions[0].baseBalance.add(chunkRebalanceNotional), totalSupply);

            expect(initialPositions.length).to.eq(1);
            expect(newPositions.length).to.eq(1);
            expect(newPosition.baseToken).to.eq(perpV2Setup.vETH.address);
            expect(newPosition.baseUnit).to.closeTo(expectedNewPositionUnit, 1);
          });
        });

        describe("when price has moved advantageously towards target leverage ratio", async () => {
          let newExchangeSettings: PerpV2ExchangeSettings;

          cacheBeforeEach(async () => {
            await increaseTimeAsync(ONE_DAY_IN_SECONDS);
            await perpV2Setup.setBaseTokenOraclePrice(perpV2Setup.vETH, usdc(1500));
            await perpV2PriceFeedMock.setPrice(BigNumber.from(1500).mul(10 ** 8));

            newExchangeSettings = {
              twapMaxTradeSize: ether(1),
              incentivizedTwapMaxTradeSize: ether(1)
            };
            await leverageStrategyExtension.setExchangeSettings(newExchangeSettings);

            await leverageStrategyExtension.connect(owner.wallet).rebalance();

            await increaseTimeAsync(BigNumber.from(4000));    // >3s (twapCoolDown period)

            // Move price advantageously towards TLR; decrease price, so leverage increases towards TLR
            await perpV2Setup.setBaseTokenOraclePrice(perpV2Setup.vETH, usdc(1000));
            await perpV2PriceFeedMock.setPrice(BigNumber.from(1000).mul(10 ** 8));
          });

          it("should verify initial leverage conditions", async () => {
            const twapLeverageRatio = await leverageStrategyExtension.twapLeverageRatio();
            expect(twapLeverageRatio).to.be.gt(ZERO);
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

          it("should not update the positions on the SetToken", async () => {
            const initialPositions = await perpV2LeverageModule.getPositionUnitInfo(setToken.address);
            await subject();
            const currentPositions = await perpV2LeverageModule.getPositionUnitInfo(setToken.address);

            expect(currentPositions[0].baseToken).to.eq(initialPositions[0].baseToken);
            expect(currentPositions[0].baseUnit).to.eq(initialPositions[0].baseUnit);
          });
        });

        describe("when above incentivized leverage ratio threshold", async () => {
          beforeEach(async () => {
            await increaseTimeAsync(ONE_DAY_IN_SECONDS);
            await perpV2Setup.setBaseTokenOraclePrice(perpV2Setup.vETH, usdc(650));
            await perpV2PriceFeedMock.setPrice(BigNumber.from(650).mul(10 ** 8));
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Must be below incentivized leverage ratio");
          });
        });

        describe("when cooldown has not elapsed", async () => {
          let newExchangeSettings: PerpV2ExchangeSettings;

          beforeEach(async () => {
            await increaseTimeAsync(ONE_DAY_IN_SECONDS);
            await perpV2Setup.setBaseTokenOraclePrice(perpV2Setup.vETH, usdc(900));
            await perpV2PriceFeedMock.setPrice(BigNumber.from(900).mul(10 ** 8));

            newExchangeSettings = {
              twapMaxTradeSize: ether(.1),
              incentivizedTwapMaxTradeSize: ether(1)
            };
            await leverageStrategyExtension.setExchangeSettings(newExchangeSettings);

            await leverageStrategyExtension.connect(owner.wallet).rebalance();
          });

          it("should be in TWAP rebalance", async () => {
            const twapLeverageRatio = await leverageStrategyExtension.twapLeverageRatio();

            expect(twapLeverageRatio).to.be.gt(ZERO);
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Cooldown not elapsed or not valid leverage ratio");
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

        describe("when caller is not an allowed trader", async () => {
          let newExchangeSettings: PerpV2ExchangeSettings;

          beforeEach(async () => {
            subjectCaller = await getRandomAccount();

            await increaseTimeAsync(ONE_DAY_IN_SECONDS);
            await perpV2Setup.setBaseTokenOraclePrice(perpV2Setup.vETH, usdc(850));
            await perpV2PriceFeedMock.setPrice(BigNumber.from(850).mul(10 ** 8));

            newExchangeSettings = {
              twapMaxTradeSize: ether(.1),
              incentivizedTwapMaxTradeSize: ether(1)
            };
            await leverageStrategyExtension.setExchangeSettings(newExchangeSettings);

            await leverageStrategyExtension.connect(owner.wallet).rebalance();

            await increaseTimeAsync(BigNumber.from(4000));    // >3s (twapCoolDown period)
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Address not permitted to call");
          });
        });

        describe("when caller is a contract", async () => {
          let subjectTarget: Address;
          let subjectCallData: string;
          let subjectValue: BigNumber;

          let contractCaller: ContractCallerMock;

          beforeEach(async () => {
            contractCaller = await deployer.mocks.deployContractCallerMock();

            subjectTarget = leverageStrategyExtension.address;
            subjectCallData = leverageStrategyExtension.interface.encodeFunctionData("iterateRebalance");
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

        context("when not in TWAP state", async () => {
          beforeEach(async () => {
            await increaseTimeAsync(ONE_DAY_IN_SECONDS);
            await perpV2Setup.setBaseTokenOraclePrice(perpV2Setup.vETH, usdc(850));
            await perpV2PriceFeedMock.setPrice(BigNumber.from(850).mul(10 ** 8));
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Not in TWAP state");
          });
        });
      });

      context("when rebalancing short position", async () => {
        let newMethodologySettings: PerpV2MethodologySettings;

        cacheBeforeEach(async () => {
          newMethodologySettings = {
            targetLeverageRatio: methodology.targetLeverageRatio.mul(-1),
            minLeverageRatio: methodology.minLeverageRatio.mul(-1),
            maxLeverageRatio: methodology.maxLeverageRatio.mul(-1),
            recenteringSpeed: methodology.recenteringSpeed,
            rebalanceInterval: methodology.rebalanceInterval,
          };
          await leverageStrategyExtension.setMethodologySettings(newMethodologySettings);

          // Engage short position
          await leverageStrategyExtension.engage();
        });

        context("when currently in the last chunk of a TWAP rebalance", async () => {
          let newExchangeSettings: PerpV2ExchangeSettings;
          let preTwapLeverageRatio: BigNumber;

          cacheBeforeEach(async () => {
            await increaseTimeAsync(ONE_DAY_IN_SECONDS);
            await perpV2Setup.setBaseTokenOraclePrice(perpV2Setup.vETH, usdc(920));
            await perpV2PriceFeedMock.setPrice(BigNumber.from(920).mul(10 ** 8));

            newExchangeSettings = {
              twapMaxTradeSize: ether(1),
              incentivizedTwapMaxTradeSize: ether(1)
            };
            preTwapLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();
            await leverageStrategyExtension.setExchangeSettings(newExchangeSettings);
            await leverageStrategyExtension.connect(owner.wallet).rebalance();
            await increaseTimeAsync(BigNumber.from(4000));    // >3s (twapCoolDown period)
          });

          it("should verify initial leverage conditions", async () => {
            const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();
            const twapLeverageRatio = await leverageStrategyExtension.twapLeverageRatio();
            expect(currentLeverageRatio.abs()).to.be.lt(newMethodologySettings.minLeverageRatio.abs());
            expect(twapLeverageRatio.abs()).to.be.eq(newMethodologySettings.minLeverageRatio.abs());
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

          it("should update the baseToken position on the SetToken correctly", async () => {
            const initialPositions = await perpV2LeverageModule.getPositionNotionalInfo(setToken.address);

            const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();

            const expectedNewLeverageRatio = calculateNewLeverageRatioPerpV2(
              preTwapLeverageRatio,
              newMethodologySettings.targetLeverageRatio,
              newMethodologySettings.minLeverageRatio,
              newMethodologySettings.maxLeverageRatio,
              newMethodologySettings.recenteringSpeed
            );

            await subject();

            const newPositions = await perpV2LeverageModule.getPositionUnitInfo(setToken.address);
            const newPosition = newPositions[0];

            const totalRebalanceNotional = preciseMul(
              preciseDiv(expectedNewLeverageRatio.sub(currentLeverageRatio), currentLeverageRatio),
              initialPositions[0].baseBalance
            );
            const chunkRebalanceNotional = totalRebalanceNotional.gt(newExchangeSettings.twapMaxTradeSize)
              ? (totalRebalanceNotional.gt(ZERO) ? newExchangeSettings.twapMaxTradeSize : newExchangeSettings.twapMaxTradeSize.mul(-1))
              : totalRebalanceNotional;

            const totalSupply = await setToken.totalSupply();
            const expectedNewPositionUnit = preciseDiv(initialPositions[0].baseBalance.add(chunkRebalanceNotional), totalSupply);

            expect(initialPositions.length).to.eq(1);
            expect(newPositions.length).to.eq(1);
            expect(newPosition.baseToken).to.eq(perpV2Setup.vETH.address);
            expect(newPosition.baseUnit).to.eq(expectedNewPositionUnit);
          });
        });

        context("when current leverage ratio is below target and in the middle of a TWAP", async () => {
          let newExchangeSettings: PerpV2ExchangeSettings;
          let preTwapLeverageRatio: BigNumber;

          cacheBeforeEach(async () => {
            await increaseTimeAsync(ONE_DAY_IN_SECONDS);
            await perpV2Setup.setBaseTokenOraclePrice(perpV2Setup.vETH, usdc(900));
            await perpV2PriceFeedMock.setPrice(BigNumber.from(900).mul(10 ** 8));

            newExchangeSettings = {
              twapMaxTradeSize: ether(.1),
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
            expect(currentLeverageRatio.abs()).to.be.lt(newMethodologySettings.targetLeverageRatio.abs());
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

            const expectedNewLeverageRatio = calculateNewLeverageRatioPerpV2(
              preTwapLeverageRatio,
              newMethodologySettings.targetLeverageRatio,
              newMethodologySettings.minLeverageRatio,
              newMethodologySettings.maxLeverageRatio,
              newMethodologySettings.recenteringSpeed
            );
            expect(previousTwapLeverageRatio).to.eq(expectedNewLeverageRatio);
            expect(currentTwapLeverageRatio).to.eq(expectedNewLeverageRatio);
          });

          it("should update the baseToken position on the SetToken correctly", async () => {
            const initialPositions = await perpV2LeverageModule.getPositionNotionalInfo(setToken.address);

            const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();

            const expectedNewLeverageRatio = calculateNewLeverageRatioPerpV2(
              preTwapLeverageRatio,
              newMethodologySettings.targetLeverageRatio,
              newMethodologySettings.minLeverageRatio,
              newMethodologySettings.maxLeverageRatio,
              newMethodologySettings.recenteringSpeed
            );

            await subject();

            const newPositions = await perpV2LeverageModule.getPositionUnitInfo(setToken.address);
            const newPosition = newPositions[0];

            const totalRebalanceNotional = preciseMul(
              preciseDiv(expectedNewLeverageRatio.sub(currentLeverageRatio), currentLeverageRatio),
              initialPositions[0].baseBalance
            );
            const chunkRebalanceNotional = newExchangeSettings.twapMaxTradeSize.gt(totalRebalanceNotional.abs())
              ? totalRebalanceNotional
              : (totalRebalanceNotional.gt(ZERO) ? newExchangeSettings.twapMaxTradeSize : newExchangeSettings.twapMaxTradeSize.mul(-1));

            const totalSupply = await setToken.totalSupply();
            const expectedNewPositionUnit = preciseDiv(initialPositions[0].baseBalance.add(chunkRebalanceNotional), totalSupply);

            expect(initialPositions.length).to.eq(1);
            expect(newPositions.length).to.eq(1);
            expect(newPosition.baseToken).to.eq(perpV2Setup.vETH.address);
            expect(newPosition.baseUnit).to.closeTo(expectedNewPositionUnit, 1);
          });
        });

        context("when current leverage ratio is above target and in the middle of a TWAP", async () => {
          let newExchangeSettings: PerpV2ExchangeSettings;
          let preTwapLeverageRatio: BigNumber;

          cacheBeforeEach(async () => {
            await increaseTimeAsync(ONE_DAY_IN_SECONDS);
            await perpV2Setup.setBaseTokenOraclePrice(perpV2Setup.vETH, usdc(1050));
            await perpV2PriceFeedMock.setPrice(BigNumber.from(1050).mul(10 ** 8));

            newExchangeSettings = {
              twapMaxTradeSize: ether(.1),
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
            expect(currentLeverageRatio.abs()).to.be.gt(newMethodologySettings.targetLeverageRatio.abs());
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

            const expectedNewLeverageRatio = calculateNewLeverageRatioPerpV2(
              preTwapLeverageRatio,
              newMethodologySettings.targetLeverageRatio,
              newMethodologySettings.minLeverageRatio,
              newMethodologySettings.maxLeverageRatio,
              newMethodologySettings.recenteringSpeed
            );
            expect(previousTwapLeverageRatio).to.eq(expectedNewLeverageRatio);
            expect(currentTwapLeverageRatio).to.eq(expectedNewLeverageRatio);
          });

          it("should update the baseToken position on the SetToken correctly", async () => {
            const initialPositions = await perpV2LeverageModule.getPositionNotionalInfo(setToken.address);
            const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();
            const expectedNewLeverageRatio = calculateNewLeverageRatioPerpV2(
              preTwapLeverageRatio,
              newMethodologySettings.targetLeverageRatio,
              newMethodologySettings.minLeverageRatio,
              newMethodologySettings.maxLeverageRatio,
              newMethodologySettings.recenteringSpeed
            );

            await subject();

            const newPositions = await perpV2LeverageModule.getPositionUnitInfo(setToken.address);
            const newPosition = newPositions[0];

            const totalRebalanceNotional = preciseMul(
              preciseDiv(expectedNewLeverageRatio.sub(currentLeverageRatio), currentLeverageRatio),
              initialPositions[0].baseBalance
            );

            const chunkRebalanceNotional = newExchangeSettings.twapMaxTradeSize.gt(totalRebalanceNotional.abs())
              ? totalRebalanceNotional
              : totalRebalanceNotional.gt(ZERO) ? newExchangeSettings.twapMaxTradeSize : newExchangeSettings.twapMaxTradeSize.mul(-1);

            const totalSupply = await setToken.totalSupply();
            const expectedNewPositionUnit = preciseDiv(initialPositions[0].baseBalance.add(chunkRebalanceNotional), totalSupply);

            expect(initialPositions.length).to.eq(1);
            expect(newPositions.length).to.eq(1);
            expect(newPosition.baseToken).to.eq(perpV2Setup.vETH.address);
            expect(newPosition.baseUnit).to.closeTo(expectedNewPositionUnit, 1);
          });
        });

        describe("when price has moved advantageously towards target leverage ratio", async () => {
          let newExchangeSettings: PerpV2ExchangeSettings;

          cacheBeforeEach(async () => {
            await increaseTimeAsync(ONE_DAY_IN_SECONDS);
            await perpV2Setup.setBaseTokenOraclePrice(perpV2Setup.vETH, usdc(900));
            await perpV2PriceFeedMock.setPrice(BigNumber.from(900).mul(10 ** 8));

            newExchangeSettings = {
              twapMaxTradeSize: ether(1),
              incentivizedTwapMaxTradeSize: ether(1)
            };
            await leverageStrategyExtension.setExchangeSettings(newExchangeSettings);
            await leverageStrategyExtension.connect(owner.wallet).rebalance();

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

          it("should not update the positions on the SetToken", async () => {
            const initialPositions = await perpV2LeverageModule.getPositionUnitInfo(setToken.address);
            await subject();
            const currentPositions = await perpV2LeverageModule.getPositionUnitInfo(setToken.address);

            expect(currentPositions[0].baseToken).to.eq(initialPositions[0].baseToken);
            expect(currentPositions[0].baseUnit).to.eq(initialPositions[0].baseUnit);
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

      cacheBeforeEach(async () => {
        await leverageStrategyExtension.updateCallerStatus([owner.address], [true]);
        await leverageStrategyExtension.deposit(await setToken.getDefaultPositionRealUnit(perpV2Setup.usdc.address));
      });

      beforeEach(async () => {
        subjectCaller = owner;
      });

      async function subject(): Promise<any> {
        return leverageStrategyExtension.connect(subjectCaller.wallet).ripcord();
      }

      context("when ripcord long position", async () => {
        cacheBeforeEach(async () => {
          await leverageStrategyExtension.engage();
          await increaseTimeAsync(BigNumber.from(100000));
        });

        context("when not in a TWAP rebalance", async () => {
          cacheBeforeEach(async () => {
            // Set to above incentivized ratio
            await perpV2Setup.setBaseTokenOraclePrice(perpV2Setup.vETH, usdc(800));
            await perpV2PriceFeedMock.setPrice(BigNumber.from(800).mul(10 ** 8));
            transferredEth = ether(1);
            await owner.wallet.sendTransaction({to: leverageStrategyExtension.address, value: transferredEth});
          });

          it("should validate NOT in TWAP", async () => {
            const twapLeverageRatio = await leverageStrategyExtension.twapLeverageRatio();
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
            const initialPositions = await perpV2LeverageModule.getPositionNotionalInfo(setToken.address);

            const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();

            const expectedNewLeverageRatio = calculateNewLeverageRatioPerpV2(
              currentLeverageRatio,
              methodology.targetLeverageRatio,
              methodology.minLeverageRatio,
              methodology.maxLeverageRatio,
              methodology.recenteringSpeed
            );

            await subject();

            const newPositions = await perpV2LeverageModule.getPositionUnitInfo(setToken.address);
            const newPosition = newPositions[0];

            const totalRebalanceNotional = preciseMul(
              preciseDiv(expectedNewLeverageRatio.sub(currentLeverageRatio), currentLeverageRatio),
              initialPositions[0].baseBalance
            );

            const rebalanceNotional = exchange.twapMaxTradeSize.gt(totalRebalanceNotional.abs())
              ? totalRebalanceNotional
              : totalRebalanceNotional.gt(ZERO) ? exchange.twapMaxTradeSize : exchange.twapMaxTradeSize.mul(-1);

            const totalSupply = await setToken.totalSupply();
            const expectedNewPositionUnit = preciseDiv(initialPositions[0].baseBalance.add(rebalanceNotional), totalSupply);

            expect(initialPositions.length).to.eq(1);
            expect(newPositions.length).to.eq(1);
            expect(newPosition.baseToken).to.eq(perpV2Setup.vETH.address);
            expect(newPosition.baseUnit).to.closeTo(expectedNewPositionUnit, 1);
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
            const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();
            const baseBalance = await perpV2Setup.accountBalance.getBase(setToken.address, perpV2Setup.vETH.address);
            const chunkRebalanceNotional = preciseMul(
              preciseDiv(methodology.maxLeverageRatio.sub(currentLeverageRatio), currentLeverageRatio),
              baseBalance
            );

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
              const newPerpV2ExchangeSettings: PerpV2ExchangeSettings = {
                twapMaxTradeSize: ether(0.001),
                incentivizedTwapMaxTradeSize: newIncentivizedMaxTradeSize
              };
              await leverageStrategyExtension.setExchangeSettings(newPerpV2ExchangeSettings);
            });

            it("should set the global last trade timestamp", async () => {
              await subject();

              const lastTradeTimestamp = await leverageStrategyExtension.lastTradeTimestamp();

              expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
            });

            it("should update the baseToken position on the SetToken correctly", async () => {
              const initialPositions = await perpV2LeverageModule.getPositionNotionalInfo(setToken.address);

              await subject();

              const newPositions = await perpV2LeverageModule.getPositionUnitInfo(setToken.address);
              const newPosition = newPositions[0];

              const totalSupply = await setToken.totalSupply();
              const expectedNewPositionUnit = preciseDiv(initialPositions[0].baseBalance.sub(newIncentivizedMaxTradeSize), totalSupply);

              expect(initialPositions.length).to.eq(1);
              expect(newPositions.length).to.eq(1);
              expect(newPosition.baseToken).to.eq(perpV2Setup.vETH.address);
              expect(newPosition.baseUnit).to.closeTo(expectedNewPositionUnit, 1);
            });
          });

          describe("when incentivized cooldown period has not elapsed", async () => {
            let newIncentivizedMaxTradeSize: BigNumber;

            cacheBeforeEach(async () => {
              newIncentivizedMaxTradeSize = ether(0.01);
              const newPerpV2ExchangeSettings: PerpV2ExchangeSettings = {
                twapMaxTradeSize: ether(0.001),
                incentivizedTwapMaxTradeSize: newIncentivizedMaxTradeSize
              };
              await leverageStrategyExtension.setExchangeSettings(newPerpV2ExchangeSettings);
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
              await perpV2Setup.setBaseTokenOraclePrice(perpV2Setup.vETH, usdc(2000));
              await perpV2PriceFeedMock.setPrice(BigNumber.from(2000).mul(10 ** 8));
            });

            it("should revert", async () => {
              await expect(subject()).to.be.revertedWith("Must be above incentivized leverage ratio");
            });
          });

          describe("when caller is a contract", async () => {
            let subjectTarget: Address;
            let subjectCallData: string;
            let subjectValue: BigNumber;

            let contractCaller: ContractCallerMock;

            beforeEach(async () => {
              contractCaller = await deployer.mocks.deployContractCallerMock();

              subjectTarget = leverageStrategyExtension.address;
              subjectCallData = leverageStrategyExtension.interface.encodeFunctionData("ripcord");
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

        context("when in the midst of a TWAP rebalance", async () => {
          let newIncentivizedMaxTradeSize: BigNumber;

          cacheBeforeEach(async () => {
            transferredEth = ether(1);
            await owner.wallet.sendTransaction({to: leverageStrategyExtension.address, value: transferredEth});

            newIncentivizedMaxTradeSize = ether(0.001);
            const newPerpV2ExchangeSettings: PerpV2ExchangeSettings = {
              twapMaxTradeSize: ether(0.001),
              incentivizedTwapMaxTradeSize: newIncentivizedMaxTradeSize
            };
            await leverageStrategyExtension.setExchangeSettings(newPerpV2ExchangeSettings);

            await perpV2Setup.setBaseTokenOraclePrice(perpV2Setup.vETH, usdc(990));
            await perpV2PriceFeedMock.setPrice(BigNumber.from(990).mul(10 ** 8));

            // Start TWAP rebalance
            await leverageStrategyExtension.rebalance();
            await increaseTimeAsync(BigNumber.from(100));

            // Set to above incentivized ratio
            await perpV2Setup.setBaseTokenOraclePrice(perpV2Setup.vETH, usdc(800));
            await perpV2PriceFeedMock.setPrice(BigNumber.from(800).mul(10 ** 8));
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

      context("when ripcord short position", async () => {
        let newMethodologySettings: PerpV2MethodologySettings;
        let newIncentiveSettings: PerpV2IncentiveSettings;

        cacheBeforeEach(async () => {
          newMethodologySettings = {
            targetLeverageRatio: methodology.targetLeverageRatio.mul(-1),
            minLeverageRatio: methodology.minLeverageRatio.mul(-1),
            maxLeverageRatio: methodology.maxLeverageRatio.mul(-1),
            recenteringSpeed: methodology.recenteringSpeed,
            rebalanceInterval: methodology.rebalanceInterval,
          };
          await leverageStrategyExtension.setMethodologySettings(newMethodologySettings);
          newIncentiveSettings = {
            incentivizedLeverageRatio: incentive.incentivizedLeverageRatio.mul(-1),
            incentivizedSlippageTolerance: incentive.incentivizedSlippageTolerance,
            incentivizedTwapCooldownPeriod: incentive.incentivizedTwapCooldownPeriod,
            etherReward: incentive.etherReward
          };
          await leverageStrategyExtension.setIncentiveSettings(newIncentiveSettings);


          // Engage short position
          await leverageStrategyExtension.engage();
          await increaseTimeAsync(BigNumber.from(100000));
        });

        context("when not in a TWAP rebalance", async () => {
          cacheBeforeEach(async () => {
            // Set to above incentivized ratio
            await perpV2Setup.setBaseTokenOraclePrice(perpV2Setup.vETH, usdc(1100));
            await perpV2PriceFeedMock.setPrice(BigNumber.from(1100).mul(10 ** 8));

            // Deposit ETH to incentivize calling ripcord
            transferredEth = ether(1);
            await owner.wallet.sendTransaction({to: leverageStrategyExtension.address, value: transferredEth});
          });

          it("should validate leverage ratio and NOT in TWAP", async () => {
            const twapLeverageRatio = await leverageStrategyExtension.twapLeverageRatio();
            const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();

            expect(currentLeverageRatio.abs()).to.be.gt(newIncentiveSettings.incentivizedLeverageRatio.abs());
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
            const initialPositions = await perpV2LeverageModule.getPositionNotionalInfo(setToken.address);

            const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();

            const expectedNewLeverageRatio = calculateNewLeverageRatioPerpV2(
              currentLeverageRatio,
              newMethodologySettings.targetLeverageRatio,
              newMethodologySettings.minLeverageRatio,
              newMethodologySettings.maxLeverageRatio,
              newMethodologySettings.recenteringSpeed
            );

            await subject();

            const newPositions = await perpV2LeverageModule.getPositionUnitInfo(setToken.address);
            const newPosition = newPositions[0];

            const totalRebalanceNotional = preciseMul(
              preciseDiv(expectedNewLeverageRatio.sub(currentLeverageRatio), currentLeverageRatio),
              initialPositions[0].baseBalance
            );

            const rebalanceNotional = exchange.twapMaxTradeSize.gt(totalRebalanceNotional.abs())
              ? totalRebalanceNotional
              : totalRebalanceNotional.gt(ZERO) ? exchange.twapMaxTradeSize : exchange.twapMaxTradeSize.mul(-1);

            const totalSupply = await setToken.totalSupply();
            const expectedNewPositionUnit = preciseDiv(initialPositions[0].baseBalance.add(rebalanceNotional), totalSupply);

            expect(initialPositions.length).to.eq(1);
            expect(newPositions.length).to.eq(1);
            expect(newPosition.baseToken).to.eq(perpV2Setup.vETH.address);
            expect(newPosition.baseUnit).to.closeTo(expectedNewPositionUnit, 1);
          });

          it("should transfer incentive", async () => {
            const previousContractEthBalance = await getEthBalance(leverageStrategyExtension.address);
            const previousOwnerEthBalance = await getEthBalance(owner.address);

            const txHash = await subject();
            const txReceipt = await provider.getTransactionReceipt(txHash.hash);
            const currentContractEthBalance = await getEthBalance(leverageStrategyExtension.address);
            const currentOwnerEthBalance = await getEthBalance(owner.address);
            const expectedOwnerEthBalance = previousOwnerEthBalance.add(newIncentiveSettings.etherReward).sub(txReceipt.gasUsed.mul(txHash.gasPrice));

            expect(previousContractEthBalance).to.eq(transferredEth);
            expect(currentContractEthBalance).to.eq(transferredEth.sub(newIncentiveSettings.etherReward));
            expect(expectedOwnerEthBalance).to.eq(currentOwnerEthBalance);
          });

          it("should emit RipcordCalled event", async () => {
            const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();
            const baseBalance = await perpV2Setup.accountBalance.getBase(setToken.address, perpV2Setup.vETH.address);
            const chunkRebalanceNotional = preciseMul(
              preciseDiv(newMethodologySettings.maxLeverageRatio.sub(currentLeverageRatio), currentLeverageRatio),
              baseBalance
            );

            await expect(subject()).to.emit(leverageStrategyExtension, "RipcordCalled").withArgs(
              currentLeverageRatio,
              newMethodologySettings.maxLeverageRatio,
              chunkRebalanceNotional,
              newIncentiveSettings.etherReward,
            );
          });

          describe("when greater than incentivized max trade size", async () => {
            let newIncentivizedMaxTradeSize: BigNumber;

            cacheBeforeEach(async () => {
              newIncentivizedMaxTradeSize = ether(0.01);
              const newPerpV2ExchangeSettings: PerpV2ExchangeSettings = {
                twapMaxTradeSize: ether(0.001),
                incentivizedTwapMaxTradeSize: newIncentivizedMaxTradeSize
              };
              await leverageStrategyExtension.setExchangeSettings(newPerpV2ExchangeSettings);
            });

            it("should set the global last trade timestamp", async () => {
              await subject();

              const lastTradeTimestamp = await leverageStrategyExtension.lastTradeTimestamp();

              expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
            });

            it("should update the baseToken position on the SetToken correctly", async () => {
              const initialPositions = await perpV2LeverageModule.getPositionNotionalInfo(setToken.address);

              await subject();

              const newPositions = await perpV2LeverageModule.getPositionUnitInfo(setToken.address);
              const newPosition = newPositions[0];

              const totalSupply = await setToken.totalSupply();
              const expectedNewPositionUnit = preciseDiv(initialPositions[0].baseBalance.add(newIncentivizedMaxTradeSize), totalSupply);

              expect(initialPositions.length).to.eq(1);
              expect(newPositions.length).to.eq(1);
              expect(newPosition.baseToken).to.eq(perpV2Setup.vETH.address);
              expect(newPosition.baseUnit).to.closeTo(expectedNewPositionUnit, 1);
            });
          });

          describe("when incentivized cooldown period has not elapsed", async () => {
            let newIncentivizedMaxTradeSize: BigNumber;

            cacheBeforeEach(async () => {
              newIncentivizedMaxTradeSize = ether(0.01);
              const newPerpV2ExchangeSettings: PerpV2ExchangeSettings = {
                twapMaxTradeSize: ether(0.001),
                incentivizedTwapMaxTradeSize: newIncentivizedMaxTradeSize
              };
              await leverageStrategyExtension.setExchangeSettings(newPerpV2ExchangeSettings);
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
            await owner.wallet.sendTransaction({to: leverageStrategyExtension.address, value: transferredEth});

            newIncentivizedMaxTradeSize = ether(0.001);
            const newPerpV2ExchangeSettings: PerpV2ExchangeSettings = {
              twapMaxTradeSize: ether(0.001),
              incentivizedTwapMaxTradeSize: newIncentivizedMaxTradeSize
            };
            await leverageStrategyExtension.setExchangeSettings(newPerpV2ExchangeSettings);

            await perpV2Setup.setBaseTokenOraclePrice(perpV2Setup.vETH, usdc(950));
            await perpV2PriceFeedMock.setPrice(BigNumber.from(950).mul(10 ** 8));

            // Start TWAP rebalance
            await leverageStrategyExtension.rebalance();
            await increaseTimeAsync(BigNumber.from(100));

            // Set to above incentivized ratio
            await perpV2Setup.setBaseTokenOraclePrice(perpV2Setup.vETH, usdc(1100));
            await perpV2PriceFeedMock.setPrice(BigNumber.from(1100).mul(10 ** 8));
          });

          it("should validate leverage ratio and in TWAP", async () => {
            const twapLeverageRatio = await leverageStrategyExtension.twapLeverageRatio();
            const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();

            expect(currentLeverageRatio.abs()).to.be.gt(newIncentiveSettings.incentivizedLeverageRatio.abs());
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
      let ifEngaged: boolean;

      beforeEach(async () => {
        subjectCaller = owner;
      });

      async function subject(): Promise<any> {
        return leverageStrategyExtension.connect(subjectCaller.wallet).disengage();
      }

      context("when disengage long position", async () => {
        context("when notional is less than max trade size", async () => {
          before(async () => {
            ifEngaged = true;
          });

          const intializeContracts = async() => {
            if (ifEngaged) {
              // Add allowed trader
              await leverageStrategyExtension.updateCallerStatus([owner.address], [true]);
              // Engage to initial leverage
              await leverageStrategyExtension.deposit(await setToken.getDefaultPositionRealUnit(perpV2Setup.usdc.address));
              await leverageStrategyExtension.engage();
              await increaseTimeAsync(BigNumber.from(4000));
            }
          };

          describe("when engaged", () => {
            cacheBeforeEach(intializeContracts);

            it("should remove the base position from the SetToken", async () => {
              const initialPositions = await perpV2LeverageModule.getPositionNotionalInfo(setToken.address);

              await subject();

              const newPositions = await perpV2LeverageModule.getPositionUnitInfo(setToken.address);

              expect(initialPositions.length).to.eq(1);
              expect(newPositions.length).to.eq(0);
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

            describe("when the caller is not the operator", async () => {
              beforeEach(async () => {
                subjectCaller = await getRandomAccount();
              });

              it("should revert", async () => {
                await expect(subject()).to.be.revertedWith("Must be operator");
              });
            });
          });

          describe("when not engaged", async () => {
            before(async () => {
              ifEngaged = false;
            });

            cacheBeforeEach(intializeContracts);

            after(async () => {
              ifEngaged = true;
            });

            it("should revert", async () => {
              await expect(subject()).to.be.revertedWith("Current leverage ratio must NOT be 0");
            });
          });
        });

        context("when notional is greater than max trade size", async () => {
          let newExchangeSettings: PerpV2ExchangeSettings;

          before(async () => {
            ifEngaged = true;
          });

          const intializeContracts = async() => {
            // Add allowed trader
            await leverageStrategyExtension.updateCallerStatus([owner.address], [true]);
            await leverageStrategyExtension.deposit(await setToken.getDefaultPositionRealUnit(perpV2Setup.usdc.address));

            if (ifEngaged) {
              await leverageStrategyExtension.engage();
              await increaseTimeAsync(BigNumber.from(4000));

              newExchangeSettings = {
                twapMaxTradeSize: ether(1.9),
                incentivizedTwapMaxTradeSize: exchange.incentivizedTwapMaxTradeSize
              };
              await leverageStrategyExtension.setExchangeSettings(newExchangeSettings);
            }
          };

          describe("when engaged", () => {
            cacheBeforeEach(intializeContracts);

            it("should update the base position on the SetToken correctly", async () => {
              const initialPositions = await perpV2LeverageModule.getPositionNotionalInfo(setToken.address);

              await subject();

              const newPositions = await perpV2LeverageModule.getPositionUnitInfo(setToken.address);
              const newPosition = newPositions[0];

              const totalSupply = await setToken.totalSupply();
              const expectedNewPositionUnit = preciseDiv(initialPositions[0].baseBalance.sub(newExchangeSettings.twapMaxTradeSize), totalSupply);

              expect(initialPositions.length).to.eq(1);
              expect(newPositions.length).to.eq(1);
              expect(newPosition.baseToken).to.eq(perpV2Setup.vETH.address);
              expect(newPosition.baseUnit).to.closeTo(expectedNewPositionUnit, 1);
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

            describe("when the caller is not the operator", async () => {
              beforeEach(async () => {
                subjectCaller = await getRandomAccount();
              });

              it("should revert", async () => {
                await expect(subject()).to.be.revertedWith("Must be operator");
              });
            });
          });

          describe("when not engaged", async () => {
            before(async () => {
              ifEngaged = false;
            });

            cacheBeforeEach(intializeContracts);

            after(async () => {
              ifEngaged = true;
            });

            it("should revert", async () => {
              await expect(subject()).to.be.revertedWith("Current leverage ratio must NOT be 0");
            });
          });
        });
      });

      context("when disengage short position", async () => {
        let newMethodologySettings: PerpV2MethodologySettings;

        cacheBeforeEach(async () => {
          newMethodologySettings = {
            targetLeverageRatio: methodology.targetLeverageRatio.mul(-1),
            minLeverageRatio: methodology.minLeverageRatio.mul(-1),
            maxLeverageRatio: methodology.maxLeverageRatio.mul(-1),
            recenteringSpeed: methodology.recenteringSpeed,
            rebalanceInterval: methodology.rebalanceInterval,
          };
          await leverageStrategyExtension.setMethodologySettings(newMethodologySettings);
        });

        context("when notional is less than max trade size", async () => {
          before(async () => {
            ifEngaged = true;
          });

          const intializeContracts = async() => {
            if (ifEngaged) {
              // Add allowed trader
              await leverageStrategyExtension.updateCallerStatus([owner.address], [true]);
              // Engage to initial leverage
              await leverageStrategyExtension.deposit(await setToken.getDefaultPositionRealUnit(perpV2Setup.usdc.address));
              await leverageStrategyExtension.engage();
              await increaseTimeAsync(BigNumber.from(4000));
            }
          };

          describe("when engaged", () => {
            cacheBeforeEach(intializeContracts);

            it("should remove the base position from the SetToken", async () => {
              const initialPositions = await perpV2LeverageModule.getPositionNotionalInfo(setToken.address);

              await subject();

              const newPositions = await perpV2LeverageModule.getPositionUnitInfo(setToken.address);

              expect(initialPositions.length).to.eq(1);
              expect(newPositions.length).to.eq(0);
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
        });

        context("when notional is greater than max trade size", async () => {
          let newExchangeSettings: PerpV2ExchangeSettings;

          before(async () => {
            ifEngaged = true;
          });

          const intializeContracts = async() => {
            // Add allowed trader
            await leverageStrategyExtension.updateCallerStatus([owner.address], [true]);
            await leverageStrategyExtension.deposit(await setToken.getDefaultPositionRealUnit(perpV2Setup.usdc.address));

            if (ifEngaged) {
              await leverageStrategyExtension.engage();
              await increaseTimeAsync(BigNumber.from(4000));

              newExchangeSettings = {
                twapMaxTradeSize: ether(1.9),
                incentivizedTwapMaxTradeSize: exchange.incentivizedTwapMaxTradeSize
              };
              await leverageStrategyExtension.setExchangeSettings(newExchangeSettings);
            }
          };

          describe("when engaged", () => {
            cacheBeforeEach(intializeContracts);

            it("should update the base position on the SetToken correctly", async () => {
              const initialPositions = await perpV2LeverageModule.getPositionNotionalInfo(setToken.address);

              await subject();

              const newPositions = await perpV2LeverageModule.getPositionUnitInfo(setToken.address);
              const newPosition = newPositions[0];

              const totalSupply = await setToken.totalSupply();
              const expectedNewPositionUnit = preciseDiv(initialPositions[0].baseBalance.add(newExchangeSettings.twapMaxTradeSize), totalSupply);

              expect(initialPositions.length).to.eq(1);
              expect(newPositions.length).to.eq(1);
              expect(newPosition.baseToken).to.eq(perpV2Setup.vETH.address);
              expect(newPosition.baseUnit).to.closeTo(expectedNewPositionUnit, 1);
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
      });
    });

    describe("#setMethodologySettings", async () => {
      let subjectMethodologySettings: PerpV2MethodologySettings;
      let subjectCaller: Account;

      const initializeSubjectVariables = () => {
        subjectMethodologySettings = {
          targetLeverageRatio: ether(2.1),
          minLeverageRatio: ether(1.1),
          maxLeverageRatio: ether(2.5),
          recenteringSpeed: ether(0.1),
          rebalanceInterval: BigNumber.from(43200),
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
        });

        it("should emit PerpV2MethodologySettingsUpdated event", async () => {
          await expect(subject()).to.emit(leverageStrategyExtension, "MethodologySettingsUpdated").withArgs(
            subjectMethodologySettings.targetLeverageRatio,
            subjectMethodologySettings.minLeverageRatio,
            subjectMethodologySettings.maxLeverageRatio,
            subjectMethodologySettings.recenteringSpeed,
            subjectMethodologySettings.rebalanceInterval,
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

        describe("when min leverage ratio is 0", async () => {
          beforeEach(async () => {
            subjectMethodologySettings.minLeverageRatio = ZERO;
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Must be valid min leverage");
          });
        });

        describe("when min leverage ratio is above target", async () => {
          beforeEach(async () => {
            subjectMethodologySettings.minLeverageRatio = ether(2.2);
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Must be valid min leverage");
          });
        });

        describe("when max leverage ratio is below target", async () => {
          beforeEach(async () => {
            subjectMethodologySettings.maxLeverageRatio = ether(1.9);
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Must be valid max leverage");
          });
        });

        describe("when max leverage ratio is above incentivized leverage ratio", async () => {
          beforeEach(async () => {
            subjectMethodologySettings.maxLeverageRatio = ether(5);
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Incentivized leverage ratio must be > max leverage ratio");
          });
        });

        describe("when recentering speed is >100%", async () => {
          beforeEach(async () => {
            subjectMethodologySettings.recenteringSpeed = ether(1.1);
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Must be valid recentering speed");
          });
        });

        describe("when recentering speed is 0%", async () => {
          beforeEach(async () => {
            subjectMethodologySettings.recenteringSpeed = ZERO;
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Must be valid recentering speed");
          });
        });

        describe("when rebalance interval is shorter than TWAP cooldown period", async () => {
          beforeEach(async () => {
            subjectMethodologySettings.rebalanceInterval = ZERO;
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Rebalance interval must be greater than TWAP cooldown period");
          });
        });
      });

      describe("when rebalance is in progress", async () => {
        let newExchangeSettings: PerpV2ExchangeSettings;

        beforeEach(async () => {
          await initializeRootScopeContracts();
          initializeSubjectVariables();

          newExchangeSettings = {
            twapMaxTradeSize: ether(.1),
            incentivizedTwapMaxTradeSize: ether(1)
          };
          await leverageStrategyExtension.setExchangeSettings(newExchangeSettings);

          await leverageStrategyExtension.deposit(await setToken.getDefaultPositionRealUnit(perpV2Setup.usdc.address));
          // Engage to initial leverage
          await leverageStrategyExtension.engage();
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Rebalance is currently in progress");
        });
      });
    });

    describe("#setExecutionSettings", async () => {
      let subjectExecutionSettings: PerpV2ExecutionSettings;
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

        describe("when slippage tolerance is >100%", async () => {
          beforeEach(async () => {
            subjectExecutionSettings.slippageTolerance = ether(1.1);
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Slippage tolerance must be <100%");
          });
        });

        describe("when TWAP cooldown period is greater than rebalance interval", async () => {
          beforeEach(async () => {
            subjectExecutionSettings.twapCooldownPeriod = ether(1);
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
      });

      describe("when rebalance is in progress", async () => {
        let newExchangeSettings: PerpV2ExchangeSettings;

        beforeEach(async () => {
          await initializeRootScopeContracts();
          initializeSubjectVariables();

          newExchangeSettings = {
            twapMaxTradeSize: ether(.1),
            incentivizedTwapMaxTradeSize: ether(1)
          };
          await leverageStrategyExtension.setExchangeSettings(newExchangeSettings);

          await leverageStrategyExtension.deposit(await setToken.getDefaultPositionRealUnit(perpV2Setup.usdc.address));
          // Engage to initial leverage
          await leverageStrategyExtension.engage();
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Rebalance is currently in progress");
        });
      });
    });

    describe("#setIncentiveSettings", async () => {
      let subjectIncentiveSettings: PerpV2IncentiveSettings;
      let subjectCaller: Account;

      const initializeSubjectVariables = () => {
        subjectIncentiveSettings = {
          incentivizedTwapCooldownPeriod: BigNumber.from(30),
          incentivizedSlippageTolerance: ether(0.1),
          etherReward: ether(5),
          incentivizedLeverageRatio: ether(3.2),
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

        describe("when incentivized TWAP cooldown period is greater than TWAP cooldown period", async () => {
          beforeEach(async () => {
            subjectIncentiveSettings.incentivizedTwapCooldownPeriod = ether(1);
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("TWAP cooldown must be greater than incentivized TWAP cooldown");
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

        describe("when incentivize leverage ratio is less than max leverage ratio", async () => {
          beforeEach(async () => {
            subjectIncentiveSettings.incentivizedLeverageRatio = ether(2);
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Incentivized leverage ratio must be > max leverage ratio");
          });
        });
      });

      describe("when rebalance is in progress", async () => {
        let newExchangeSettings: PerpV2ExchangeSettings;

        beforeEach(async () => {
          await initializeRootScopeContracts();
          initializeSubjectVariables();

          newExchangeSettings = {
            twapMaxTradeSize: ether(.1),
            incentivizedTwapMaxTradeSize: ether(1)
          };
          await leverageStrategyExtension.setExchangeSettings(newExchangeSettings);

          await leverageStrategyExtension.deposit(await setToken.getDefaultPositionRealUnit(perpV2Setup.usdc.address));
          // Engage to initial leverage
          await leverageStrategyExtension.engage();
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Rebalance is currently in progress");
        });
      });
    });

    describe("#setExchangeSettings", async () => {
      let subjectExchangeSettings: PerpV2ExchangeSettings;
      let subjectCaller: Account;

      cacheBeforeEach(initializeRootScopeContracts);
      beforeEach(async () => {
        subjectExchangeSettings = {
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

        expect(exchange.twapMaxTradeSize).to.eq(subjectExchangeSettings.twapMaxTradeSize);
        expect(exchange.incentivizedTwapMaxTradeSize).to.eq(subjectExchangeSettings.incentivizedTwapMaxTradeSize);
      });

      it("should emit ExchangeSettingsUpdated event", async () => {
        await expect(subject()).to.emit(leverageStrategyExtension, "ExchangeSettingsUpdated").withArgs(
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

      describe("when max TWAP trade size is 0", async () => {
        beforeEach(async () => {
          subjectExchangeSettings.twapMaxTradeSize = ZERO;
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Max TWAP trade size must not be 0");
        });
      });

      describe("when max TWAP trade size is greater than incentivized max TWAP trade size", async () => {
        beforeEach(async () => {
          subjectExchangeSettings = {
            twapMaxTradeSize: ether(20),
            incentivizedTwapMaxTradeSize: ether(10)
          };
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Max TWAP trade size must not be greater than incentivized max TWAP trade size");
        });
      });
    });

    describe("#withdrawEtherBalance", async () => {
      let etherReward: BigNumber;
      let subjectCaller: Account;

      const initializeSubjectVariables = async () => {
        etherReward = ether(0.1);
        // Send ETH to contract as reward
        await owner.wallet.sendTransaction({to: leverageStrategyExtension.address, value: etherReward});
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
        let newExchangeSettings: PerpV2ExchangeSettings;

        beforeEach(async () => {
          await initializeRootScopeContracts();
          initializeSubjectVariables();

          newExchangeSettings = {
            twapMaxTradeSize: ether(.1),
            incentivizedTwapMaxTradeSize: ether(1)
          };
          await leverageStrategyExtension.setExchangeSettings(newExchangeSettings);

          await leverageStrategyExtension.deposit(await setToken.getDefaultPositionRealUnit(perpV2Setup.usdc.address));
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

        await leverageStrategyExtension.deposit(await setToken.getDefaultPositionRealUnit(perpV2Setup.usdc.address));
        // Engage to initial leverage
        await leverageStrategyExtension.engage();
        await increaseTimeAsync(BigNumber.from(100000));
      });

      async function subject(): Promise<any> {
        return leverageStrategyExtension.getCurrentEtherIncentive();
      }

      describe("when above incentivized leverage ratio", async () => {
        beforeEach(async () => {
          await owner.wallet.sendTransaction({to: leverageStrategyExtension.address, value: ether(1)});
          await perpV2Setup.setBaseTokenOraclePrice(perpV2Setup.vETH, usdc(650));
          await perpV2PriceFeedMock.setPrice(BigNumber.from(650).mul(10 ** 8));
        });

        it("should return the correct value", async () => {
          const etherIncentive = await subject();

          expect(etherIncentive).to.eq(incentive.etherReward);
        });

        describe("when ETH balance is below ETH reward amount", async () => {
          beforeEach(async () => {
            await leverageStrategyExtension.withdrawEtherBalance();
            // Transfer 0.01 ETH to contract
            await owner.wallet.sendTransaction({to: leverageStrategyExtension.address, value: ether(0.01)});
          });

          it("should return the correct value", async () => {
            const etherIncentive = await subject();

            expect(etherIncentive).to.eq(ether(0.01));
          });
        });
      });

      describe("when below incentivized leverage ratio", async () => {
        beforeEach(async () => {
          await perpV2Setup.setBaseTokenOraclePrice(perpV2Setup.vETH, usdc(2000));
          await perpV2PriceFeedMock.setPrice(BigNumber.from(2000).mul(10 ** 8));
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
        await leverageStrategyExtension.updateCallerStatus([owner.address], [true]);
        await leverageStrategyExtension.deposit(await setToken.getDefaultPositionRealUnit(perpV2Setup.usdc.address));
      });

      async function subject(): Promise<number> {
        return leverageStrategyExtension.connect(subjectCaller.wallet).shouldRebalance();
      }

      context("when long position", async () => {
        cacheBeforeEach(async () => {
          await leverageStrategyExtension.engage();
        });

        context("when in the midst of a TWAP rebalance", async () => {
          let newExchangeSettings: PerpV2ExchangeSettings;

          cacheBeforeEach(async () => {
            // Set up new rebalance TWAP
            await increaseTimeAsync(ONE_DAY_IN_SECONDS);
            await perpV2PriceFeedMock.setPrice(BigNumber.from(900).mul(10 ** 8));

            newExchangeSettings = {
              twapMaxTradeSize: ether(.1),
              incentivizedTwapMaxTradeSize: ether(1)
            };
            await leverageStrategyExtension.setExchangeSettings(newExchangeSettings);

            await leverageStrategyExtension.connect(owner.wallet).rebalance();
          });

          describe("when above incentivized leverage ratio and incentivized TWAP cooldown has elapsed", async () => {
            beforeEach(async () => {
              // Set to above incentivized ratio
              await perpV2PriceFeedMock.setPrice(BigNumber.from(800).mul(10 ** 8));
              await increaseTimeAsync(BigNumber.from(100));    // >60 (incentivized cooldown period)
            });

            it("should verify initial leverage conditions", async () => {
              const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();

              expect(currentLeverageRatio).to.be.gt(incentive.incentivizedLeverageRatio);
            });

            it("should return ripcord", async () => {
              const shouldRebalance = await subject();

              expect(shouldRebalance).to.eq(BigNumber.from(3));
            });
          });

          describe("when below incentivized leverage ratio and regular TWAP cooldown has elapsed", async () => {
            beforeEach(async () => {
              // Set to below incentivized ratio
              await perpV2PriceFeedMock.setPrice(BigNumber.from(900).mul(10 ** 8));
              await increaseTimeAsync(BigNumber.from(4000));    // >3000 (regular cooldown period)
            });

            it("should verify initial leverage conditions", async () => {
              const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();

              expect(currentLeverageRatio).to.be.lt(incentive.incentivizedLeverageRatio);
            });

            it("should return iterate rebalance", async () => {
              const shouldRebalance = await subject();

              expect(shouldRebalance).to.eq(TWO);
            });
          });

          describe("when above incentivized leverage ratio and incentivized TWAP cooldown has NOT elapsed", async () => {
            beforeEach(async () => {
              // Set to above incentivized ratio
              await perpV2PriceFeedMock.setPrice(BigNumber.from(800).mul(10 ** 8));
              await increaseTimeAsync(BigNumber.from(50));    // <60 (incentivized cooldown period)
            });

            it("should verify initial leverage conditions", async () => {
              const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();

              expect(currentLeverageRatio).to.be.gt(incentive.incentivizedLeverageRatio);
            });

            it("should not rebalance", async () => {
              const shouldRebalance = await subject();

              expect(shouldRebalance).to.eq(ZERO);
            });
          });

          describe("when below incentivized leverage ratio and regular TWAP cooldown has NOT elapsed", async () => {
            beforeEach(async () => {
              // Set to below incentivized ratio
              await perpV2PriceFeedMock.setPrice(BigNumber.from(900).mul(10 ** 8));
              await increaseTimeAsync(BigNumber.from(2000));    // <3000 (regular cooldown period)
            });

            it("should verify initial leverage conditions", async () => {
              const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();

              expect(currentLeverageRatio).to.be.lt(incentive.incentivizedLeverageRatio);
            });

            it("should not rebalance", async () => {
              const shouldRebalance = await subject();

              expect(shouldRebalance).to.eq(ZERO);
            });
          });
        });

        context("when not in a TWAP rebalance", async () => {
          describe("when above incentivized leverage ratio and cooldown period has elapsed", async () => {
            beforeEach(async () => {
              // Set to above incentivized ratio
              await perpV2PriceFeedMock.setPrice(BigNumber.from(800).mul(10 ** 8));
              await increaseTimeAsync(BigNumber.from(100));
            });

            it("should verify initial leverage conditions", async () => {
              const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();

              expect(currentLeverageRatio).to.be.gt(incentive.incentivizedLeverageRatio);
            });

            it("should return ripcord", async () => {
              const shouldRebalance = await subject();

              expect(shouldRebalance).to.eq(BigNumber.from(3));
            });
          });

          describe("when between max and min leverage ratio and rebalance interval has elapsed", async () => {
            beforeEach(async () => {
              await perpV2PriceFeedMock.setPrice(BigNumber.from(990).mul(10 ** 8));
              await increaseTimeAsync(BigNumber.from(ONE_DAY_IN_SECONDS));
            });

            it("should verify initial leverage conditions", async () => {
              const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();

              expect(currentLeverageRatio).to.be.gt(methodology.minLeverageRatio);
              expect(currentLeverageRatio).to.be.lt(methodology.maxLeverageRatio);
            });

            it("should return rebalance", async () => {
              const shouldRebalance = await subject();

              expect(shouldRebalance).to.eq(BigNumber.from(1));
            });
          });

          describe("when above max leverage ratio but below incentivized leverage ratio", async () => {
            beforeEach(async () => {
              await perpV2PriceFeedMock.setPrice(BigNumber.from(850).mul(10 ** 8));
              await increaseTimeAsync(BigNumber.from(ONE_DAY_IN_SECONDS));
            });

            it("should verify initial leverage conditions", async () => {
              const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();

              expect(currentLeverageRatio).to.be.gt(methodology.maxLeverageRatio);
              expect(currentLeverageRatio).to.be.lt(incentive.incentivizedLeverageRatio);
            });

            it("should return rebalance", async () => {
              const shouldRebalance = await subject();

              expect(shouldRebalance).to.eq(BigNumber.from(1));
            });
          });

          describe("when below min leverage ratio", async () => {
            beforeEach(async () => {
              await perpV2PriceFeedMock.setPrice(BigNumber.from(1400).mul(10 ** 8));
            });

            it("should verify initial leverage conditions", async () => {
              const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();

              expect(currentLeverageRatio).to.be.lt(methodology.minLeverageRatio);
            });

            it("should return rebalance", async () => {
              const shouldRebalance = await subject();

              expect(shouldRebalance).to.eq(BigNumber.from(1));
            });
          });

          describe("when above incentivized leverage ratio and incentivized TWAP cooldown has NOT elapsed", async () => {
            beforeEach(async () => {
              await perpV2PriceFeedMock.setPrice(BigNumber.from(800).mul(10 ** 8));
            });

            it("should verify initial leverage conditions", async () => {
              const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();

              expect(currentLeverageRatio).to.be.gt(incentive.incentivizedLeverageRatio);
            });

            it("should not rebalance", async () => {
              const shouldRebalance = await subject();

              expect(shouldRebalance).to.eq(ZERO);
            });
          });

          describe("when between max and min leverage ratio and rebalance interval has NOT elapsed", async () => {
            beforeEach(async () => {
              await perpV2PriceFeedMock.setPrice(BigNumber.from(990).mul(10 ** 8));
            });

            it("should verify initial leverage conditions", async () => {
              const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();

              expect(currentLeverageRatio).to.be.gt(methodology.minLeverageRatio);
              expect(currentLeverageRatio).to.be.lt(methodology.maxLeverageRatio);
            });

            it("should not rebalance", async () => {
              const shouldRebalance = await subject();

              expect(shouldRebalance).to.eq(ZERO);
            });
          });
        });
      });

      context("when short position", async () => {
        let newMethodologySettings: PerpV2MethodologySettings;
        let newIncentiveSettings: PerpV2IncentiveSettings;

        cacheBeforeEach(async () => {
          newMethodologySettings = {
            targetLeverageRatio: methodology.targetLeverageRatio.mul(-1),
            minLeverageRatio: methodology.minLeverageRatio.mul(-1),
            maxLeverageRatio: methodology.maxLeverageRatio.mul(-1),
            recenteringSpeed: methodology.recenteringSpeed,
            rebalanceInterval: methodology.rebalanceInterval,
          };
          await leverageStrategyExtension.setMethodologySettings(newMethodologySettings);
          newIncentiveSettings = {
            incentivizedLeverageRatio: incentive.incentivizedLeverageRatio.mul(-1),
            incentivizedSlippageTolerance: incentive.incentivizedSlippageTolerance,
            incentivizedTwapCooldownPeriod: incentive.incentivizedTwapCooldownPeriod,
            etherReward: incentive.etherReward
          };
          await leverageStrategyExtension.setIncentiveSettings(newIncentiveSettings);

          // Engage the Set
          await leverageStrategyExtension.engage();
        });

        context("when in the midst of a TWAP rebalance", async () => {
          let newExchangeSettings: PerpV2ExchangeSettings;

          cacheBeforeEach(async () => {
            // Set up new rebalance TWAP
            await increaseTimeAsync(ONE_DAY_IN_SECONDS);
            await perpV2PriceFeedMock.setPrice(BigNumber.from(1040).mul(10 ** 8));

            newExchangeSettings = {
              twapMaxTradeSize: ether(.1),
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
              await perpV2PriceFeedMock.setPrice(BigNumber.from(1100).mul(10 ** 8));
              await increaseTimeAsync(BigNumber.from(100));    // >60 (incentivized cooldown period)
            });

            it("should verify initial leverage conditions", async () => {
              const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();

              expect(currentLeverageRatio.abs()).to.be.gt(newIncentiveSettings.incentivizedLeverageRatio.abs());
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

              expect(currentLeverageRatio.abs()).to.be.lt(newIncentiveSettings.incentivizedLeverageRatio.abs());
            });

            it("should return iterate rebalance", async () => {
              const shouldRebalance = await subject();

              expect(shouldRebalance).to.eq(TWO);
            });
          });

          describe("when above incentivized leverage ratio and incentivized TWAP cooldown has NOT elapsed", async () => {
            beforeEach(async () => {
              // Set to above incentivized ratio
              await perpV2PriceFeedMock.setPrice(BigNumber.from(1100).mul(10 ** 8));
              await increaseTimeAsync(BigNumber.from(50));    // <60 (incentivized cooldown period)
            });

            it("should verify initial leverage conditions", async () => {
              const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();

              expect(currentLeverageRatio.abs()).to.be.gt(newIncentiveSettings.incentivizedLeverageRatio.abs());
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

              expect(currentLeverageRatio.abs()).to.be.lt(newIncentiveSettings.incentivizedLeverageRatio.abs());
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
              await perpV2PriceFeedMock.setPrice(BigNumber.from(1100).mul(10 ** 8));
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
              await perpV2PriceFeedMock.setPrice(BigNumber.from(1100).mul(10 ** 8));
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

          describe("when between max and min leverage ratio and rebalance interval has NOT elapsed", async () => {
            beforeEach(async () => {
              await perpV2PriceFeedMock.setPrice(BigNumber.from(1010).mul(10 ** 8));
            });

            it("should verify initial leverage conditions", async () => {
              const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();

              expect(currentLeverageRatio.abs()).to.be.gt(methodology.minLeverageRatio.abs());
              expect(currentLeverageRatio.abs()).to.be.lt(methodology.maxLeverageRatio.abs());
            });

            it("should not rebalance", async () => {
              const shouldRebalance = await subject();

              expect(shouldRebalance).to.eq(ZERO);
            });
          });
        });
      });
    });

    describe("#shouldRebalanceWithBounds", async () => {
      let subjectMinLeverageRatio: BigNumber;
      let subjectMaxLeverageRatio: BigNumber;

      cacheBeforeEach(async () => {
        await initializeRootScopeContracts();
        await leverageStrategyExtension.updateCallerStatus([owner.address], [true]);
        await leverageStrategyExtension.deposit(await setToken.getDefaultPositionRealUnit(perpV2Setup.usdc.address));
      });

      beforeEach(() => {
        subjectMinLeverageRatio = ether(1.6);
        subjectMaxLeverageRatio = ether(2.4);
      });

      async function subject(): Promise<number> {
        return leverageStrategyExtension.shouldRebalanceWithBounds(
          subjectMinLeverageRatio,
          subjectMaxLeverageRatio
        );
      }

      context("when long position", async () => {
        cacheBeforeEach(async () => {
          await leverageStrategyExtension.engage();
        });

        context("when in the midst of a TWAP rebalance", async () => {
          let newExchangeSettings: PerpV2ExchangeSettings;

          cacheBeforeEach(async () => {
            // Set up new rebalance TWAP
            await increaseTimeAsync(ONE_DAY_IN_SECONDS);
            await perpV2PriceFeedMock.setPrice(BigNumber.from(900).mul(10 ** 8));

            newExchangeSettings = {
              twapMaxTradeSize: ether(.1),
              incentivizedTwapMaxTradeSize: ether(1)
            };
            await leverageStrategyExtension.setExchangeSettings(newExchangeSettings);

            await leverageStrategyExtension.connect(owner.wallet).rebalance();
          });

          describe("when above incentivized leverage ratio and incentivized TWAP cooldown has elapsed", async () => {
            beforeEach(async () => {
              // Set to above incentivized ratio
              await perpV2PriceFeedMock.setPrice(BigNumber.from(800).mul(10 ** 8));
              await increaseTimeAsync(BigNumber.from(100));    // >60 (incentivized cooldown period)
            });

            it("should verify initial leverage conditions", async () => {
              const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();

              expect(currentLeverageRatio).to.be.gt(incentive.incentivizedLeverageRatio);
            });

            it("should return ripcord", async () => {
              const shouldRebalance = await subject();

              expect(shouldRebalance).to.eq(BigNumber.from(3));
            });
          });

          describe("when below incentivized leverage ratio and regular TWAP cooldown has elapsed", async () => {
            beforeEach(async () => {
              // Set to below incentivized ratio
              await perpV2PriceFeedMock.setPrice(BigNumber.from(900).mul(10 ** 8));
              await increaseTimeAsync(BigNumber.from(4000));    // >3000 (regular cooldown period)
            });

            it("should verify initial leverage conditions", async () => {
              const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();

              expect(currentLeverageRatio).to.be.lt(incentive.incentivizedLeverageRatio);
            });

            it("should return iterate rebalance", async () => {
              const shouldRebalance = await subject();

              expect(shouldRebalance).to.eq(TWO);
            });
          });

          describe("when above incentivized leverage ratio and incentivized TWAP cooldown has NOT elapsed", async () => {
            beforeEach(async () => {
              // Set to above incentivized ratio
              await perpV2PriceFeedMock.setPrice(BigNumber.from(800).mul(10 ** 8));
              await increaseTimeAsync(BigNumber.from(50));    // <60 (incentivized cooldown period)
            });

            it("should verify initial leverage conditions", async () => {
              const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();

              expect(currentLeverageRatio).to.be.gt(incentive.incentivizedLeverageRatio);
            });

            it("should not rebalance", async () => {
              const shouldRebalance = await subject();

              expect(shouldRebalance).to.eq(ZERO);
            });
          });

          describe("when below incentivized leverage ratio and regular TWAP cooldown has NOT elapsed", async () => {
            beforeEach(async () => {
              // Set to below incentivized ratio
              await perpV2PriceFeedMock.setPrice(BigNumber.from(900).mul(10 ** 8));
              await increaseTimeAsync(BigNumber.from(2000));    // <3000 (regular cooldown period)
            });

            it("should verify initial leverage conditions", async () => {
              const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();

              expect(currentLeverageRatio).to.be.lt(incentive.incentivizedLeverageRatio);
            });

            it("should not rebalance", async () => {
              const shouldRebalance = await subject();

              expect(shouldRebalance).to.eq(ZERO);
            });
          });
        });

        context("when not in a TWAP rebalance", async () => {
          describe("when above incentivized leverage ratio and cooldown period has elapsed", async () => {
            beforeEach(async () => {
              // Set to above incentivized ratio
              await perpV2PriceFeedMock.setPrice(BigNumber.from(800).mul(10 ** 8));
              await increaseTimeAsync(BigNumber.from(100));
            });

            it("should verify initial leverage conditions", async () => {
              const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();

              expect(currentLeverageRatio).to.be.gt(incentive.incentivizedLeverageRatio);
            });

            it("should return ripcord", async () => {
              const shouldRebalance = await subject();

              expect(shouldRebalance).to.eq(BigNumber.from(3));
            });
          });

          describe("when between max and min leverage ratio and rebalance interval has elapsed", async () => {
            beforeEach(async () => {
              await perpV2PriceFeedMock.setPrice(BigNumber.from(990).mul(10 ** 8));
              await increaseTimeAsync(BigNumber.from(ONE_DAY_IN_SECONDS));
            });

            it("should verify initial leverage conditions", async () => {
              const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();

              expect(currentLeverageRatio).to.be.gt(methodology.minLeverageRatio);
              expect(currentLeverageRatio).to.be.lt(methodology.maxLeverageRatio);
            });

            it("should return rebalance", async () => {
              const shouldRebalance = await subject();

              expect(shouldRebalance).to.eq(BigNumber.from(1));
            });
          });

          describe("when above max leverage ratio but below incentivized leverage ratio", async () => {
            beforeEach(async () => {
              await perpV2PriceFeedMock.setPrice(BigNumber.from(850).mul(10 ** 8));
              await increaseTimeAsync(BigNumber.from(ONE_DAY_IN_SECONDS));
            });

            it("should verify initial leverage conditions", async () => {
              const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();

              expect(currentLeverageRatio).to.be.gt(methodology.maxLeverageRatio);
              expect(currentLeverageRatio).to.be.lt(incentive.incentivizedLeverageRatio);
            });

            it("should return rebalance", async () => {
              const shouldRebalance = await subject();

              expect(shouldRebalance).to.eq(BigNumber.from(1));
            });
          });

          describe("when below min leverage ratio", async () => {
            beforeEach(async () => {
              await perpV2PriceFeedMock.setPrice(BigNumber.from(1400).mul(10 ** 8));
            });

            it("should verify initial leverage conditions", async () => {
              const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();

              expect(currentLeverageRatio).to.be.lt(methodology.minLeverageRatio);
            });

            it("should return rebalance", async () => {
              const shouldRebalance = await subject();

              expect(shouldRebalance).to.eq(BigNumber.from(1));
            });
          });

          describe("when above incentivized leverage ratio and incentivized TWAP cooldown has NOT elapsed", async () => {
            beforeEach(async () => {
              await perpV2PriceFeedMock.setPrice(BigNumber.from(800).mul(10 ** 8));
            });

            it("should verify initial leverage conditions", async () => {
              const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();

              expect(currentLeverageRatio).to.be.gt(incentive.incentivizedLeverageRatio);
            });

            it("should not rebalance", async () => {
              const shouldRebalance = await subject();

              expect(shouldRebalance).to.eq(ZERO);
            });
          });

          describe("when between max and min leverage ratio and rebalance interval has NOT elapsed", async () => {
            beforeEach(async () => {
              await perpV2PriceFeedMock.setPrice(BigNumber.from(990).mul(10 ** 8));
            });

            it("should verify initial leverage conditions", async () => {
              const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();

              expect(currentLeverageRatio).to.be.gt(methodology.minLeverageRatio);
              expect(currentLeverageRatio).to.be.lt(methodology.maxLeverageRatio);
            });

            it("should not rebalance", async () => {
              const shouldRebalance = await subject();

              expect(shouldRebalance).to.eq(ZERO);
            });
          });

          describe("when custom min leverage ratio is above methodology min leverage ratio", async () => {
            beforeEach(async () => {
              subjectMinLeverageRatio = ether(1.9);
            });

            it("should revert", async () => {
              await expect(subject()).to.be.revertedWith("Custom bounds must be valid");
            });
          });

          describe("when custom max leverage ratio is below methodology max leverage ratio", async () => {
            beforeEach(async () => {
              subjectMinLeverageRatio = ether(2.2);
            });

            it("should revert", async () => {
              await expect(subject()).to.be.revertedWith("Custom bounds must be valid");
            });
          });
        });
      });

      context("when short position", async () => {
        let newMethodologySettings: PerpV2MethodologySettings;
        let newIncentiveSettings: PerpV2IncentiveSettings;

        cacheBeforeEach(async () => {
          newMethodologySettings = {
            targetLeverageRatio: methodology.targetLeverageRatio.mul(-1),
            minLeverageRatio: methodology.minLeverageRatio.mul(-1),
            maxLeverageRatio: methodology.maxLeverageRatio.mul(-1),
            recenteringSpeed: methodology.recenteringSpeed,
            rebalanceInterval: methodology.rebalanceInterval,
          };
          await leverageStrategyExtension.setMethodologySettings(newMethodologySettings);
          newIncentiveSettings = {
            incentivizedLeverageRatio: incentive.incentivizedLeverageRatio.mul(-1),
            incentivizedSlippageTolerance: incentive.incentivizedSlippageTolerance,
            incentivizedTwapCooldownPeriod: incentive.incentivizedTwapCooldownPeriod,
            etherReward: incentive.etherReward
          };
          await leverageStrategyExtension.setIncentiveSettings(newIncentiveSettings);

          // Engage the Set
          await leverageStrategyExtension.engage();
        });

        beforeEach(() => {
          subjectMinLeverageRatio = ether(1.6).mul(-1);
          subjectMaxLeverageRatio = ether(2.4).mul(-1);
        });

        context("when in the midst of a TWAP rebalance", async () => {
          let newExchangeSettings: PerpV2ExchangeSettings;

          cacheBeforeEach(async () => {
            // Set up new rebalance TWAP
            await increaseTimeAsync(ONE_DAY_IN_SECONDS);
            await perpV2PriceFeedMock.setPrice(BigNumber.from(1040).mul(10 ** 8));

            newExchangeSettings = {
              twapMaxTradeSize: ether(.1),
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
              await perpV2PriceFeedMock.setPrice(BigNumber.from(1100).mul(10 ** 8));
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
              await perpV2PriceFeedMock.setPrice(BigNumber.from(900).mul(10 ** 8));
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
              await perpV2PriceFeedMock.setPrice(BigNumber.from(1100).mul(10 ** 8));
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
              await perpV2PriceFeedMock.setPrice(BigNumber.from(1100).mul(10 ** 8));
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
              await perpV2PriceFeedMock.setPrice(BigNumber.from(1100).mul(10 ** 8));
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

          describe("when between max and min leverage ratio and rebalance interval has NOT elapsed", async () => {
            beforeEach(async () => {
              await perpV2PriceFeedMock.setPrice(BigNumber.from(1010).mul(10 ** 8));
            });

            it("should verify initial leverage conditions", async () => {
              const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();

              expect(currentLeverageRatio.abs()).to.be.gt(methodology.minLeverageRatio.abs());
              expect(currentLeverageRatio.abs()).to.be.lt(methodology.maxLeverageRatio.abs());
            });

            it("should not rebalance", async () => {
              const shouldRebalance = await subject();

              expect(shouldRebalance).to.eq(ZERO);
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
    });

    describe("#getChunkRebalanceNotional", async () => {
      cacheBeforeEach(async () => {
        await initializeRootScopeContracts();
        await leverageStrategyExtension.updateCallerStatus([owner.address], [true]);
        await leverageStrategyExtension.deposit(await setToken.getDefaultPositionRealUnit(perpV2Setup.usdc.address));
      });

      async function subject(): Promise<[BigNumber, Address, Address]> {
        return await leverageStrategyExtension.getChunkRebalanceNotional();
      }

      context("when long position", async () => {
        cacheBeforeEach(async () => {
          await leverageStrategyExtension.engage();
          await increaseTimeAsync(ONE_DAY_IN_SECONDS);
        });

        context("when in the midst of a TWAP rebalance", async () => {
          let exchangeSettings: PerpV2ExchangeSettings;
          let preTwapLeverageRatio: BigNumber;

          cacheBeforeEach(async () => {
            // Set up new rebalance TWAP
            await perpV2PriceFeedMock.setPrice(BigNumber.from(900).mul(10 ** 8));

            exchangeSettings = {
              twapMaxTradeSize: ether(.1),
              incentivizedTwapMaxTradeSize: ether(1)
            };
            await leverageStrategyExtension.setExchangeSettings(exchangeSettings);

            preTwapLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();

            await leverageStrategyExtension.connect(owner.wallet).rebalance();
          });

          describe("when above incentivized leverage ratio", async () => {
            beforeEach(async () => {
              // Set to above incentivized ratio
              await perpV2PriceFeedMock.setPrice(BigNumber.from(800).mul(10 ** 8));
            });

            it("should verify initial leverage conditions", async () => {
              const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();

              expect(currentLeverageRatio).to.be.gt(incentive.incentivizedLeverageRatio);
            });

            it("should return correct total rebalance size, sell asset and buy asset", async () => {

              const newLeverageRatio = methodology.maxLeverageRatio;
              const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();

              const [ chunkRebalance, sellAsset, buyAsset ] = await subject();

              const totalRebalanceNotional = await calculateTotalRebalanceNotionalPerpV2(
                setToken,
                perpV2Setup.vETH,
                currentLeverageRatio,
                newLeverageRatio,
                perpV2Setup
              );
              const expectedTotalRebalance = totalRebalanceNotional.abs().gt(exchangeSettings.incentivizedTwapMaxTradeSize)
                ? (
                  totalRebalanceNotional.lt(ZERO)
                    ? exchangeSettings.incentivizedTwapMaxTradeSize.mul(-1)
                    : exchangeSettings.incentivizedTwapMaxTradeSize
                )
                : totalRebalanceNotional;

              expect(sellAsset).to.eq(strategy.virtualBaseAddress);
              expect(buyAsset).to.eq(strategy.virtualQuoteAddress);
              expect(chunkRebalance).to.eq(expectedTotalRebalance);
            });
          });

          describe("when below incentivized leverage ratio", async () => {
            beforeEach(async () => {
              // Set to below incentivized ratio
              await perpV2PriceFeedMock.setPrice(BigNumber.from(900).mul(10 ** 8));
            });

            it("should verify initial leverage conditions", async () => {
              const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();

              expect(currentLeverageRatio).to.be.lt(incentive.incentivizedLeverageRatio);
            });

            it("should return correct total rebalance size, sell asset and buy asset", async () => {
              const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();
              const newLeverageRatio = calculateNewLeverageRatioPerpV2(
                preTwapLeverageRatio,
                methodology.targetLeverageRatio,
                methodology.minLeverageRatio,
                methodology.maxLeverageRatio,
                methodology.recenteringSpeed
              );

              const [ chunkRebalance, sellAsset, buyAsset ] = await subject();

              const totalRebalanceNotional = await calculateTotalRebalanceNotionalPerpV2(
                setToken,
                perpV2Setup.vETH,
                currentLeverageRatio,
                newLeverageRatio,
                perpV2Setup
              );
              const expectedTotalRebalance = totalRebalanceNotional.abs().gt(exchangeSettings.twapMaxTradeSize)
                ? (totalRebalanceNotional.lt(ZERO)
                  ? exchangeSettings.twapMaxTradeSize.mul(-1)
                  : exchangeSettings.twapMaxTradeSize
                )
                : totalRebalanceNotional;

              expect(sellAsset).to.eq(strategy.virtualBaseAddress);
              expect(buyAsset).to.eq(strategy.virtualQuoteAddress);
              expect(chunkRebalance).to.eq(expectedTotalRebalance);
            });
          });
        });

        context("when not in a TWAP rebalance", async () => {
          describe("when above incentivized leverage ratio", async () => {
            beforeEach(async () => {
              // Set to above incentivized ratio
              await perpV2PriceFeedMock.setPrice(BigNumber.from(800).mul(10 ** 8));
            });

            it("should verify initial leverage conditions", async () => {
              const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();

              expect(currentLeverageRatio).to.be.gt(incentive.incentivizedLeverageRatio);
            });

            it("should return correct total rebalance size, sell asset and buy asset", async () => {

              const newLeverageRatio = methodology.maxLeverageRatio;
              const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();

              const [ chunkRebalance, sellAsset, buyAsset ] = await subject();

              const expectedTotalRebalance = await calculateTotalRebalanceNotionalPerpV2(
                setToken,
                perpV2Setup.vETH,
                currentLeverageRatio,
                newLeverageRatio,
                perpV2Setup
              );

              expect(sellAsset).to.eq(strategy.virtualBaseAddress);
              expect(buyAsset).to.eq(strategy.virtualQuoteAddress);
              expect(chunkRebalance).to.eq(expectedTotalRebalance);
            });
          });

          describe("when between max and min leverage ratio", async () => {
            beforeEach(async () => {
              await perpV2PriceFeedMock.setPrice(BigNumber.from(990).mul(10 ** 8));
            });

            it("should verify initial leverage conditions", async () => {
              const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();

              expect(currentLeverageRatio).to.be.gt(methodology.minLeverageRatio);
              expect(currentLeverageRatio).to.be.lt(methodology.maxLeverageRatio);
            });

            it("should return correct total rebalance size, sell asset and buy asset", async () => {
              const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();
              const newLeverageRatio = calculateNewLeverageRatioPerpV2(
                currentLeverageRatio,
                methodology.targetLeverageRatio,
                methodology.minLeverageRatio,
                methodology.maxLeverageRatio,
                methodology.recenteringSpeed
              );

              const [ chunkRebalance, sellAsset, buyAsset ] = await subject();

              const expectedTotalRebalance = await calculateTotalRebalanceNotionalPerpV2(
                setToken,
                perpV2Setup.vETH,
                currentLeverageRatio,
                newLeverageRatio,
                perpV2Setup
              );

              expect(sellAsset).to.eq(strategy.virtualBaseAddress);
              expect(buyAsset).to.eq(strategy.virtualQuoteAddress);
              expect(chunkRebalance).to.eq(expectedTotalRebalance);
            });
          });

          describe("when above max leverage ratio but below incentivized leverage ratio", async () => {
            beforeEach(async () => {
              await perpV2PriceFeedMock.setPrice(BigNumber.from(850).mul(10 ** 8));
            });

            it("should verify initial leverage conditions", async () => {
              const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();

              expect(currentLeverageRatio).to.be.gt(methodology.maxLeverageRatio);
              expect(currentLeverageRatio).to.be.lt(incentive.incentivizedLeverageRatio);
            });

            it("should return correct total rebalance size, sell asset and buy asset", async () => {
              const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();
              const newLeverageRatio = calculateNewLeverageRatioPerpV2(
                currentLeverageRatio,
                methodology.targetLeverageRatio,
                methodology.minLeverageRatio,
                methodology.maxLeverageRatio,
                methodology.recenteringSpeed
              );

              const [ chunkRebalance, sellAsset, buyAsset ] = await subject();

              const expectedTotalRebalance = await calculateTotalRebalanceNotionalPerpV2(
                setToken,
                perpV2Setup.vETH,
                currentLeverageRatio,
                newLeverageRatio,
                perpV2Setup
              );

              expect(sellAsset).to.eq(strategy.virtualBaseAddress);
              expect(buyAsset).to.eq(strategy.virtualQuoteAddress);
              expect(chunkRebalance).to.eq(expectedTotalRebalance);
            });
          });

          describe("when below min leverage ratio", async () => {
            beforeEach(async () => {
              await perpV2PriceFeedMock.setPrice(BigNumber.from(1400).mul(10 ** 8));
            });

            it("should verify initial leverage conditions", async () => {
              const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();

              expect(currentLeverageRatio).to.be.lt(methodology.minLeverageRatio);
            });

            it("should return correct total rebalance size, sell asset and buy asset", async () => {
              const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();
              const newLeverageRatio = calculateNewLeverageRatioPerpV2(
                currentLeverageRatio,
                methodology.targetLeverageRatio,
                methodology.minLeverageRatio,
                methodology.maxLeverageRatio,
                methodology.recenteringSpeed
              );

              const [ chunkRebalance, sellAsset, buyAsset ] = await subject();

              const expectedTotalRebalance = await calculateTotalRebalanceNotionalPerpV2(
                setToken,
                perpV2Setup.vETH,
                currentLeverageRatio,
                newLeverageRatio,
                perpV2Setup
              );

              expect(sellAsset).to.eq(strategy.virtualQuoteAddress);
              expect(buyAsset).to.eq(strategy.virtualBaseAddress);
              expect(chunkRebalance).to.eq(expectedTotalRebalance);
            });
          });
        });
      });

      context("when short position", async () => {
        let newMethodologySettings: PerpV2MethodologySettings;
        let newIncentiveSettings: PerpV2IncentiveSettings;

        cacheBeforeEach(async () => {
          newMethodologySettings = {
            targetLeverageRatio: methodology.targetLeverageRatio.mul(-1),
            minLeverageRatio: methodology.minLeverageRatio.mul(-1),
            maxLeverageRatio: methodology.maxLeverageRatio.mul(-1),
            recenteringSpeed: methodology.recenteringSpeed,
            rebalanceInterval: methodology.rebalanceInterval,
          };
          await leverageStrategyExtension.setMethodologySettings(newMethodologySettings);
          newIncentiveSettings = {
            incentivizedLeverageRatio: incentive.incentivizedLeverageRatio.mul(-1),
            incentivizedSlippageTolerance: incentive.incentivizedSlippageTolerance,
            incentivizedTwapCooldownPeriod: incentive.incentivizedTwapCooldownPeriod,
            etherReward: incentive.etherReward
          };
          await leverageStrategyExtension.setIncentiveSettings(newIncentiveSettings);

          // Engage the Set
          await leverageStrategyExtension.engage();
          await increaseTimeAsync(ONE_DAY_IN_SECONDS);
        });

        context("when in the midst of a TWAP rebalance", async () => {
          let exchangeSettings: PerpV2ExchangeSettings;
          let preTwapLeverageRatio: BigNumber;

          cacheBeforeEach(async () => {
            // Set up new rebalance TWAP
            await perpV2PriceFeedMock.setPrice(BigNumber.from(1040).mul(10 ** 8));

            exchangeSettings = {
              twapMaxTradeSize: ether(.1),
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
              await perpV2PriceFeedMock.setPrice(BigNumber.from(1100).mul(10 ** 8));
            });

            it("should verify initial leverage conditions", async () => {
              const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();

              expect(currentLeverageRatio.abs()).to.be.gt(newIncentiveSettings.incentivizedLeverageRatio.abs());
            });

            it("should return correct total rebalance size, sell asset and buy asset", async () => {
              const newLeverageRatio = newMethodologySettings.maxLeverageRatio;
              const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();

              const [ chunkRebalance, sellAsset, buyAsset ] = await subject();

              const totalRebalanceNotional = await calculateTotalRebalanceNotionalPerpV2(
                setToken,
                perpV2Setup.vETH,
                currentLeverageRatio,
                newLeverageRatio,
                perpV2Setup
              );
              const expectedTotalRebalance = totalRebalanceNotional.abs().gt(exchangeSettings.incentivizedTwapMaxTradeSize)
                ? (
                  totalRebalanceNotional.lt(ZERO)
                    ? exchangeSettings.incentivizedTwapMaxTradeSize.mul(-1)
                    : exchangeSettings.incentivizedTwapMaxTradeSize
                )
                : totalRebalanceNotional;

              expect(sellAsset).to.eq(strategy.virtualQuoteAddress);
              expect(buyAsset).to.eq(strategy.virtualBaseAddress);
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

              expect(currentLeverageRatio.abs()).to.be.lt(newIncentiveSettings.incentivizedLeverageRatio.abs());
            });

            it("should return correct total rebalance size, sell asset and buy asset", async () => {
              const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();
              const newLeverageRatio = calculateNewLeverageRatioPerpV2(
                preTwapLeverageRatio,
                newMethodologySettings.targetLeverageRatio,
                newMethodologySettings.minLeverageRatio,
                newMethodologySettings.maxLeverageRatio,
                newMethodologySettings.recenteringSpeed
              );

              const [ chunkRebalance, sellAsset, buyAsset ] = await subject();

              const totalRebalanceNotional = await calculateTotalRebalanceNotionalPerpV2(
                setToken,
                perpV2Setup.vETH,
                currentLeverageRatio,
                newLeverageRatio,
                perpV2Setup
              );
              const expectedTotalRebalance = totalRebalanceNotional.abs().gt(exchangeSettings.twapMaxTradeSize)
                ? (totalRebalanceNotional.lt(ZERO)
                  ? exchangeSettings.twapMaxTradeSize.mul(-1)
                  : exchangeSettings.twapMaxTradeSize
                )
                : totalRebalanceNotional;

              expect(sellAsset).to.eq(strategy.virtualQuoteAddress);
              expect(buyAsset).to.eq(strategy.virtualBaseAddress);
              expect(chunkRebalance).to.eq(expectedTotalRebalance);
            });
          });
        });

        context("when not in a TWAP rebalance", async () => {
          describe("when above incentivized leverage ratio", async () => {
            beforeEach(async () => {
              // Set to above incentivized ratio
              await perpV2PriceFeedMock.setPrice(BigNumber.from(1100).mul(10 ** 8));
            });

            it("should verify initial leverage conditions", async () => {
              const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();

              expect(currentLeverageRatio.abs()).to.be.gt(newIncentiveSettings.incentivizedLeverageRatio.abs());
            });

            it("should return correct total rebalance size, sell asset and buy asset", async () => {
              const newLeverageRatio = newMethodologySettings.maxLeverageRatio;
              const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();

              const [ chunkRebalance, sellAsset, buyAsset ] = await subject();

              const expectedTotalRebalance = await calculateTotalRebalanceNotionalPerpV2(
                setToken,
                perpV2Setup.vETH,
                currentLeverageRatio,
                newLeverageRatio,
                perpV2Setup
              );

              expect(sellAsset).to.eq(strategy.virtualQuoteAddress);
              expect(buyAsset).to.eq(strategy.virtualBaseAddress);
              expect(chunkRebalance).to.eq(expectedTotalRebalance);
            });
          });

          describe("when between max and min leverage ratio", async () => {
            beforeEach(async () => {
              await perpV2PriceFeedMock.setPrice(BigNumber.from(990).mul(10 ** 8));
            });

            it("should verify initial leverage conditions", async () => {
              const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();

              expect(currentLeverageRatio.abs()).to.be.gt(newMethodologySettings.minLeverageRatio.abs());
              expect(currentLeverageRatio.abs()).to.be.lt(newMethodologySettings.maxLeverageRatio.abs());
            });

            it("should return correct total rebalance size, sell asset and buy asset", async () => {
              const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();
              const newLeverageRatio = calculateNewLeverageRatioPerpV2(
                currentLeverageRatio,
                newMethodologySettings.targetLeverageRatio,
                newMethodologySettings.minLeverageRatio,
                newMethodologySettings.maxLeverageRatio,
                newMethodologySettings.recenteringSpeed
              );

              const [ chunkRebalance, sellAsset, buyAsset ] = await subject();

              const expectedTotalRebalance = await calculateTotalRebalanceNotionalPerpV2(
                setToken,
                perpV2Setup.vETH,
                currentLeverageRatio,
                newLeverageRatio,
                perpV2Setup
              );

              expect(buyAsset).to.eq(strategy.virtualQuoteAddress);
              expect(sellAsset).to.eq(strategy.virtualBaseAddress);
              expect(chunkRebalance).to.eq(expectedTotalRebalance);
            });
          });

          describe("when above max leverage ratio but below incentivized leverage ratio", async () => {
            beforeEach(async () => {
              await perpV2PriceFeedMock.setPrice(BigNumber.from(1050).mul(10 ** 8));
            });

            it("should verify initial leverage conditions", async () => {
              const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();

              expect(currentLeverageRatio.abs()).to.be.gt(newMethodologySettings.maxLeverageRatio.abs());
              expect(currentLeverageRatio.abs()).to.be.lt(newIncentiveSettings.incentivizedLeverageRatio.abs());
            });

            it("should return correct total rebalance size, sell asset and buy asset", async () => {
              const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();
              const newLeverageRatio = calculateNewLeverageRatioPerpV2(
                currentLeverageRatio,
                newMethodologySettings.targetLeverageRatio,
                newMethodologySettings.minLeverageRatio,
                newMethodologySettings.maxLeverageRatio,
                newMethodologySettings.recenteringSpeed
              );

              const [ chunkRebalance, sellAsset, buyAsset ] = await subject();

              const expectedTotalRebalance = await calculateTotalRebalanceNotionalPerpV2(
                setToken,
                perpV2Setup.vETH,
                currentLeverageRatio,
                newLeverageRatio,
                perpV2Setup
              );

              expect(buyAsset).to.eq(strategy.virtualBaseAddress);
              expect(sellAsset).to.eq(strategy.virtualQuoteAddress);
              expect(chunkRebalance).to.eq(expectedTotalRebalance);
            });
          });

          describe("when below min leverage ratio", async () => {
            beforeEach(async () => {
              await perpV2PriceFeedMock.setPrice(BigNumber.from(900).mul(10 ** 8));
            });

            it("should verify initial leverage conditions", async () => {
              const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();

              expect(currentLeverageRatio.abs()).to.be.lt(newMethodologySettings.minLeverageRatio.abs());
            });

            it("should return correct total rebalance size, sell asset and buy asset", async () => {
              const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();
              const newLeverageRatio = calculateNewLeverageRatioPerpV2(
                currentLeverageRatio,
                newMethodologySettings.targetLeverageRatio,
                newMethodologySettings.minLeverageRatio,
                newMethodologySettings.maxLeverageRatio,
                newMethodologySettings.recenteringSpeed
              );

              const [ chunkRebalance, sellAsset, buyAsset ] = await subject();

              const expectedTotalRebalance = await calculateTotalRebalanceNotionalPerpV2(
                setToken,
                perpV2Setup.vETH,
                currentLeverageRatio,
                newLeverageRatio,
                perpV2Setup
              );

              expect(buyAsset).to.eq(strategy.virtualQuoteAddress);
              expect(sellAsset).to.eq(strategy.virtualBaseAddress);
              expect(chunkRebalance).to.eq(expectedTotalRebalance);
            });
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
