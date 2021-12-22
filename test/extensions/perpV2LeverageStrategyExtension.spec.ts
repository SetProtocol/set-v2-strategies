import "module-alias/register";
import { BigNumber, ContractTransaction } from "ethers";

import {
  Address,
  Account,
  PerpV2ContractSettings,
  PerpV2MethodologySettings,
  PerpV2ExecutionSettings,
  PerpV2IncentiveSettings,
  PerpV2ExchangeSettings
} from "@utils/types";

import { ADDRESS_ZERO, ZERO, ONE_DAY_IN_SECONDS } from "../../utils/constants";
import {
  PerpV2LeverageModule,
  SetToken,
  ChainlinkAggregatorMock,
  PerpV2,
  SlippageIssuanceModule
} from "@setprotocol/set-protocol-v2/dist/utils/contracts";
import DeployHelper from "../../utils/deploys";
import {
  cacheBeforeEach,
  calculateNewLeverageRatio,
  ether,
  getAccounts,
  getLastBlockTimestamp,
  getRandomAccount,
  getWaffleExpect,
  preciseDiv,
  preciseMul,
  usdc,
  increaseTimeAsync,
} from "../../utils/index";


import { PerpV2Fixture, SystemFixture } from "@setprotocol/set-protocol-v2/dist/utils/fixtures";
import { getPerpV2Fixture, getSystemFixture } from "@setprotocol/set-protocol-v2/dist/utils/test";

import { BaseManagerV2, PerpV2LeverageStrategyExtension } from "@utils/contracts/index";

const expect = getWaffleExpect();

describe.only("PerpV2LeverageStrategyExtension", () => {
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

  let leverageStrategyExtension: PerpV2LeverageStrategyExtension;
  let perpV2LeverageModule: PerpV2LeverageModule;
  let perpLib: PerpV2;
  let issuanceModule: SlippageIssuanceModule;
  let baseManagerV2: BaseManagerV2;

  let chainlinkBasePriceMock: ChainlinkAggregatorMock;
  let chainlinkQuotePriceMock: ChainlinkAggregatorMock;

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

    // Create liquidity
    await perpV2Setup.setBaseTokenOraclePrice(perpV2Setup.vETH, usdc(1000));
    await perpV2Setup.usdc.mint(perpV2Setup.maker.address, usdc(5000000));
    await perpV2Setup.deposit(perpV2Setup.maker, BigNumber.from(5000000), perpV2Setup.usdc);
    await perpV2Setup.initializePoolWithLiquidityWide(
      perpV2Setup.vETH,
      ether(10000),
      ether(10000000)
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
    chainlinkBasePriceMock = await deployer.mocks.deployChainlinkAggregatorMock(8);
    await chainlinkBasePriceMock.setLatestAnswer(BigNumber.from(1000).mul(10 ** 8));
    chainlinkQuotePriceMock = await deployer.mocks.deployChainlinkAggregatorMock(8);
    await chainlinkQuotePriceMock.setLatestAnswer(10 ** 8);
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

    baseManagerV2 = await deployer.manager.deployBaseManagerV2(
      setToken.address,
      owner.address,
      methodologist.address,
    );

    // Transfer ownership to ic manager
    if ((await setToken.manager()) == owner.address) {
      await setToken.connect(owner.wallet).setManager(baseManagerV2.address);
    }

    // Deploy adapter
    const targetLeverageRatio = customTargetLeverageRatio || ether(2);
    const minLeverageRatio = customMinLeverageRatio || ether(1.7);
    const maxLeverageRatio = ether(2.3);
    const recenteringSpeed = ether(0.05);
    const rebalanceInterval = BigNumber.from(86400);

    const unutilizedLeveragePercentage = ether(0.01);
    const twapMaxTradeSize = ether(1);
    const twapCooldownPeriod = BigNumber.from(3000);
    const slippageTolerance = ether(0.015);

    const incentivizedTwapMaxTradeSize = ether(2);
    const incentivizedTwapCooldownPeriod = BigNumber.from(60);
    const incentivizedSlippageTolerance = ether(0.05);
    const etherReward = ether(1);
    const incentivizedLeverageRatio = ether(2.6);

    strategy = {
      setToken: setToken.address,
      perpV2LeverageModule: perpV2LeverageModule.address,
      perpV2AccountBalance: perpV2Setup.accountBalance.address,
      basePriceOracle: chainlinkBasePriceMock.address,
      quotePriceOracle: chainlinkQuotePriceMock.address,
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
      unutilizedLeveragePercentage: unutilizedLeveragePercentage,
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
      baseManagerV2.address,
      strategy,
      methodology,
      execution,
      incentive,
      exchange
    );

    // Add adapter
    await baseManagerV2.connect(owner.wallet).addExtension(leverageStrategyExtension.address);
    await baseManagerV2.connect(methodologist.wallet).authorizeInitialization();

    await perpV2Setup.usdc.approve(issuanceModule.address, usdc(1000));
    await issuanceModule.connect(owner.wallet).issue(setToken.address, ether(10), owner.address);
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
      subjectManagerAddress = baseManagerV2.address;
      subjectContractSettings = {
        setToken: setToken.address,
        perpV2LeverageModule: perpV2LeverageModule.address,
        perpV2AccountBalance: perpV2Setup.accountBalance.address,
        basePriceOracle: chainlinkBasePriceMock.address,
        quotePriceOracle: chainlinkQuotePriceMock.address,
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
        unutilizedLeveragePercentage: ether(0.01),
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
        twapMaxTradeSize: ether(0.1),
        incentivizedTwapMaxTradeSize: ether(1),
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
      expect(strategy.basePriceOracle).to.eq(subjectContractSettings.basePriceOracle);
      expect(strategy.quotePriceOracle).to.eq(subjectContractSettings.quotePriceOracle);
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

      expect(execution.unutilizedLeveragePercentage).to.eq(subjectExecutionSettings.unutilizedLeveragePercentage);
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

    describe("when unutilizedLeveragePercentage is >100%", async () => {
      beforeEach(async () => {
        subjectExecutionSettings.unutilizedLeveragePercentage = ether(1.1);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Unutilized leverage must be <100%");
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
      beforeEach(async () => {
        subjectCaller = owner;
      });

      async function subject(): Promise<ContractTransaction> {
        return await leverageStrategyExtension.connect(subjectCaller.wallet).deposit();
      }

      it("should deposit assets USDC into Perpetual Protocol", async () => {
        const preUsdcDefaultUnit = await setToken.getDefaultPositionRealUnit(perpV2Setup.usdc.address);

        await subject();

        const postUsdcDefaultUnit = await setToken.getDefaultPositionRealUnit(perpV2Setup.usdc.address);
        const postUsdcExternalUnit = await setToken.getExternalPositionRealUnit(perpV2Setup.usdc.address, perpV2LeverageModule.address);

        expect(postUsdcExternalUnit).to.eq(preUsdcDefaultUnit);
        expect(postUsdcDefaultUnit).to.eq(ZERO);
      });

      describe("when no USDC to be deposited", async () => {
        beforeEach(async () => {
          await subject();
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("No USDC to deposit");
        });
      });
    });

    describe("#engage", async () => {
      let subjectCaller: Account;

      let shouldDeposit: boolean = true;

      beforeEach(async () => {
        if (shouldDeposit) {
          await leverageStrategyExtension.deposit();
        }

        subjectCaller = owner;
      });

      async function subject(): Promise<any> {
        leverageStrategyExtension = leverageStrategyExtension.connect(subjectCaller.wallet);
        return leverageStrategyExtension.engage();
      }

      context("when rebalance notional is greater than max trade size", async () => {
        describe("when the collateral balance is not zero", () => {

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
            expect(finalPositions[0].baseBalance).to.eq(exchange.twapMaxTradeSize);
            expect(finalPositions[0].baseToken).to.eq(strategy.virtualBaseAddress);
          });

          it("should emit Engaged event", async () => {
            const currentCollateral = (await perpV2LeverageModule.getAccountInfo(setToken.address)).collateralBalance;
            const basePrice = (await perpV2Setup.ethPriceFeed.latestAnswer()).div(usdc(1));

            const chunkRebalanceNotional = exchange.twapMaxTradeSize;
            const totalRebalanceNotional = preciseMul(currentCollateral, methodology.targetLeverageRatio).div(basePrice);

            await expect(subject()).to.emit(leverageStrategyExtension, "Engaged").withArgs(
              ZERO,
              methodology.targetLeverageRatio,
              chunkRebalanceNotional,
              totalRebalanceNotional,
            );
          });

          describe("when borrow balance is not 0", async () => {
            beforeEach(async () => {
              await subject();
            });

            it("should revert", async () => {
              await expect(subject()).to.be.revertedWith("Must not have existing base token position");
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

      context("when rebalance notional is less than max trade size", async () => {
        beforeEach(async () => {
          const newSettings = {
            twapMaxTradeSize: ether(2.5),
            incentivizedTwapMaxTradeSize: ether(5),
          };
          await leverageStrategyExtension.setExchangeSettings(newSettings);
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
            methodology.targetLeverageRatio,
            totalRebalanceNotional,
            totalRebalanceNotional,
          );
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

          const totalRebalanceNotional = exchange.twapMaxTradeSize.mul(-1);

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

          expect(twapLeverageRatio).to.eq(methodology.targetLeverageRatio.mul(-1));
        });

        it("should emit Engaged event", async () => {
          const currentCollateral = (await perpV2LeverageModule.getAccountInfo(setToken.address)).collateralBalance;
          const targetLeverageRatio = (await leverageStrategyExtension.getMethodology()).targetLeverageRatio;
          const basePrice = (await perpV2Setup.ethPriceFeed.latestAnswer()).div(usdc(1));

          const chunkRebalanceNotional = exchange.twapMaxTradeSize.mul(-1);
          const totalRebalanceNotional = preciseMul(currentCollateral, targetLeverageRatio).div(basePrice);

          await expect(subject()).to.emit(leverageStrategyExtension, "Engaged").withArgs(
            ZERO,
            newMethodologySettings.targetLeverageRatio,
            chunkRebalanceNotional,
            totalRebalanceNotional,
          );
        });

        describe("when rebalance notional is less than max trade size ", async () => {
          beforeEach(async () => {
            const newSettings = {
              twapMaxTradeSize: ether(2.5),
              incentivizedTwapMaxTradeSize: ether(5),
            };
            await leverageStrategyExtension.setExchangeSettings(newSettings);
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
        });
      });
    });

    describe("#rebalance", async () => {
      let subjectCaller: Account;

      cacheBeforeEach(async () => {
        await leverageStrategyExtension.deposit();

        await leverageStrategyExtension.updateCallerStatus([owner.address], [true]);
        await leverageStrategyExtension.engage();
        await increaseTimeAsync(execution.twapCooldownPeriod);
        await leverageStrategyExtension.iterateRebalance();

        subjectCaller = owner;
      });

      async function subject(): Promise<any> {
        return leverageStrategyExtension.connect(subjectCaller.wallet).rebalance();
      }

      context("when current leverage ratio is below target (lever), does not need a TWAP, and is inside bounds", async () => {
        cacheBeforeEach(async () => {
          await perpV2Setup.setBaseTokenOraclePrice(perpV2Setup.vETH, usdc(1100));
          await chainlinkBasePriceMock.setLatestAnswer(BigNumber.from(1100).mul(10 ** 8));

          await increaseTimeAsync(ONE_DAY_IN_SECONDS);
        });

        it("should set the global last trade timestamp", async () => {
          await subject();

          const lastTradeTimestamp = await leverageStrategyExtension.lastTradeTimestamp();

          expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
        });

        it("should set the exchange's last trade timestamp", async () => {
          await subject();

          const lastTradeTimestamp = await leverageStrategyExtension.lastTradeTimestamp();

          expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
        });

        it("should not set the TWAP leverage ratio", async () => {
          await subject();

          const twapLeverageRatio = await leverageStrategyExtension.twapLeverageRatio();

          expect(twapLeverageRatio).to.eq(ZERO);
        });

        it("should update the collateral position on the SetToken correctly", async () => {
          const initialPositions = await perpV2LeverageModule.getPositionNotionalInfo(setToken.address);

          const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();

          await subject();

          const expectedNewLeverageRatio = calculateNewLeverageRatio(
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

        it.only("should emit Rebalanced event", async () => {
          const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();
          const expectedNewLeverageRatio = calculateNewLeverageRatio(
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
          await chainlinkBasePriceMock.setLatestAnswer(BigNumber.from(1250).mul(10 ** 8));
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

        it("should update the collateral position on the SetToken correctly", async () => {
          const initialPositions = await perpV2LeverageModule.getPositionNotionalInfo(setToken.address);

          const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();

          await subject();

          const expectedNewLeverageRatio = calculateNewLeverageRatio(
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
          await chainlinkBasePriceMock.setLatestAnswer(BigNumber.from(1500).mul(10 ** 8));

          newSettings = {
            twapMaxTradeSize: ether(0.2),
            incentivizedTwapMaxTradeSize: ether(2),
          };
          await leverageStrategyExtension.setExchangeSettings(newSettings);
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

          const expectedNewLeverageRatio = calculateNewLeverageRatio(
            currentLeverageRatio,
            methodology.targetLeverageRatio,
            methodology.minLeverageRatio,
            methodology.maxLeverageRatio,
            methodology.recenteringSpeed
          );
          expect(previousTwapLeverageRatio).to.eq(ZERO);
          expect(currentTwapLeverageRatio).to.eq(expectedNewLeverageRatio);
        });

        it("should update the collateral position on the SetToken correctly", async () => {
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

      context("when current leverage ratio is above target (delever)", async () => {
        cacheBeforeEach(async () => {
          await chainlinkBasePriceMock.setLatestAnswer(BigNumber.from(900).mul(10 ** 8));
          await perpV2Setup.setBaseTokenOraclePrice(perpV2Setup.vETH, usdc(900));

          await increaseTimeAsync(ONE_DAY_IN_SECONDS);
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

        it("should update the collateral position on the SetToken correctly", async () => {
          const initialPositions = await perpV2LeverageModule.getPositionNotionalInfo(setToken.address);

          const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();

          await subject();

          const expectedNewLeverageRatio = calculateNewLeverageRatio(
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

      describe.only("when rebalance interval has not elapsed above max leverage ratio and greater than max trade size", async () => {
        let newSettings: PerpV2ExchangeSettings;

        cacheBeforeEach(async () => {
          await perpV2Setup.setBaseTokenOraclePrice(perpV2Setup.vETH, usdc(850));
          await chainlinkBasePriceMock.setLatestAnswer(BigNumber.from(850).mul(10 ** 8));

          newSettings = {
            twapMaxTradeSize: ether(0.2),
            incentivizedTwapMaxTradeSize: ether(2),
          };
          await leverageStrategyExtension.setExchangeSettings(newSettings);
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

          const expectedNewLeverageRatio = calculateNewLeverageRatio(
            currentLeverageRatio,
            methodology.targetLeverageRatio,
            methodology.minLeverageRatio,
            methodology.maxLeverageRatio,
            methodology.recenteringSpeed
          );
          expect(previousTwapLeverageRatio).to.eq(ZERO);
          expect(currentTwapLeverageRatio).to.eq(expectedNewLeverageRatio);
        });

        it("should update the collateral position on the SetToken correctly", async () => {
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
    });

    //     describe("when rebalance interval has not elapsed", async () => {
    //       beforeEach(async () => {
    //         await subject();
    //       });

    //       it("should revert", async () => {
    //         await expect(subject()).to.be.revertedWith("Cooldown not elapsed or not valid leverage ratio");
    //       });
    //     });

    //     describe("when in a TWAP rebalance", async () => {
    //       beforeEach(async () => {
    //         await increaseTimeAsync(BigNumber.from(100000));
    //         await chainlinkBasePriceMock.setLatestAnswer(BigNumber.from(1200).mul(10 ** 8));

    //         const newPerpV2ExchangeSettings: PerpV2ExchangeSettings = {
    //           twapMaxTradeSize: ether(0.01),
    //           incentivizedTwapMaxTradeSize: exchange.incentivizedTwapMaxTradeSize,
    //           exchangeLastTradeTimestamp: exchange.exchangeLastTradeTimestamp,
    //           leverExchangeData: EMPTY_BYTES,
    //           deleverExchangeData: EMPTY_BYTES,
    //         };
    //         await leverageStrategyExtension.updateEnabledExchange(subjectExchangeName, newPerpV2ExchangeSettings);
    //         await systemSetup.weth.transfer(tradeAdapterMock.address, ether(0.01));

    //         await subject();
    //       });

    //       it("should revert", async () => {
    //         await expect(subject()).to.be.revertedWith("Must call iterate");
    //       });
    //     });

    //     describe("when borrow balance is 0", async () => {
    //       beforeEach(async () => {
    //       });

    //       it("should revert", async () => {
    //         await expect(subject()).to.be.revertedWith("Borrow balance must exist");
    //       });
    //     });

    //     describe("when caller is not an allowed trader", async () => {
    //       beforeEach(async () => {
    //         subjectCaller = await getRandomAccount();
    //       });

    //       it("should revert", async () => {
    //         await expect(subject()).to.be.revertedWith("Address not permitted to call");
    //       });
    //     });

    //     describe("when caller is a contract", async () => {
    //       let subjectTarget: Address;
    //       let subjectCallData: string;
    //       let subjectValue: BigNumber;

    //       let contractCaller: ContractCallerMock;

    //       beforeEach(async () => {
    //         contractCaller = await deployer.setV2.deployContractCallerMock();

    //         subjectTarget = leverageStrategyExtension.address;
    //         subjectCallData = leverageStrategyExtension.interface.encodeFunctionData("rebalance", [ subjectExchangeName ]);
    //         subjectValue = ZERO;
    //       });

    //       async function subjectContractCaller(): Promise<any> {
    //         return await contractCaller.invoke(
    //           subjectTarget,
    //           subjectValue,
    //           subjectCallData
    //         );
    //       }

    //       it("the trade reverts", async () => {
    //         await expect(subjectContractCaller()).to.be.revertedWith("Caller must be EOA Address");
    //       });
    //     });

    //     describe("when SetToken has 0 supply", async () => {
    //       beforeEach(async () => {
    //         await systemSetup.usdc.approve(issuanceModule.address, MAX_UINT_256);
    //         await issuanceModule.redeem(setToken.address, ether(1), owner.address);
    //       });

    //       it("should revert", async () => {
    //         await expect(subject()).to.be.revertedWith("SetToken must have > 0 supply");
    //       });
    //     });
    //   });

    //   context("when current leverage ratio is above target (delever)", async () => {
    //     cacheBeforeEach(async () => {
    //       // Withdraw balance of USDC from exchange contract from engage
    //       await tradeAdapterMock.withdraw(systemSetup.usdc.address);
    //       await increaseTimeAsync(BigNumber.from(100000));
    //       // Set to $990 so need to delever
    //       await chainlinkBasePriceMock.setLatestAnswer(BigNumber.from(990).mul(10 ** 8));
    //       await perpV2Setup.setAssetLatestAnswerInOracle(systemSetup.usdc.address, ether(1 / 990));
    //       await systemSetup.usdc.transfer(tradeAdapterMock.address, BigNumber.from(2500000));
    //     });

    //     beforeEach(() => {
    //       subjectCaller = owner;
    //     });

    //     async function subject(): Promise<any> {
    //       return leverageStrategyExtension.connect(subjectCaller.wallet).rebalance(subjectExchangeName);
    //     }

    //     it("should set the last trade timestamp", async () => {
    //       await subject();

    //       const lastTradeTimestamp = await leverageStrategyExtension.globalLastTradeTimestamp();

    //       expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
    //     });

    //     it("should set the exchange's last trade timestamp", async () => {
    //       await subject();

    //       const exchange = await leverageStrategyExtension.getPerpV2ExchangeSettings(subjectExchangeName);
    //       const lastTradeTimestamp = exchange.exchangeLastTradeTimestamp;

    //       expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
    //     });

    //     it("should not set the TWAP leverage ratio", async () => {
    //       await subject();

    //       const twapLeverageRatio = await leverageStrategyExtension.twapLeverageRatio();

    //       expect(twapLeverageRatio).to.eq(ZERO);
    //     });

    //     it("should update the collateral position on the SetToken correctly", async () => {
    //       const initialPositions = await setToken.getPositions();
    //       const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();

    //       const previousATokenBalance = await aWeth.balanceOf(setToken.address);

    //       await subject();

    //       // aWeth position is decreased
    //       const currentPositions = await setToken.getPositions();
    //       const newFirstPosition = (await setToken.getPositions())[0];

    //       const expectedNewLeverageRatio = calculateNewLeverageRatio(
    //         currentLeverageRatio,
    //         methodology.targetLeverageRatio,
    //         methodology.minLeverageRatio,
    //         methodology.maxLeverageRatio,
    //         methodology.recenteringSpeed
    //       );
    //       // Get expected redeemed
    //       const expectedCollateralAssetsRedeemed = calculateCollateralRebalanceUnits(
    //         currentLeverageRatio,
    //         expectedNewLeverageRatio,
    //         previousATokenBalance,
    //         ether(1) // Total supply
    //       );

    //       const expectedFirstPositionUnit = initialPositions[0].unit.sub(expectedCollateralAssetsRedeemed);

    //       expect(initialPositions.length).to.eq(2);
    //       expect(currentPositions.length).to.eq(2);
    //       expect(newFirstPosition.component).to.eq(aWeth.address);
    //       expect(newFirstPosition.positionState).to.eq(0); // Default
    //       expect(newFirstPosition.unit).to.eq(expectedFirstPositionUnit);
    //       expect(newFirstPosition.module).to.eq(ADDRESS_ZERO);
    //     });

    //     it("should update the borrow position on the SetToken correctly", async () => {
    //       const initialPositions = await setToken.getPositions();

    //       await subject();

    //       // aWeth position is increased
    //       const currentPositions = await setToken.getPositions();
    //       const newSecondPosition = (await setToken.getPositions())[1];

    //       const expectedSecondPositionUnit = (await usdcVariableDebtToken.balanceOf(setToken.address)).mul(-1);

    //       expect(initialPositions.length).to.eq(2);
    //       expect(currentPositions.length).to.eq(2);
    //       expect(newSecondPosition.component).to.eq(systemSetup.usdc.address);
    //       expect(newSecondPosition.positionState).to.eq(1); // External
    //       expect(newSecondPosition.unit).to.eq(expectedSecondPositionUnit);
    //       expect(newSecondPosition.module).to.eq(perpV2LeverageModule.address);
    //     });

    //     describe("when rebalance interval has not elapsed above max leverage ratio and lower than max trade size", async () => {
    //       cacheBeforeEach(async () => {
    //         await leverageStrategyExtension.connect(owner.wallet).rebalance(subjectExchangeName);
    //         // ~2.4x leverage
    //         await chainlinkBasePriceMock.setLatestAnswer(BigNumber.from(850).mul(10 ** 8));
    //         const newPerpV2ExchangeSettings: PerpV2ExchangeSettings = {
    //           twapMaxTradeSize: ether(1.9),
    //           incentivizedTwapMaxTradeSize: exchange.incentivizedTwapMaxTradeSize,
    //           exchangeLastTradeTimestamp: exchange.exchangeLastTradeTimestamp,
    //           leverExchangeData: EMPTY_BYTES,
    //           deleverExchangeData: EMPTY_BYTES,
    //         };
    //         await leverageStrategyExtension.updateEnabledExchange(subjectExchangeName, newPerpV2ExchangeSettings);
    //         await systemSetup.usdc.transfer(tradeAdapterMock.address, BigNumber.from(100000000));
    //       });

    //       it("should set the last trade timestamp", async () => {
    //         await subject();

    //         const lastTradeTimestamp = await leverageStrategyExtension.globalLastTradeTimestamp();

    //         expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
    //       });

    //       it("should set the exchange's last trade timestamp", async () => {
    //         await subject();

    //         const exchange = await leverageStrategyExtension.getPerpV2ExchangeSettings(subjectExchangeName);
    //         const lastTradeTimestamp = exchange.exchangeLastTradeTimestamp;

    //         expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
    //       });

    //       it("should not set the TWAP leverage ratio", async () => {
    //         await subject();

    //         const twapLeverageRatio = await leverageStrategyExtension.twapLeverageRatio();

    //         expect(twapLeverageRatio).to.eq(ZERO);
    //       });

    //       it("should update the collateral position on the SetToken correctly", async () => {
    //         const initialPositions = await setToken.getPositions();
    //         const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();

    //         const previousATokenBalance = await aWeth.balanceOf(setToken.address);

    //         await subject();

    //         // aWeth position is decreased
    //         const currentPositions = await setToken.getPositions();
    //         const newFirstPosition = (await setToken.getPositions())[0];

    //         const expectedNewLeverageRatio = calculateNewLeverageRatio(
    //           currentLeverageRatio,
    //           methodology.targetLeverageRatio,
    //           methodology.minLeverageRatio,
    //           methodology.maxLeverageRatio,
    //           methodology.recenteringSpeed
    //         );
    //         // Get expected redeemed
    //         const expectedCollateralAssetsRedeemed = calculateCollateralRebalanceUnits(
    //           currentLeverageRatio,
    //           expectedNewLeverageRatio,
    //           previousATokenBalance,
    //           ether(1) // Total supply
    //         );

    //         const expectedFirstPositionUnit = initialPositions[0].unit.sub(expectedCollateralAssetsRedeemed);

    //         expect(initialPositions.length).to.eq(2);
    //         expect(currentPositions.length).to.eq(2);
    //         expect(newFirstPosition.component).to.eq(aWeth.address);
    //         expect(newFirstPosition.positionState).to.eq(0); // Default
    //         expect(newFirstPosition.unit).to.eq(expectedFirstPositionUnit);
    //         expect(newFirstPosition.module).to.eq(ADDRESS_ZERO);
    //       });

    //       it("should update the borrow position on the SetToken correctly", async () => {
    //         const initialPositions = await setToken.getPositions();

    //         await subject();

    //         // aWeth position is increased
    //         const currentPositions = await setToken.getPositions();
    //         const newSecondPosition = (await setToken.getPositions())[1];

    //         const expectedSecondPositionUnit = (await usdcVariableDebtToken.balanceOf(setToken.address)).mul(-1);

    //         expect(initialPositions.length).to.eq(2);
    //         expect(currentPositions.length).to.eq(2);
    //         expect(newSecondPosition.component).to.eq(systemSetup.usdc.address);
    //         expect(newSecondPosition.positionState).to.eq(1); // External
    //         expect(newSecondPosition.unit).to.eq(expectedSecondPositionUnit);
    //         expect(newSecondPosition.module).to.eq(perpV2LeverageModule.address);
    //       });
    //     });

    //     describe("when rebalance interval has not elapsed above max leverage ratio and greater than max trade size", async () => {
    //       let newTWAPMaxTradeSize: BigNumber;

    //       cacheBeforeEach(async () => {
    //         await leverageStrategyExtension.connect(owner.wallet).rebalance(subjectExchangeName);

    //         // > Max trade size
    //         newTWAPMaxTradeSize = ether(0.01);
    //         const newPerpV2ExchangeSettings: PerpV2ExchangeSettings = {
    //           twapMaxTradeSize: newTWAPMaxTradeSize,
    //           incentivizedTwapMaxTradeSize: exchange.incentivizedTwapMaxTradeSize,
    //           exchangeLastTradeTimestamp: exchange.exchangeLastTradeTimestamp,
    //           leverExchangeData: EMPTY_BYTES,
    //           deleverExchangeData: EMPTY_BYTES,
    //         };
    //         await leverageStrategyExtension.updateEnabledExchange(subjectExchangeName, newPerpV2ExchangeSettings);
    //         // ~2.4x leverage
    //         await chainlinkBasePriceMock.setLatestAnswer(BigNumber.from(850).mul(10 ** 8));
    //         await systemSetup.usdc.transfer(tradeAdapterMock.address, BigNumber.from(10000000));
    //       });

    //       it("should set the last trade timestamp", async () => {
    //         await subject();

    //         const lastTradeTimestamp = await leverageStrategyExtension.globalLastTradeTimestamp();

    //         expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
    //       });

    //       it("should set the exchange's last trade timestamp", async () => {
    //         await subject();

    //         const exchange = await leverageStrategyExtension.getPerpV2ExchangeSettings(subjectExchangeName);
    //         const lastTradeTimestamp = exchange.exchangeLastTradeTimestamp;

    //         expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
    //       });

    //       it("should set the TWAP leverage ratio", async () => {
    //         const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();
    //         const previousTwapLeverageRatio = await leverageStrategyExtension.twapLeverageRatio();

    //         await subject();

    //         const currentTwapLeverageRatio = await leverageStrategyExtension.twapLeverageRatio();

    //         const expectedNewLeverageRatio = calculateNewLeverageRatio(
    //           currentLeverageRatio,
    //           methodology.targetLeverageRatio,
    //           methodology.minLeverageRatio,
    //           methodology.maxLeverageRatio,
    //           methodology.recenteringSpeed
    //         );
    //         expect(previousTwapLeverageRatio).to.eq(ZERO);
    //         expect(currentTwapLeverageRatio).to.eq(expectedNewLeverageRatio);
    //       });

    //       it("should update the collateral position on the SetToken correctly", async () => {
    //         const initialPositions = await setToken.getPositions();

    //         await subject();

    //         // aWeth position is decreased
    //         const currentPositions = await setToken.getPositions();
    //         const newFirstPosition = (await setToken.getPositions())[0];

    //         // Max TWAP collateral units
    //         const expectedFirstPositionUnit = initialPositions[0].unit.sub(newTWAPMaxTradeSize);

    //         expect(initialPositions.length).to.eq(2);
    //         expect(currentPositions.length).to.eq(2);
    //         expect(newFirstPosition.component).to.eq(aWeth.address);
    //         expect(newFirstPosition.positionState).to.eq(0); // Default
    //         expect(newFirstPosition.unit).to.eq(expectedFirstPositionUnit);
    //         expect(newFirstPosition.module).to.eq(ADDRESS_ZERO);
    //       });

    //       it("should update the borrow position on the SetToken correctly", async () => {
    //         const initialPositions = await setToken.getPositions();

    //         await subject();

    //         // aWeth position is increased
    //         const currentPositions = await setToken.getPositions();
    //         const newSecondPosition = (await setToken.getPositions())[1];

    //         const expectedSecondPositionUnit = (await usdcVariableDebtToken.balanceOf(setToken.address)).mul(-1);

    //         expect(initialPositions.length).to.eq(2);
    //         expect(currentPositions.length).to.eq(2);
    //         expect(newSecondPosition.component).to.eq(systemSetup.usdc.address);
    //         expect(newSecondPosition.positionState).to.eq(1); // External
    //         expect(newSecondPosition.unit).to.eq(expectedSecondPositionUnit);
    //         expect(newSecondPosition.module).to.eq(perpV2LeverageModule.address);
    //       });
    //     });

    //     describe("when above incentivized leverage ratio threshold", async () => {
    //       beforeEach(async () => {
    //         await subject();

    //         await chainlinkBasePriceMock.setLatestAnswer(BigNumber.from(650).mul(10 ** 8));
    //       });

    //       it("should revert", async () => {
    //         await expect(subject()).to.be.revertedWith("Must be below incentivized leverage ratio");
    //       });
    //     });

    //     describe("when using an exchange that has not been added", async () => {
    //       beforeEach(async () => {
    //         subjectExchangeName = "NonExistentExchange";
    //       });

    //       it("should revert", async () => {
    //         await expect(subject()).to.revertedWith("Must be valid exchange");
    //       });
    //     });
    //   });

    //   context("when not engaged", async () => {
    //     async function subject(): Promise<any> {
    //       return leverageStrategyExtension.rebalance(subjectExchangeName);
    //     }

    //     describe("when collateral balance is zero", async () => {
    //       beforeEach(async () => {
    //         subjectExchangeName = exchangeName;
    //         // Set collateral asset to aUSDC with 0 balance
    //         customATokenCollateralAddress = aUsdc.address;
    //         ifEngaged = false;
    //         await intializeContracts();
    //       });

    //       after(async () => {
    //         customATokenCollateralAddress = undefined;
    //         ifEngaged = true;
    //       });

    //       it("should revert", async () => {
    //         await expect(subject()).to.be.revertedWith("Collateral balance must be > 0");
    //       });
    //     });
    //   });
    // });

    // describe("#iterateRebalance", async () => {
    //   let destinationTokenQuantity: BigNumber;
    //   let subjectCaller: Account;
    //   let subjectExchangeName: string;
    //   let ifEngaged: boolean;
    //   let issueQuantity: BigNumber;

    //   before(async () => {
    //     ifEngaged = true;
    //     subjectExchangeName = exchangeName;
    //   });

    //   const intializeContracts = async () => {
    //     await initializeRootScopeContracts();

    //     // Approve tokens to issuance module and call issue
    //     await aWeth.approve(systemSetup.issuanceModule.address, ether(1000));

    //     // Issue 1 SetToken
    //     issueQuantity = ether(1);
    //     await systemSetup.issuanceModule.issue(setToken.address, issueQuantity, owner.address);

    //     await systemSetup.weth.transfer(tradeAdapterMock.address, ether(0.5));

    //     // Add allowed trader
    //     await leverageStrategyExtension.updateCallerStatus([owner.address], [true]);

    //     if (ifEngaged) {
    //       // Engage to initial leverage
    //       await leverageStrategyExtension.engage(subjectExchangeName);
    //       await increaseTimeAsync(BigNumber.from(100000));
    //       await systemSetup.weth.transfer(tradeAdapterMock.address, ether(0.5));
    //       await leverageStrategyExtension.iterateRebalance(subjectExchangeName);
    //     }
    //   };

    //   cacheBeforeEach(intializeContracts);

    //   context("when currently in the last chunk of a TWAP rebalance", async () => {
    //     cacheBeforeEach(async () => {
    //       await increaseTimeAsync(BigNumber.from(100000));
    //       await chainlinkBasePriceMock.setLatestAnswer(BigNumber.from(1200).mul(10 ** 8));

    //       destinationTokenQuantity = ether(0.01);
    //       const newPerpV2ExchangeSettings: PerpV2ExchangeSettings = {
    //         twapMaxTradeSize: destinationTokenQuantity,
    //         incentivizedTwapMaxTradeSize: exchange.incentivizedTwapMaxTradeSize,
    //         exchangeLastTradeTimestamp: exchange.exchangeLastTradeTimestamp,
    //         leverExchangeData: EMPTY_BYTES,
    //         deleverExchangeData: EMPTY_BYTES,
    //       };
    //       await leverageStrategyExtension.updateEnabledExchange(subjectExchangeName, newPerpV2ExchangeSettings);
    //       await systemSetup.weth.transfer(tradeAdapterMock.address, destinationTokenQuantity);

    //       await leverageStrategyExtension.connect(owner.wallet).rebalance(subjectExchangeName);

    //       await increaseTimeAsync(BigNumber.from(4000));
    //       await systemSetup.weth.transfer(tradeAdapterMock.address, destinationTokenQuantity);
    //     });

    //     beforeEach(() => {
    //       subjectCaller = owner;
    //     });

    //     async function subject(): Promise<any> {
    //       return leverageStrategyExtension.connect(subjectCaller.wallet).iterateRebalance(subjectExchangeName);
    //     }

    //     it("should set the global last trade timestamp", async () => {
    //       await subject();

    //       const lastTradeTimestamp = await leverageStrategyExtension.globalLastTradeTimestamp();

    //       expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
    //     });

    //     it("should set the exchange's last trade timestamp", async () => {
    //       await subject();

    //       const exchange = await leverageStrategyExtension.getPerpV2ExchangeSettings(subjectExchangeName);
    //       const lastTradeTimestamp = exchange.exchangeLastTradeTimestamp;

    //       expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
    //     });

    //     it("should remove the TWAP leverage ratio", async () => {
    //       await subject();

    //       const twapLeverageRatio = await leverageStrategyExtension.twapLeverageRatio();

    //       expect(twapLeverageRatio).to.eq(ZERO);
    //     });

    //     it("should update the collateral position on the SetToken correctly", async () => {
    //       const initialPositions = await setToken.getPositions();
    //       await subject();
    //       // aWeth position is increased
    //       const currentPositions = await setToken.getPositions();
    //       const newFirstPosition = (await setToken.getPositions())[0];

    //       // Get expected aTokens minted
    //       const expectedFirstPositionUnit = initialPositions[0].unit.add(destinationTokenQuantity);

    //       expect(initialPositions.length).to.eq(2);
    //       expect(currentPositions.length).to.eq(2);
    //       expect(newFirstPosition.component).to.eq(aWeth.address);
    //       expect(newFirstPosition.positionState).to.eq(0); // Default
    //       expect(newFirstPosition.unit).to.eq(expectedFirstPositionUnit);
    //       expect(newFirstPosition.module).to.eq(ADDRESS_ZERO);
    //     });

    //     it("should update the borrow position on the SetToken correctly", async () => {
    //       const initialPositions = await setToken.getPositions();

    //       await subject();

    //       // aWeth position is increased
    //       const currentPositions = await setToken.getPositions();
    //       const newSecondPosition = (await setToken.getPositions())[1];

    //       const expectedSecondPositionUnit = (await usdcVariableDebtToken.balanceOf(setToken.address)).mul(-1);

    //       expect(initialPositions.length).to.eq(2);
    //       expect(currentPositions.length).to.eq(2);
    //       expect(newSecondPosition.component).to.eq(systemSetup.usdc.address);
    //       expect(newSecondPosition.positionState).to.eq(1); // External
    //       expect(newSecondPosition.unit).to.eq(expectedSecondPositionUnit);
    //       expect(newSecondPosition.module).to.eq(perpV2LeverageModule.address);
    //     });
    //   });

    //   context("when current leverage ratio is above target and middle of a TWAP rebalance", async () => {
    //     let preTwapLeverageRatio: BigNumber;

    //     cacheBeforeEach(async () => {
    //       await increaseTimeAsync(BigNumber.from(100000));
    //       await chainlinkBasePriceMock.setLatestAnswer(BigNumber.from(1200).mul(10 ** 8));

    //       destinationTokenQuantity = ether(0.0001);
    //       const newPerpV2ExchangeSettings: PerpV2ExchangeSettings = {
    //         twapMaxTradeSize: destinationTokenQuantity,
    //         incentivizedTwapMaxTradeSize: exchange.incentivizedTwapMaxTradeSize,
    //         exchangeLastTradeTimestamp: exchange.exchangeLastTradeTimestamp,
    //         leverExchangeData: EMPTY_BYTES,
    //         deleverExchangeData: EMPTY_BYTES,
    //       };
    //       await leverageStrategyExtension.updateEnabledExchange(subjectExchangeName, newPerpV2ExchangeSettings);
    //       await systemSetup.weth.transfer(tradeAdapterMock.address, destinationTokenQuantity);
    //       preTwapLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();

    //       // Initialize TWAP
    //       await leverageStrategyExtension.connect(owner.wallet).rebalance(subjectExchangeName);
    //       await increaseTimeAsync(BigNumber.from(4000));
    //       await systemSetup.weth.transfer(tradeAdapterMock.address, destinationTokenQuantity);
    //     });

    //     beforeEach(() => {
    //       subjectCaller = owner;
    //     });

    //     async function subject(): Promise<any> {
    //       return leverageStrategyExtension.connect(subjectCaller.wallet).iterateRebalance(subjectExchangeName);
    //     }

    //     it("should set the global last trade timestamp", async () => {
    //       await subject();

    //       const lastTradeTimestamp = await leverageStrategyExtension.globalLastTradeTimestamp();

    //       expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
    //     });

    //     it("should set the exchange's last trade timestamp", async () => {
    //       await subject();

    //       const exchange = await leverageStrategyExtension.getPerpV2ExchangeSettings(subjectExchangeName);
    //       const lastTradeTimestamp = exchange.exchangeLastTradeTimestamp;

    //       expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
    //     });

    //     it("should set the TWAP leverage ratio", async () => {
    //       const previousTwapLeverageRatio = await leverageStrategyExtension.twapLeverageRatio();

    //       await subject();

    //       const currentTwapLeverageRatio = await leverageStrategyExtension.twapLeverageRatio();

    //       const expectedNewLeverageRatio = calculateNewLeverageRatio(
    //         preTwapLeverageRatio,
    //         methodology.targetLeverageRatio,
    //         methodology.minLeverageRatio,
    //         methodology.maxLeverageRatio,
    //         methodology.recenteringSpeed
    //       );
    //       expect(previousTwapLeverageRatio).to.eq(expectedNewLeverageRatio);
    //       expect(currentTwapLeverageRatio).to.eq(expectedNewLeverageRatio);
    //     });

    //     it("should update the collateral position on the SetToken correctly", async () => {
    //       const initialPositions = await setToken.getPositions();
    //       await subject();
    //       // aWeth position is increased
    //       const currentPositions = await setToken.getPositions();
    //       const newFirstPosition = (await setToken.getPositions())[0];

    //       // Get expected aTokens minted
    //       const expectedFirstPositionUnit = initialPositions[0].unit.add(destinationTokenQuantity);

    //       expect(initialPositions.length).to.eq(2);
    //       expect(currentPositions.length).to.eq(2);
    //       expect(newFirstPosition.component).to.eq(aWeth.address);
    //       expect(newFirstPosition.positionState).to.eq(0); // Default
    //       expect(newFirstPosition.unit).to.eq(expectedFirstPositionUnit);
    //       expect(newFirstPosition.module).to.eq(ADDRESS_ZERO);
    //     });

    //     it("should update the borrow position on the SetToken correctly", async () => {
    //       const initialPositions = await setToken.getPositions();

    //       await subject();

    //       // aWeth position is increased
    //       const currentPositions = await setToken.getPositions();
    //       const newSecondPosition = (await setToken.getPositions())[1];

    //       const expectedSecondPositionUnit = (await usdcVariableDebtToken.balanceOf(setToken.address)).mul(-1);

    //       expect(initialPositions.length).to.eq(2);
    //       expect(currentPositions.length).to.eq(2);
    //       expect(newSecondPosition.component).to.eq(systemSetup.usdc.address);
    //       expect(newSecondPosition.positionState).to.eq(1); // External
    //       expect(newSecondPosition.unit).to.eq(expectedSecondPositionUnit);
    //       expect(newSecondPosition.module).to.eq(perpV2LeverageModule.address);
    //     });

    //     it("should emit RebalanceIterated event", async () => {
    //       const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();
    //       const expectedNewLeverageRatio = calculateNewLeverageRatio(
    //         preTwapLeverageRatio,
    //         methodology.targetLeverageRatio,
    //         methodology.minLeverageRatio,
    //         methodology.maxLeverageRatio,
    //         methodology.recenteringSpeed
    //       );
    //       const collateralBalance = await aWeth.balanceOf(setToken.address);
    //       const totalRebalanceNotional = preciseMul(
    //         preciseDiv(expectedNewLeverageRatio.sub(currentLeverageRatio), currentLeverageRatio),
    //         collateralBalance
    //       );
    //       const chunkRebalanceNotional = preciseMul(issueQuantity, destinationTokenQuantity);

    //       await expect(subject()).to.emit(leverageStrategyExtension, "RebalanceIterated").withArgs(
    //         currentLeverageRatio,
    //         expectedNewLeverageRatio,
    //         chunkRebalanceNotional,
    //         totalRebalanceNotional,
    //       );
    //     });

    //     describe("when price has moved advantageously towards target leverage ratio", async () => {
    //       beforeEach(async () => {
    //         await chainlinkBasePriceMock.setLatestAnswer(BigNumber.from(1000).mul(10 ** 8));
    //       });

    //       it("should set the global last trade timestamp", async () => {
    //         await subject();

    //         const lastTradeTimestamp = await leverageStrategyExtension.globalLastTradeTimestamp();

    //         expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
    //       });

    //       it("should set the exchange's last trade timestamp", async () => {
    //         await subject();

    //         const exchange = await leverageStrategyExtension.getPerpV2ExchangeSettings(subjectExchangeName);
    //         const lastTradeTimestamp = exchange.exchangeLastTradeTimestamp;

    //         expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
    //       });

    //       it("should remove the TWAP leverage ratio", async () => {
    //         const previousTwapLeverageRatio = await leverageStrategyExtension.twapLeverageRatio();

    //         await subject();

    //         const currentTwapLeverageRatio = await leverageStrategyExtension.twapLeverageRatio();

    //         const expectedNewLeverageRatio = calculateNewLeverageRatio(
    //           preTwapLeverageRatio,
    //           methodology.targetLeverageRatio,
    //           methodology.minLeverageRatio,
    //           methodology.maxLeverageRatio,
    //           methodology.recenteringSpeed
    //         );
    //         expect(previousTwapLeverageRatio).to.eq(expectedNewLeverageRatio);
    //         expect(currentTwapLeverageRatio).to.eq(ZERO);
    //       });

    //       it("should not update the positions on the SetToken", async () => {
    //         const initialPositions = await setToken.getPositions();
    //         await subject();
    //         const currentPositions = await setToken.getPositions();

    //         expect(currentPositions[0].unit).to.eq(initialPositions[0].unit);
    //         expect(currentPositions[1].unit).to.eq(initialPositions[1].unit);
    //       });
    //     });

    //     describe("when above incentivized leverage ratio threshold", async () => {
    //       beforeEach(async () => {
    //         await subject();

    //         await chainlinkBasePriceMock.setLatestAnswer(BigNumber.from(650).mul(10 ** 8));
    //       });

    //       it("should revert", async () => {
    //         await expect(subject()).to.be.revertedWith("Must be below incentivized leverage ratio");
    //       });
    //     });

    //     describe("when cooldown has not elapsed", async () => {
    //       beforeEach(async () => {
    //         await subject();
    //       });

    //       it("should revert", async () => {
    //         await expect(subject()).to.be.revertedWith("Cooldown not elapsed or not valid leverage ratio");
    //       });
    //     });

    //     describe("when borrow balance is 0", async () => {
    //       beforeEach(async () => {
    //       });

    //       it("should revert", async () => {
    //         await expect(subject()).to.be.revertedWith("Borrow balance must exist");
    //       });
    //     });

    //     describe("when caller is not an allowed trader", async () => {
    //       beforeEach(async () => {
    //         subjectCaller = await getRandomAccount();
    //       });

    //       it("should revert", async () => {
    //         await expect(subject()).to.be.revertedWith("Address not permitted to call");
    //       });
    //     });

    //     describe("when caller is a contract", async () => {
    //       let subjectTarget: Address;
    //       let subjectCallData: string;
    //       let subjectValue: BigNumber;

    //       let contractCaller: ContractCallerMock;

    //       beforeEach(async () => {
    //         contractCaller = await deployer.setV2.deployContractCallerMock();

    //         subjectTarget = leverageStrategyExtension.address;
    //         subjectCallData = leverageStrategyExtension.interface.encodeFunctionData("iterateRebalance", [ subjectExchangeName ]);
    //         subjectValue = ZERO;
    //       });

    //       async function subjectContractCaller(): Promise<any> {
    //         return await contractCaller.invoke(
    //           subjectTarget,
    //           subjectValue,
    //           subjectCallData
    //         );
    //       }

    //       it("the trade reverts", async () => {
    //         await expect(subjectContractCaller()).to.be.revertedWith("Caller must be EOA Address");
    //       });
    //     });

    //     describe("when SetToken has 0 supply", async () => {
    //       beforeEach(async () => {
    //         await systemSetup.usdc.approve(issuanceModule.address, MAX_UINT_256);
    //         await issuanceModule.redeem(setToken.address, ether(1), owner.address);
    //       });

    //       it("should revert", async () => {
    //         await expect(subject()).to.be.revertedWith("SetToken must have > 0 supply");
    //       });
    //     });

    //     describe("when using an exchange that has not been added", async () => {
    //       beforeEach(async () => {
    //         subjectExchangeName = "NonExistentExchange";
    //       });

    //       it("should revert", async () => {
    //         await expect(subject()).to.revertedWith("Must be valid exchange");
    //       });
    //     });
    //   });

    //   context("when current leverage ratio is below target and middle of a TWAP rebalance", async () => {
    //     let preTwapLeverageRatio: BigNumber;

    //     cacheBeforeEach(async () => {
    //       await increaseTimeAsync(BigNumber.from(10000000));
    //       await chainlinkBasePriceMock.setLatestAnswer(BigNumber.from(900).mul(10 ** 8));
    //       await perpV2Setup.setAssetLatestAnswerInOracle(systemSetup.usdc.address, ether(0.00111111111));

    //       destinationTokenQuantity = ether(0.0001);
    //       const newPerpV2ExchangeSettings: PerpV2ExchangeSettings = {
    //         twapMaxTradeSize: destinationTokenQuantity,
    //         incentivizedTwapMaxTradeSize: exchange.incentivizedTwapMaxTradeSize,
    //         exchangeLastTradeTimestamp: exchange.exchangeLastTradeTimestamp,
    //         leverExchangeData: EMPTY_BYTES,
    //         deleverExchangeData: EMPTY_BYTES,
    //       };
    //       subjectExchangeName = exchangeName;
    //       await leverageStrategyExtension.updateEnabledExchange(subjectExchangeName, newPerpV2ExchangeSettings);
    //       await systemSetup.weth.transfer(tradeAdapterMock.address, destinationTokenQuantity);
    //       preTwapLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();

    //       await leverageStrategyExtension.connect(owner.wallet).rebalance(subjectExchangeName);
    //       await increaseTimeAsync(BigNumber.from(4000));
    //       await systemSetup.usdc.transfer(tradeAdapterMock.address, BigNumber.from(2500000));
    //     });

    //     beforeEach(() => {
    //       subjectCaller = owner;
    //     });

    //     async function subject(): Promise<any> {
    //       return leverageStrategyExtension.connect(subjectCaller.wallet).iterateRebalance(subjectExchangeName);
    //     }

    //     describe("when price has moved advantageously towards target leverage ratio", async () => {
    //       beforeEach(async () => {
    //         await chainlinkBasePriceMock.setLatestAnswer(BigNumber.from(1000).mul(10 ** 8));
    //       });

    //       it("should set the global last trade timestamp", async () => {
    //         await subject();

    //         const lastTradeTimestamp = await leverageStrategyExtension.globalLastTradeTimestamp();

    //         expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
    //       });

    //       it("should set the exchange's last trade timestamp", async () => {
    //         await subject();

    //         const exchange = await leverageStrategyExtension.getPerpV2ExchangeSettings(subjectExchangeName);
    //         const lastTradeTimestamp = exchange.exchangeLastTradeTimestamp;

    //         expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
    //       });

    //       it("should remove the TWAP leverage ratio", async () => {
    //         const previousTwapLeverageRatio = await leverageStrategyExtension.twapLeverageRatio();

    //         await subject();

    //         const currentTwapLeverageRatio = await leverageStrategyExtension.twapLeverageRatio();

    //         const expectedNewLeverageRatio = calculateNewLeverageRatio(
    //           preTwapLeverageRatio,
    //           methodology.targetLeverageRatio,
    //           methodology.minLeverageRatio,
    //           methodology.maxLeverageRatio,
    //           methodology.recenteringSpeed
    //         );
    //         expect(previousTwapLeverageRatio).to.eq(expectedNewLeverageRatio);
    //         expect(currentTwapLeverageRatio).to.eq(ZERO);
    //       });

    //       it("should not update the positions on the SetToken", async () => {
    //         const initialPositions = await setToken.getPositions();
    //         await subject();
    //         const currentPositions = await setToken.getPositions();

    //         expect(currentPositions[0].unit).to.eq(initialPositions[0].unit);
    //         expect(currentPositions[1].unit).to.eq(initialPositions[1].unit);
    //       });
    //     });
    //   });

    //   context("when using two exchanges", async () => {
    //     let subjectExchangeToUse: string;

    //     cacheBeforeEach(async () => {
    //       await increaseTimeAsync(BigNumber.from(100000));
    //       await chainlinkBasePriceMock.setLatestAnswer(BigNumber.from(1200).mul(10 ** 8));

    //       destinationTokenQuantity = ether(0.0001);
    //       const newPerpV2ExchangeSettings: PerpV2ExchangeSettings = {
    //         twapMaxTradeSize: destinationTokenQuantity,
    //         incentivizedTwapMaxTradeSize: exchange.incentivizedTwapMaxTradeSize,
    //         exchangeLastTradeTimestamp: exchange.exchangeLastTradeTimestamp,
    //         leverExchangeData: EMPTY_BYTES,
    //         deleverExchangeData: EMPTY_BYTES,
    //       };
    //       await leverageStrategyExtension.updateEnabledExchange(subjectExchangeName, newPerpV2ExchangeSettings);
    //       await leverageStrategyExtension.addEnabledExchange(exchangeName2, newPerpV2ExchangeSettings);
    //       await systemSetup.weth.transfer(tradeAdapterMock.address, destinationTokenQuantity);

    //       // Initialize TWAP
    //       await leverageStrategyExtension.connect(owner.wallet).rebalance(subjectExchangeName);
    //       await increaseTimeAsync(BigNumber.from(4000));
    //       await systemSetup.weth.transfer(tradeAdapterMock.address, destinationTokenQuantity);
    //       await systemSetup.weth.transfer(tradeAdapterMock2.address, destinationTokenQuantity);
    //     });

    //     beforeEach(() => {
    //       subjectCaller = owner;
    //       subjectExchangeToUse = exchangeName;
    //     });

    //     async function subject(): Promise<any> {
    //       return leverageStrategyExtension.connect(subjectCaller.wallet).iterateRebalance(subjectExchangeToUse);
    //     }

    //     describe("when in a twap rebalance and under target leverage ratio", async () => {
    //       it("should set the global and exchange timestamps correctly", async () => {
    //         await subject();
    //         const timestamp1 = await getLastBlockTimestamp();

    //         subjectExchangeToUse = exchangeName2;
    //         await subject();
    //         const timestamp2 = await getLastBlockTimestamp();

    //         expect(await leverageStrategyExtension.globalLastTradeTimestamp()).to.eq(timestamp2);
    //         expect((await leverageStrategyExtension.getPerpV2ExchangeSettings(exchangeName)).exchangeLastTradeTimestamp).to.eq(timestamp1);
    //         expect((await leverageStrategyExtension.getPerpV2ExchangeSettings(exchangeName2)).exchangeLastTradeTimestamp).to.eq(timestamp2);
    //       });
    //     });
    //   });

    //   context("when not in TWAP state", async () => {
    //     async function subject(): Promise<any> {
    //       return leverageStrategyExtension.iterateRebalance(subjectExchangeName);
    //     }

    //     describe("when collateral balance is zero", async () => {
    //       beforeEach(async () => {
    //         await increaseTimeAsync(BigNumber.from(100000));
    //       });

    //       it("should revert", async () => {
    //         await expect(subject()).to.be.revertedWith("Not in TWAP state");
    //       });
    //     });
    //   });

    //   context("when not engaged", async () => {
    //     async function subject(): Promise<any> {
    //       return leverageStrategyExtension.iterateRebalance(subjectExchangeName);
    //     }

    //     describe("when collateral balance is zero", async () => {
    //       beforeEach(async () => {
    //         // Set collateral asset to cUSDC with 0 balance
    //         customATokenCollateralAddress = aUsdc.address;
    //         ifEngaged = false;
    //         await intializeContracts();
    //         subjectCaller = owner;
    //       });

    //       after(async () => {
    //         customATokenCollateralAddress = undefined;
    //         ifEngaged = true;
    //       });

    //       it("should revert", async () => {
    //         await expect(subject()).to.be.revertedWith("Collateral balance must be > 0");
    //       });
    //     });
    //   });
    // });

    // describe("#ripcord", async () => {
    //   let transferredEth: BigNumber;
    //   let subjectCaller: Account;
    //   let subjectExchangeName: string;
    //   let ifEngaged: boolean;

    //   before(async () => {
    //     ifEngaged = true;
    //     subjectExchangeName = exchangeName;
    //   });

    //   const intializeContracts = async () => {
    //     await initializeRootScopeContracts();

    //     // Approve tokens to issuance module and call issue
    //     await aWeth.approve(systemSetup.issuanceModule.address, ether(1000));

    //     // Issue 1 SetToken
    //     const issueQuantity = ether(1);
    //     await systemSetup.issuanceModule.issue(setToken.address, issueQuantity, owner.address);

    //     await systemSetup.weth.transfer(tradeAdapterMock.address, ether(0.5));

    //     // Add allowed trader
    //     await leverageStrategyExtension.updateCallerStatus([owner.address], [true]);

    //     if (ifEngaged) {
    //       // Engage to initial leverage
    //       await leverageStrategyExtension.engage(subjectExchangeName);
    //       await increaseTimeAsync(BigNumber.from(100000));
    //       await systemSetup.weth.transfer(tradeAdapterMock.address, ether(0.5));
    //       await leverageStrategyExtension.iterateRebalance(subjectExchangeName);
    //     }
    //   };

    //   const initializeSubjectVariables = () => {
    //     subjectCaller = owner;
    //   };

    //   cacheBeforeEach(intializeContracts);
    //   beforeEach(initializeSubjectVariables);

    //   // increaseTime
    //   context("when not in a TWAP rebalance", async () => {
    //     cacheBeforeEach(async () => {
    //       // Withdraw balance of USDC from exchange contract from engage
    //       await tradeAdapterMock.withdraw(systemSetup.usdc.address);
    //       await increaseTimeAsync(BigNumber.from(100000));

    //       // Set to above incentivized ratio
    //       await chainlinkBasePriceMock.setLatestAnswer(BigNumber.from(800).mul(10 ** 8));
    //       await systemSetup.usdc.transfer(tradeAdapterMock.address, BigNumber.from(450000000));

    //       transferredEth = ether(1);
    //       await owner.wallet.sendTransaction({to: leverageStrategyExtension.address, value: transferredEth});
    //     });

    //     async function subject(): Promise<any> {
    //       return leverageStrategyExtension.connect(subjectCaller.wallet).ripcord(subjectExchangeName);
    //     }

    //     it("should set the global last trade timestamp", async () => {
    //       await subject();

    //       const lastTradeTimestamp = await leverageStrategyExtension.globalLastTradeTimestamp();

    //       expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
    //     });

    //     it("should set the exchange's last trade timestamp", async () => {
    //       await subject();

    //       const exchange = await leverageStrategyExtension.getPerpV2ExchangeSettings(exchangeName);
    //       const lastTradeTimestamp = exchange.exchangeLastTradeTimestamp;

    //       expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
    //     });

    //     it("should not set the TWAP leverage ratio", async () => {
    //       await subject();

    //       const twapLeverageRatio = await leverageStrategyExtension.twapLeverageRatio();

    //       expect(twapLeverageRatio).to.eq(ZERO);
    //     });

    //     it("should update the collateral position on the SetToken correctly", async () => {
    //       const initialPositions = await setToken.getPositions();
    //       const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();

    //       const previousATokenBalance = await aWeth.balanceOf(setToken.address);

    //       await subject();

    //       // aWeth position is decreased
    //       const currentPositions = await setToken.getPositions();
    //       const newFirstPosition = (await setToken.getPositions())[0];

    //       const expectedNewLeverageRatio = calculateNewLeverageRatio(
    //         currentLeverageRatio,
    //         methodology.targetLeverageRatio,
    //         methodology.minLeverageRatio,
    //         methodology.maxLeverageRatio,
    //         methodology.recenteringSpeed
    //       );
    //       // Get expected USDC redeemed
    //       const expectedCollateralAssetsRedeemed = calculateCollateralRebalanceUnits(
    //         currentLeverageRatio,
    //         expectedNewLeverageRatio,
    //         previousATokenBalance,
    //         ether(1) // Total supply
    //       );

    //       const expectedFirstPositionUnit = initialPositions[0].unit.sub(expectedCollateralAssetsRedeemed);

    //       expect(initialPositions.length).to.eq(2);
    //       expect(currentPositions.length).to.eq(2);
    //       expect(newFirstPosition.component).to.eq(aWeth.address);
    //       expect(newFirstPosition.positionState).to.eq(0); // Default
    //       expect(newFirstPosition.unit).to.eq(expectedFirstPositionUnit);
    //       expect(newFirstPosition.module).to.eq(ADDRESS_ZERO);
    //     });

    //     it("should update the borrow position on the SetToken correctly", async () => {
    //       const initialPositions = await setToken.getPositions();

    //       await subject();

    //       // aWeth position is increased
    //       const currentPositions = await setToken.getPositions();
    //       const newSecondPosition = (await setToken.getPositions())[1];

    //       const expectedSecondPositionUnit = (await usdcVariableDebtToken.balanceOf(setToken.address)).mul(-1);

    //       expect(initialPositions.length).to.eq(2);
    //       expect(currentPositions.length).to.eq(2);
    //       expect(newSecondPosition.component).to.eq(systemSetup.usdc.address);
    //       expect(newSecondPosition.positionState).to.eq(1); // External
    //       expect(newSecondPosition.unit).to.eq(expectedSecondPositionUnit);
    //       expect(newSecondPosition.module).to.eq(perpV2LeverageModule.address);
    //     });

    //     it("should transfer incentive", async () => {
    //       const previousContractEthBalance = await getEthBalance(leverageStrategyExtension.address);
    //       const previousOwnerEthBalance = await getEthBalance(owner.address);

    //       const txHash = await subject();
    //       const txReceipt = await provider.getTransactionReceipt(txHash.hash);
    //       const currentContractEthBalance = await getEthBalance(leverageStrategyExtension.address);
    //       const currentOwnerEthBalance = await getEthBalance(owner.address);
    //       const expectedOwnerEthBalance = previousOwnerEthBalance.add(incentive.etherReward).sub(txReceipt.gasUsed.mul(txHash.gasPrice));

    //       expect(previousContractEthBalance).to.eq(transferredEth);
    //       expect(currentContractEthBalance).to.eq(transferredEth.sub(incentive.etherReward));
    //       expect(expectedOwnerEthBalance).to.eq(currentOwnerEthBalance);
    //     });

    //     it("should emit RipcordCalled event", async () => {
    //       const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();
    //       const collateralBalance = await aWeth.balanceOf(setToken.address);
    //       const chunkRebalanceNotional = preciseMul(
    //         preciseDiv(currentLeverageRatio.sub(methodology.maxLeverageRatio), currentLeverageRatio),
    //         collateralBalance
    //       );

    //       await expect(subject()).to.emit(leverageStrategyExtension, "RipcordCalled").withArgs(
    //         currentLeverageRatio,
    //         methodology.maxLeverageRatio,
    //         chunkRebalanceNotional,
    //         incentive.etherReward,
    //       );
    //     });

    //     describe("when greater than incentivized max trade size", async () => {
    //       let newIncentivizedMaxTradeSize: BigNumber;

    //       cacheBeforeEach(async () => {

    //         newIncentivizedMaxTradeSize = ether(0.01);
    //         const newPerpV2ExchangeSettings: PerpV2ExchangeSettings = {
    //           twapMaxTradeSize: ether(0.001),
    //           incentivizedTwapMaxTradeSize: newIncentivizedMaxTradeSize,
    //           exchangeLastTradeTimestamp: exchange.exchangeLastTradeTimestamp,
    //           leverExchangeData: EMPTY_BYTES,
    //           deleverExchangeData: EMPTY_BYTES,
    //         };
    //         await leverageStrategyExtension.updateEnabledExchange(subjectExchangeName, newPerpV2ExchangeSettings);
    //       });

    //       it("should set the global last trade timestamp", async () => {
    //         await subject();

    //         const lastTradeTimestamp = await leverageStrategyExtension.globalLastTradeTimestamp();

    //         expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
    //       });

    //       it("should set the exchange's last trade timestamp", async () => {
    //         await subject();

    //         const exchange = await leverageStrategyExtension.getPerpV2ExchangeSettings(exchangeName);
    //         const lastTradeTimestamp = exchange.exchangeLastTradeTimestamp;

    //         expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
    //       });

    //       it("should update the collateral position on the SetToken correctly", async () => {
    //         const initialPositions = await setToken.getPositions();

    //         await subject();

    //         // aWeth position is decreased
    //         const currentPositions = await setToken.getPositions();
    //         const newFirstPosition = (await setToken.getPositions())[0];

    //         // Max TWAP collateral units
    //         const expectedFirstPositionUnit = initialPositions[0].unit.sub(newIncentivizedMaxTradeSize);

    //         expect(initialPositions.length).to.eq(2);
    //         expect(currentPositions.length).to.eq(2);
    //         expect(newFirstPosition.component).to.eq(aWeth.address);
    //         expect(newFirstPosition.positionState).to.eq(0); // Default
    //         expect(newFirstPosition.unit).to.eq(expectedFirstPositionUnit);
    //         expect(newFirstPosition.module).to.eq(ADDRESS_ZERO);
    //       });

    //       it("should update the borrow position on the SetToken correctly", async () => {
    //         const initialPositions = await setToken.getPositions();

    //         await subject();

    //         // aWeth position is increased
    //         const currentPositions = await setToken.getPositions();
    //         const newSecondPosition = (await setToken.getPositions())[1];

    //         const expectedSecondPositionUnit = (await usdcVariableDebtToken.balanceOf(setToken.address)).mul(-1);

    //         expect(initialPositions.length).to.eq(2);
    //         expect(currentPositions.length).to.eq(2);
    //         expect(newSecondPosition.component).to.eq(systemSetup.usdc.address);
    //         expect(newSecondPosition.positionState).to.eq(1); // External
    //         expect(newSecondPosition.unit).to.eq(expectedSecondPositionUnit);
    //         expect(newSecondPosition.module).to.eq(perpV2LeverageModule.address);
    //       });

    //       describe("when incentivized cooldown period has not elapsed", async () => {
    //         beforeEach(async () => {
    //           await subject();
    //           await chainlinkBasePriceMock.setLatestAnswer(BigNumber.from(400).mul(10 ** 8));
    //         });

    //         it("should revert", async () => {
    //           await expect(subject()).to.be.revertedWith("TWAP cooldown must have elapsed");
    //         });
    //       });
    //     });

    //     describe("when greater than max borrow", async () => {
    //       beforeEach(async () => {
    //         // Set to above max borrow
    //         await perpV2Setup.setAssetLatestAnswerInOracle(systemSetup.usdc.address, preciseDiv(ether(1), ether(650)));
    //         await chainlinkBasePriceMock.setLatestAnswer(BigNumber.from(650).mul(10 ** 8));
    //       });

    //       it("should set the global last trade timestamp", async () => {
    //         await subject();

    //         const lastTradeTimestamp = await leverageStrategyExtension.globalLastTradeTimestamp();

    //         expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
    //       });

    //       it("should set the exchange's last trade timestamp", async () => {
    //         await subject();

    //         const exchange = await leverageStrategyExtension.getPerpV2ExchangeSettings(exchangeName);
    //         const lastTradeTimestamp = exchange.exchangeLastTradeTimestamp;

    //         expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
    //       });

    //       it("should update the collateral position on the SetToken correctly", async () => {
    //         const initialPositions = await setToken.getPositions();

    //         // Get max borrow
    //         const previousCollateralBalance = await aWeth.balanceOf(setToken.address);

    //         const previousBorrowBalance = (await usdcVariableDebtToken.balanceOf(setToken.address)).mul(BigNumber.from(10).pow(12));

    //         const basePrice = ether(650);
    //         const quotePrice = ether(1);
    //         const reserveConfig = await perpV2Setup.protocolDataProvider.getReserveConfigurationData(systemSetup.weth.address);
    //         const collateralFactor = reserveConfig.liquidationThreshold.mul(BigNumber.from(10).pow(14));

    //         await subject();

    //         // aWeth position is decreased
    //         const currentPositions = await setToken.getPositions();
    //         const newFirstPosition = (await setToken.getPositions())[0];

    //         const maxRedeemCollateral = calculateMaxBorrowForDelever(
    //           previousCollateralBalance,
    //           collateralFactor,
    //           execution.unutilizedLeveragePercentage,
    //           basePrice,
    //           quotePrice,
    //           previousBorrowBalance,
    //         );

    //         // const maxRedeemCToken = preciseDiv(maxRedeemCollateral, exchangeRate);
    //         const expectedFirstPositionUnit = initialPositions[0].unit.sub(maxRedeemCollateral);

    //         expect(initialPositions.length).to.eq(2);
    //         expect(currentPositions.length).to.eq(2);
    //         expect(newFirstPosition.component).to.eq(aWeth.address);
    //         expect(newFirstPosition.positionState).to.eq(0); // Default
    //         expect(newFirstPosition.unit).to.eq(expectedFirstPositionUnit);
    //         expect(newFirstPosition.module).to.eq(ADDRESS_ZERO);
    //       });

    //       it("should update the borrow position on the SetToken correctly", async () => {
    //         const initialPositions = await setToken.getPositions();

    //         await subject();

    //         // aWeth position is increased
    //         const currentPositions = await setToken.getPositions();
    //         const newSecondPosition = (await setToken.getPositions())[1];

    //         const expectedSecondPositionUnit = (await usdcVariableDebtToken.balanceOf(setToken.address)).mul(-1);

    //         expect(initialPositions.length).to.eq(2);
    //         expect(currentPositions.length).to.eq(2);
    //         expect(newSecondPosition.component).to.eq(systemSetup.usdc.address);
    //         expect(newSecondPosition.positionState).to.eq(1); // External
    //         expect(newSecondPosition.unit).to.eq(expectedSecondPositionUnit);
    //         expect(newSecondPosition.module).to.eq(perpV2LeverageModule.address);
    //       });
    //     });

    //     describe("when below incentivized leverage ratio threshold", async () => {
    //       beforeEach(async () => {
    //         await chainlinkBasePriceMock.setLatestAnswer(BigNumber.from(2000).mul(10 ** 8));
    //       });

    //       it("should revert", async () => {
    //         await expect(subject()).to.be.revertedWith("Must be above incentivized leverage ratio");
    //       });
    //     });

    //     describe("when borrow balance is 0", async () => {
    //       beforeEach(async () => {
    //       });

    //       it("should revert", async () => {
    //         await expect(subject()).to.be.revertedWith("Borrow balance must exist");
    //       });
    //     });

    //     describe("when caller is a contract", async () => {
    //       let subjectTarget: Address;
    //       let subjectCallData: string;
    //       let subjectValue: BigNumber;

    //       let contractCaller: ContractCallerMock;

    //       beforeEach(async () => {
    //         contractCaller = await deployer.setV2.deployContractCallerMock();

    //         subjectTarget = leverageStrategyExtension.address;
    //         subjectCallData = leverageStrategyExtension.interface.encodeFunctionData("ripcord", [ subjectExchangeName ]);
    //         subjectValue = ZERO;
    //       });

    //       async function subjectContractCaller(): Promise<any> {
    //         return await contractCaller.invoke(
    //           subjectTarget,
    //           subjectValue,
    //           subjectCallData
    //         );
    //       }

    //       it("the trade reverts", async () => {
    //         await expect(subjectContractCaller()).to.be.revertedWith("Caller must be EOA Address");
    //       });
    //     });

    //     describe("when SetToken has 0 supply", async () => {
    //       beforeEach(async () => {
    //         await systemSetup.usdc.approve(issuanceModule.address, MAX_UINT_256);
    //         await issuanceModule.redeem(setToken.address, ether(1), owner.address);
    //       });

    //       it("should revert", async () => {
    //         await expect(subject()).to.be.revertedWith("SetToken must have > 0 supply");
    //       });
    //     });

    //     describe("when using an exchange that has not been added", async () => {
    //       beforeEach(async () => {
    //         subjectExchangeName = "NonExistentExchange";
    //       });

    //       it("should revert", async () => {
    //         await expect(subject()).to.revertedWith("Must be valid exchange");
    //       });
    //     });
    //   });

    //   context("when in the midst of a TWAP rebalance", async () => {
    //     let newIncentivizedMaxTradeSize: BigNumber;

    //     cacheBeforeEach(async () => {
    //       // Withdraw balance of USDC from exchange contract from engage
    //       await tradeAdapterMock.withdraw(systemSetup.usdc.address);
    //       await increaseTimeAsync(BigNumber.from(100000));
    //       transferredEth = ether(1);
    //       await owner.wallet.sendTransaction({to: leverageStrategyExtension.address, value: transferredEth});

    //       // > Max trade size
    //       newIncentivizedMaxTradeSize = ether(0.001);
    //       const newPerpV2ExchangeSettings: PerpV2ExchangeSettings = {
    //         twapMaxTradeSize: ether(0.001),
    //         incentivizedTwapMaxTradeSize: newIncentivizedMaxTradeSize,
    //         exchangeLastTradeTimestamp: exchange.exchangeLastTradeTimestamp,
    //         leverExchangeData: EMPTY_BYTES,
    //         deleverExchangeData: EMPTY_BYTES,
    //       };
    //       subjectExchangeName = exchangeName;
    //       await leverageStrategyExtension.updateEnabledExchange(subjectExchangeName, newPerpV2ExchangeSettings);

    //       await chainlinkBasePriceMock.setLatestAnswer(BigNumber.from(990).mul(10 ** 8));

    //       await systemSetup.usdc.transfer(tradeAdapterMock.address, BigNumber.from(4000000));

    //       // Start TWAP rebalance
    //       await leverageStrategyExtension.rebalance(subjectExchangeName);
    //       await increaseTimeAsync(BigNumber.from(100));
    //       await systemSetup.usdc.transfer(tradeAdapterMock.address, BigNumber.from(4000000));

    //       // Set to above incentivized ratio
    //       await chainlinkBasePriceMock.setLatestAnswer(BigNumber.from(800).mul(10 ** 8));
    //     });

    //     async function subject(): Promise<any> {
    //       return leverageStrategyExtension.connect(subjectCaller.wallet).ripcord(subjectExchangeName);
    //     }

    //     it("should set the global last trade timestamp", async () => {
    //       await subject();

    //       const lastTradeTimestamp = await leverageStrategyExtension.globalLastTradeTimestamp();

    //       expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
    //     });

    //     it("should set the exchange's last trade timestamp", async () => {
    //       await subject();

    //       const exchange = await leverageStrategyExtension.getPerpV2ExchangeSettings(exchangeName);
    //       const lastTradeTimestamp = exchange.exchangeLastTradeTimestamp;

    //       expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
    //     });

    //     it("should set the TWAP leverage ratio to 0", async () => {
    //       await subject();

    //       const twapLeverageRatio = await leverageStrategyExtension.twapLeverageRatio();

    //       expect(twapLeverageRatio).to.eq(ZERO);
    //     });
    //   });

    //   context("when using two exchanges", async () => {
    //     let subjectExchangeToUse: string;

    //     cacheBeforeEach(async () => {

    //       // Withdraw balance of USDC from exchange contract from engage
    //       await tradeAdapterMock.withdraw(systemSetup.usdc.address);
    //       await increaseTimeAsync(BigNumber.from(100000));

    //       // Set to above incentivized ratio
    //       await chainlinkBasePriceMock.setLatestAnswer(BigNumber.from(800).mul(10 ** 8));
    //       await systemSetup.usdc.transfer(tradeAdapterMock.address, BigNumber.from(300000000));
    //       await systemSetup.usdc.transfer(tradeAdapterMock2.address, BigNumber.from(300000000));

    //       await leverageStrategyExtension.updateEnabledExchange(exchangeName, exchange);
    //       await leverageStrategyExtension.addEnabledExchange(exchangeName2, exchange);
    //       await increaseTimeAsync(BigNumber.from(100000));
    //     });

    //     beforeEach(() => {
    //       subjectCaller = owner;
    //       subjectExchangeToUse = exchangeName;
    //     });

    //     async function subject(): Promise<any> {
    //       return leverageStrategyExtension.connect(subjectCaller.wallet).ripcord(subjectExchangeToUse);
    //     }

    //     describe("when leverage ratio is above max and it drops further between ripcords", async () => {
    //       it("should set the global and exchange timestamps correctly", async () => {
    //         await subject();
    //         const timestamp1 = await getLastBlockTimestamp();

    //         subjectExchangeToUse = exchangeName2;
    //         await chainlinkBasePriceMock.setLatestAnswer(BigNumber.from(600).mul(10 ** 8));

    //         await subject();
    //         const timestamp2 = await getLastBlockTimestamp();

    //         expect(await leverageStrategyExtension.globalLastTradeTimestamp()).to.eq(timestamp2);
    //         expect((await leverageStrategyExtension.getPerpV2ExchangeSettings(exchangeName)).exchangeLastTradeTimestamp).to.eq(timestamp1);
    //         expect((await leverageStrategyExtension.getPerpV2ExchangeSettings(exchangeName2)).exchangeLastTradeTimestamp).to.eq(timestamp2);
    //       });
    //     });
    //   });

    //   context("when not engaged", async () => {
    //     async function subject(): Promise<any> {
    //       return leverageStrategyExtension.ripcord(subjectExchangeName);
    //     }

    //     describe("when collateral balance is zero", async () => {
    //       beforeEach(async () => {
    //         // Set collateral asset to aUSDC with 0 balance
    //         customATokenCollateralAddress = aUsdc.address;
    //         ifEngaged = false;

    //         await intializeContracts();
    //         initializeSubjectVariables();
    //       });

    //       after(async () => {
    //         customATokenCollateralAddress = undefined;
    //         ifEngaged = true;
    //       });

    //       it("should revert", async () => {
    //         await expect(subject()).to.be.revertedWith("Collateral balance must be > 0");
    //       });
    //     });
    //   });
    // });

    // describe("#disengage", async () => {
    //   let subjectCaller: Account;
    //   let subjectExchangeName: string;
    //   let ifEngaged: boolean;

    //   context("when notional is greater than max trade size and total rebalance notional is greater than max borrow", async () => {
    //     before(async () => {
    //       ifEngaged = true;
    //       subjectExchangeName = exchangeName;
    //     });

    //     const intializeContracts = async() => {
    //       await initializeRootScopeContracts();

    //       // Approve tokens to issuance module and call issue
    //       await aWeth.approve(systemSetup.issuanceModule.address, ether(1000));

    //       // Issue 1 SetToken
    //       const issueQuantity = ether(1);
    //       await systemSetup.issuanceModule.issue(setToken.address, issueQuantity, owner.address);

    //       await systemSetup.weth.transfer(tradeAdapterMock.address, ether(0.5));

    //       if (ifEngaged) {
    //         // Add allowed trader
    //         await leverageStrategyExtension.updateCallerStatus([owner.address], [true]);
    //         // Engage to initial leverage
    //         await leverageStrategyExtension.engage(subjectExchangeName);
    //         await increaseTimeAsync(BigNumber.from(100000));
    //         await systemSetup.weth.transfer(tradeAdapterMock.address, ether(0.5));
    //         await leverageStrategyExtension.iterateRebalance(subjectExchangeName);

    //         // Withdraw balance of USDC from exchange contract from engage
    //         await tradeAdapterMock.withdraw(systemSetup.usdc.address);
    //         await systemSetup.usdc.transfer(tradeAdapterMock.address, BigNumber.from(550000000));
    //       }
    //     };

    //     const initializeSubjectVariables = () => {
    //       subjectCaller = owner;
    //     };

    //     async function subject(): Promise<any> {
    //       leverageStrategyExtension = leverageStrategyExtension.connect(subjectCaller.wallet);
    //       return leverageStrategyExtension.disengage(subjectExchangeName);
    //     }

    //     describe("when engaged", () => {
    //       cacheBeforeEach(intializeContracts);
    //       beforeEach(initializeSubjectVariables);

    //       it("should update the collateral position on the SetToken correctly", async () => {
    //         const initialPositions = await setToken.getPositions();

    //         await subject();

    //         // aWeth position is decreased
    //         const currentPositions = await setToken.getPositions();
    //         const newFirstPosition = (await setToken.getPositions())[0];

    //         // Max TWAP collateral units
    //         const expectedFirstPositionUnit = initialPositions[0].unit.sub(exchange.twapMaxTradeSize);

    //         expect(initialPositions.length).to.eq(2);
    //         expect(currentPositions.length).to.eq(2);
    //         expect(newFirstPosition.component).to.eq(aWeth.address);
    //         expect(newFirstPosition.positionState).to.eq(0); // Default
    //         expect(newFirstPosition.unit).to.eq(expectedFirstPositionUnit);
    //         expect(newFirstPosition.module).to.eq(ADDRESS_ZERO);
    //       });

    //       it("should update the borrow position on the SetToken correctly", async () => {
    //         const initialPositions = await setToken.getPositions();

    //         await subject();

    //         // aWeth position is increased
    //         const currentPositions = await setToken.getPositions();
    //         const newSecondPosition = (await setToken.getPositions())[1];

    //         const expectedSecondPositionUnit = (await usdcVariableDebtToken.balanceOf(setToken.address)).mul(-1);

    //         expect(initialPositions.length).to.eq(2);
    //         expect(currentPositions.length).to.eq(2);
    //         expect(newSecondPosition.component).to.eq(systemSetup.usdc.address);
    //         expect(newSecondPosition.positionState).to.eq(1); // External
    //         expect(newSecondPosition.unit).to.eq(expectedSecondPositionUnit);
    //         expect(newSecondPosition.module).to.eq(perpV2LeverageModule.address);
    //       });

    //       describe("when borrow balance is 0", async () => {
    //         beforeEach(async () => {
    //           // Repay entire balance of cUSDC on behalf of SetToken
    //          await perpV2Setup.lendingPool.repay(
    //            systemSetup.usdc.address,
    //            await usdcVariableDebtToken.balanceOf(setToken.address),
    //            2,
    //            setToken.address
    //          );
    //         });

    //         it("should revert", async () => {
    //           await expect(subject()).to.be.revertedWith("Borrow balance must exist");
    //         });
    //       });

    //       describe("when SetToken has 0 supply", async () => {
    //         beforeEach(async () => {
    //           await systemSetup.usdc.approve(issuanceModule.address, MAX_UINT_256);
    //           await issuanceModule.redeem(setToken.address, ether(1), owner.address);
    //         });

    //         it("should revert", async () => {
    //           await expect(subject()).to.be.revertedWith("SetToken must have > 0 supply");
    //         });
    //       });

    //       describe("when the caller is not the operator", async () => {
    //         beforeEach(async () => {
    //           subjectCaller = await getRandomAccount();
    //         });

    //         it("should revert", async () => {
    //           await expect(subject()).to.be.revertedWith("Must be operator");
    //         });
    //       });
    //     });

    //     describe("when not engaged", () => {
    //       describe("when collateral balance is zero", async () => {
    //         beforeEach(async () => {
    //           // Set collateral asset to cUSDC with 0 balance
    //           customATokenCollateralAddress = aUsdc.address;
    //           ifEngaged = false;

    //           await intializeContracts();
    //           initializeSubjectVariables();
    //         });

    //         after(async () => {
    //           customATokenCollateralAddress = undefined;
    //           ifEngaged = true;
    //         });

    //         it("should revert", async () => {
    //           await expect(subject()).to.be.revertedWith("Collateral balance must be > 0");
    //         });
    //       });
    //     });
    //   });

    //   context("when notional is less than max trade size and total rebalance notional is greater than max borrow", async () => {
    //     cacheBeforeEach(async () => {
    //       await initializeRootScopeContracts();

    //       // Approve tokens to issuance module and call issue
    //       await aWeth.approve(systemSetup.issuanceModule.address, ether(1000));

    //       // Issue 1 SetToken
    //       const issueQuantity = ether(1);
    //       await systemSetup.issuanceModule.issue(setToken.address, issueQuantity, owner.address);

    //       await systemSetup.weth.transfer(tradeAdapterMock.address, ether(0.5));

    //       // Engage to initial leverage
    //       await leverageStrategyExtension.updateCallerStatus([owner.address], [true]);
    //       await leverageStrategyExtension.engage(subjectExchangeName);
    //       await increaseTimeAsync(BigNumber.from(4000));
    //       await systemSetup.weth.transfer(tradeAdapterMock.address, ether(0.5));
    //       await leverageStrategyExtension.iterateRebalance(subjectExchangeName);

    //       // Clear balance of USDC from exchange contract from engage
    //       await tradeAdapterMock.withdraw(systemSetup.usdc.address);
    //       await systemSetup.usdc.transfer(tradeAdapterMock.address, BigNumber.from(800000000));

    //       const newPerpV2ExchangeSettings: PerpV2ExchangeSettings = {
    //         twapMaxTradeSize: ether(1.9),
    //         incentivizedTwapMaxTradeSize: exchange.incentivizedTwapMaxTradeSize,
    //         exchangeLastTradeTimestamp: exchange.exchangeLastTradeTimestamp,
    //         leverExchangeData: EMPTY_BYTES,
    //         deleverExchangeData: EMPTY_BYTES,
    //       };
    //       await leverageStrategyExtension.updateEnabledExchange(subjectExchangeName, newPerpV2ExchangeSettings);

    //       // Set price to reduce borrowing power
    //       await chainlinkBasePriceMock.setLatestAnswer(BigNumber.from(1000).mul(10 ** 8));

    //       subjectCaller = owner;
    //     });

    //     async function subject(): Promise<any> {
    //       leverageStrategyExtension = leverageStrategyExtension.connect(subjectCaller.wallet);
    //       return leverageStrategyExtension.disengage(subjectExchangeName);
    //     }

    //     it("should update the collateral position on the SetToken correctly", async () => {
    //       const initialPositions = await setToken.getPositions();

    //       // Get max borrow
    //       const previousCollateralBalance = await aWeth.balanceOf(setToken.address);

    //       const previousBorrowBalance = (await usdcVariableDebtToken.balanceOf(setToken.address)).mul(BigNumber.from(10).pow(12));

    //       const basePrice = ether(1000);
    //       const quotePrice = ether(1);
    //       const reserveConfig = await perpV2Setup.protocolDataProvider.getReserveConfigurationData(systemSetup.weth.address);
    //       const collateralFactor = reserveConfig.liquidationThreshold.mul(BigNumber.from(10).pow(14));

    //       await subject();

    //       // aWeth position is decreased
    //       const currentPositions = await setToken.getPositions();
    //       const newFirstPosition = (await setToken.getPositions())[0];

    //       const maxRedeemCollateral = calculateMaxBorrowForDelever(
    //         previousCollateralBalance,
    //         collateralFactor,
    //         execution.unutilizedLeveragePercentage,
    //         basePrice,
    //         quotePrice,
    //         previousBorrowBalance,
    //       );

    //       const expectedFirstPositionUnit = initialPositions[0].unit.sub(maxRedeemCollateral);

    //       expect(initialPositions.length).to.eq(2);
    //       expect(currentPositions.length).to.eq(2);
    //       expect(newFirstPosition.component).to.eq(aWeth.address);
    //       expect(newFirstPosition.positionState).to.eq(0); // Default
    //       expect(newFirstPosition.unit).to.eq(expectedFirstPositionUnit);
    //       expect(newFirstPosition.module).to.eq(ADDRESS_ZERO);
    //     });

    //     it("should update the borrow position on the SetToken correctly", async () => {
    //       const initialPositions = await setToken.getPositions();

    //       await subject();

    //       // aWeth position is increased
    //       const currentPositions = await setToken.getPositions();
    //       const newSecondPosition = (await setToken.getPositions())[1];
    //       const expectedSecondPositionUnit = (await usdcVariableDebtToken.balanceOf(setToken.address)).mul(-1);
    //       expect(initialPositions.length).to.eq(2);
    //       expect(currentPositions.length).to.eq(2);
    //       expect(newSecondPosition.component).to.eq(systemSetup.usdc.address);
    //       expect(newSecondPosition.positionState).to.eq(1); // External
    //       expect(newSecondPosition.unit).to.eq(expectedSecondPositionUnit);
    //       expect(newSecondPosition.module).to.eq(perpV2LeverageModule.address);
    //     });
    //   });

    //   context("when notional is less than max trade size and total rebalance notional is less than max borrow", async () => {
    //     before(async () => {
    //       customTargetLeverageRatio = ether(1.25); // Change to 1.25x
    //       customMinLeverageRatio = ether(1.1);
    //     });

    //     after(async () => {
    //       customTargetLeverageRatio = undefined;
    //       customMinLeverageRatio = undefined;
    //     });

    //     cacheBeforeEach(async () => {
    //       await initializeRootScopeContracts();

    //       // Approve tokens to issuance module and call issue
    //       await aWeth.approve(systemSetup.issuanceModule.address, ether(1000));

    //       // Issue 1 SetToken
    //       const issueQuantity = ether(1);
    //       await systemSetup.issuanceModule.issue(setToken.address, issueQuantity, owner.address);

    //       await systemSetup.weth.transfer(tradeAdapterMock.address, ether(0.25));

    //       // Engage to initial leverage
    //       await leverageStrategyExtension.engage(subjectExchangeName);

    //       // Withdraw balance of USDC from exchange contract from engage
    //       await tradeAdapterMock.withdraw(systemSetup.usdc.address);

    //       const usdcBorrowBalance = await usdcVariableDebtToken.balanceOf(setToken.address);
    //       // Transfer more than the borrow balance to the exchange
    //       await systemSetup.usdc.transfer(tradeAdapterMock.address, usdcBorrowBalance.add(1000000000));
    //       subjectCaller = owner;
    //     });

    //     async function subject(): Promise<any> {
    //       leverageStrategyExtension = leverageStrategyExtension.connect(subjectCaller.wallet);
    //       return leverageStrategyExtension.disengage(subjectExchangeName);
    //     }

    //     it("should update the collateral position on the SetToken correctly", async () => {
    //       const initialPositions = await setToken.getPositions();
    //       const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();

    //       const previousATokenBalance = await aWeth.balanceOf(setToken.address);

    //       await subject();

    //       // cEther position is decreased
    //       const currentPositions = await setToken.getPositions();
    //       const newFirstPosition = (await setToken.getPositions())[0];

    //       // Get expected cTokens redeemed
    //       const expectedCollateralAssetsRedeemed = calculateMaxRedeemForDeleverToZero(
    //         currentLeverageRatio,
    //         ether(1), // 1x leverage
    //         previousATokenBalance,
    //         ether(1), // Total supply
    //         execution.slippageTolerance
    //       );

    //       const expectedFirstPositionUnit = initialPositions[0].unit.sub(expectedCollateralAssetsRedeemed);
    //       expect(initialPositions.length).to.eq(2);
    //       expect(currentPositions.length).to.eq(2);
    //       expect(newFirstPosition.component).to.eq(aWeth.address);
    //       expect(newFirstPosition.positionState).to.eq(0); // Default
    //       expect(newFirstPosition.unit).to.eq(expectedFirstPositionUnit);
    //       expect(newFirstPosition.module).to.eq(ADDRESS_ZERO);
    //     });

    //     it("should wipe out the debt on Aave", async () => {
    //       await subject();

    //       const borrowDebt = (await usdcVariableDebtToken.balanceOf(setToken.address)).mul(-1);

    //       expect(borrowDebt).to.eq(ZERO);
    //     });

    //     it("should remove any external positions on the borrow asset", async () => {
    //       await subject();

    //       const borrowAssetExternalModules = await setToken.getExternalPositionModules(systemSetup.usdc.address);
    //       const borrowExternalUnit = await setToken.getExternalPositionRealUnit(
    //         systemSetup.usdc.address,
    //         perpV2LeverageModule.address
    //       );
    //       const isPositionModule = await setToken.isExternalPositionModule(
    //         systemSetup.usdc.address,
    //         perpV2LeverageModule.address
    //       );

    //       expect(borrowAssetExternalModules.length).to.eq(0);
    //       expect(borrowExternalUnit).to.eq(ZERO);
    //       expect(isPositionModule).to.eq(false);
    //     });

    //     it("should update the borrow asset equity on the SetToken correctly", async () => {
    //       await subject();

    //       // The USDC position is positive and represents equity
    //       const newSecondPosition = (await setToken.getPositions())[1];
    //       expect(newSecondPosition.component).to.eq(systemSetup.usdc.address);
    //       expect(newSecondPosition.positionState).to.eq(0); // Default
    //       expect(BigNumber.from(newSecondPosition.unit)).to.gt(ZERO);
    //       expect(newSecondPosition.module).to.eq(ADDRESS_ZERO);
    //     });
    //   });
    // });

    // describe("#setMethodologySettings", async () => {
    //   let subjectPerpV2MethodologySettings: PerpV2MethodologySettings;
    //   let subjectCaller: Account;

    //   const initializeSubjectVariables = () => {
    //     subjectPerpV2MethodologySettings = {
    //       targetLeverageRatio: ether(2.1),
    //       minLeverageRatio: ether(1.1),
    //       maxLeverageRatio: ether(2.5),
    //       recenteringSpeed: ether(0.1),
    //       rebalanceInterval: BigNumber.from(43200),
    //     };
    //     subjectCaller = owner;
    //   };

    //   async function subject(): Promise<any> {
    //     leverageStrategyExtension = leverageStrategyExtension.connect(subjectCaller.wallet);
    //     return leverageStrategyExtension.setMethodologySettings(subjectPerpV2MethodologySettings);
    //   }

    //   describe("when rebalance is not in progress", () => {
    //     cacheBeforeEach(initializeRootScopeContracts);
    //     beforeEach(initializeSubjectVariables);

    //     it("should set the correct methodology parameters", async () => {
    //       await subject();
    //       const methodology = await leverageStrategyExtension.getMethodology();

    //       expect(methodology.targetLeverageRatio).to.eq(subjectPerpV2MethodologySettings.targetLeverageRatio);
    //       expect(methodology.minLeverageRatio).to.eq(subjectPerpV2MethodologySettings.minLeverageRatio);
    //       expect(methodology.maxLeverageRatio).to.eq(subjectPerpV2MethodologySettings.maxLeverageRatio);
    //       expect(methodology.recenteringSpeed).to.eq(subjectPerpV2MethodologySettings.recenteringSpeed);
    //       expect(methodology.rebalanceInterval).to.eq(subjectPerpV2MethodologySettings.rebalanceInterval);
    //     });

    //     it("should emit PerpV2MethodologySettingsUpdated event", async () => {
    //       await expect(subject()).to.emit(leverageStrategyExtension, "PerpV2MethodologySettingsUpdated").withArgs(
    //         subjectPerpV2MethodologySettings.targetLeverageRatio,
    //         subjectPerpV2MethodologySettings.minLeverageRatio,
    //         subjectPerpV2MethodologySettings.maxLeverageRatio,
    //         subjectPerpV2MethodologySettings.recenteringSpeed,
    //         subjectPerpV2MethodologySettings.rebalanceInterval,
    //       );
    //     });

    //     describe("when the caller is not the operator", async () => {
    //       beforeEach(async () => {
    //         subjectCaller = await getRandomAccount();
    //       });

    //       it("should revert", async () => {
    //         await expect(subject()).to.be.revertedWith("Must be operator");
    //       });
    //     });

    //     describe("when min leverage ratio is 0", async () => {
    //       beforeEach(async () => {
    //         subjectPerpV2MethodologySettings.minLeverageRatio = ZERO;
    //       });

    //       it("should revert", async () => {
    //         await expect(subject()).to.be.revertedWith("Must be valid min leverage");
    //       });
    //     });

    //     describe("when min leverage ratio is above target", async () => {
    //       beforeEach(async () => {
    //         subjectPerpV2MethodologySettings.minLeverageRatio = ether(2.2);
    //       });

    //       it("should revert", async () => {
    //         await expect(subject()).to.be.revertedWith("Must be valid min leverage");
    //       });
    //     });

    //     describe("when max leverage ratio is below target", async () => {
    //       beforeEach(async () => {
    //         subjectPerpV2MethodologySettings.maxLeverageRatio = ether(1.9);
    //       });

    //       it("should revert", async () => {
    //         await expect(subject()).to.be.revertedWith("Must be valid max leverage");
    //       });
    //     });

    //     describe("when max leverage ratio is above incentivized leverage ratio", async () => {
    //       beforeEach(async () => {
    //         subjectPerpV2MethodologySettings.maxLeverageRatio = ether(5);
    //       });

    //       it("should revert", async () => {
    //         await expect(subject()).to.be.revertedWith("Incentivized leverage ratio must be > max leverage ratio");
    //       });
    //     });

    //     describe("when recentering speed is >100%", async () => {
    //       beforeEach(async () => {
    //         subjectPerpV2MethodologySettings.recenteringSpeed = ether(1.1);
    //       });

    //       it("should revert", async () => {
    //         await expect(subject()).to.be.revertedWith("Must be valid recentering speed");
    //       });
    //     });

    //     describe("when recentering speed is 0%", async () => {
    //       beforeEach(async () => {
    //         subjectPerpV2MethodologySettings.recenteringSpeed = ZERO;
    //       });

    //       it("should revert", async () => {
    //         await expect(subject()).to.be.revertedWith("Must be valid recentering speed");
    //       });
    //     });

    //     describe("when rebalance interval is shorter than TWAP cooldown period", async () => {
    //       beforeEach(async () => {
    //         subjectPerpV2MethodologySettings.rebalanceInterval = ZERO;
    //       });

    //       it("should revert", async () => {
    //         await expect(subject()).to.be.revertedWith("Rebalance interval must be greater than TWAP cooldown period");
    //       });
    //     });
    //   });

    //   describe("when rebalance is in progress", async () => {
    //     beforeEach(async () => {
    //       await initializeRootScopeContracts();
    //       initializeSubjectVariables();

    //       // Approve tokens to issuance module and call issue
    //       await aWeth.approve(systemSetup.issuanceModule.address, ether(1000));

    //       // Issue 1 SetToken
    //       const issueQuantity = ether(1);
    //       await systemSetup.issuanceModule.issue(setToken.address, issueQuantity, owner.address);

    //       await systemSetup.weth.transfer(tradeAdapterMock.address, ether(0.5));

    //       // Engage to initial leverage
    //       await leverageStrategyExtension.engage(exchangeName);
    //     });

    //     it("should revert", async () => {
    //       await expect(subject()).to.be.revertedWith("Rebalance is currently in progress");
    //     });
    //   });
    // });

    // describe("#setExecutionSettings", async () => {
    //   let subjectExecutionSettings: PerpV2ExecutionSettings;
    //   let subjectCaller: Account;

    //   const initializeSubjectVariables = () => {
    //     subjectExecutionSettings = {
    //       unutilizedLeveragePercentage: ether(0.05),
    //       twapCooldownPeriod: BigNumber.from(360),
    //       slippageTolerance: ether(0.02),
    //     };
    //     subjectCaller = owner;
    //   };

    //   async function subject(): Promise<any> {
    //     leverageStrategyExtension = leverageStrategyExtension.connect(subjectCaller.wallet);
    //     return leverageStrategyExtension.setExecutionSettings(subjectExecutionSettings);
    //   }

    //   describe("when rebalance is not in progress", () => {
    //     cacheBeforeEach(initializeRootScopeContracts);
    //     beforeEach(initializeSubjectVariables);
    //     it("should set the correct execution parameters", async () => {
    //       await subject();
    //       const execution = await leverageStrategyExtension.getExecution();

    //       expect(execution.unutilizedLeveragePercentage).to.eq(subjectExecutionSettings.unutilizedLeveragePercentage);
    //       expect(execution.twapCooldownPeriod).to.eq(subjectExecutionSettings.twapCooldownPeriod);
    //       expect(execution.slippageTolerance).to.eq(subjectExecutionSettings.slippageTolerance);
    //     });

    //     it("should emit ExecutionSettingsUpdated event", async () => {
    //       await expect(subject()).to.emit(leverageStrategyExtension, "ExecutionSettingsUpdated").withArgs(
    //         subjectExecutionSettings.unutilizedLeveragePercentage,
    //         subjectExecutionSettings.twapCooldownPeriod,
    //         subjectExecutionSettings.slippageTolerance
    //       );
    //     });

    //     describe("when the caller is not the operator", async () => {
    //       beforeEach(async () => {
    //         subjectCaller = await getRandomAccount();
    //       });

    //       it("should revert", async () => {
    //         await expect(subject()).to.be.revertedWith("Must be operator");
    //       });
    //     });

    //     describe("when unutilizedLeveragePercentage is >100%", async () => {
    //       beforeEach(async () => {
    //         subjectExecutionSettings.unutilizedLeveragePercentage = ether(1.1);
    //       });

    //       it("should revert", async () => {
    //         await expect(subject()).to.be.revertedWith("Unutilized leverage must be <100%");
    //       });
    //     });

    //     describe("when slippage tolerance is >100%", async () => {
    //       beforeEach(async () => {
    //         subjectExecutionSettings.slippageTolerance = ether(1.1);
    //       });

    //       it("should revert", async () => {
    //         await expect(subject()).to.be.revertedWith("Slippage tolerance must be <100%");
    //       });
    //     });

    //     describe("when TWAP cooldown period is greater than rebalance interval", async () => {
    //       beforeEach(async () => {
    //         subjectExecutionSettings.twapCooldownPeriod = ether(1);
    //       });

    //       it("should revert", async () => {
    //         await expect(subject()).to.be.revertedWith("Rebalance interval must be greater than TWAP cooldown period");
    //       });
    //     });

    //     describe("when TWAP cooldown period is shorter than incentivized TWAP cooldown period", async () => {
    //       beforeEach(async () => {
    //         subjectExecutionSettings.twapCooldownPeriod = ZERO;
    //       });

    //       it("should revert", async () => {
    //         await expect(subject()).to.be.revertedWith("TWAP cooldown must be greater than incentivized TWAP cooldown");
    //       });
    //     });
    //   });

    //   describe("when rebalance is in progress", async () => {
    //     beforeEach(async () => {
    //       await initializeRootScopeContracts();
    //       initializeSubjectVariables();

    //       // Approve tokens to issuance module and call issue
    //       await aWeth.approve(systemSetup.issuanceModule.address, ether(1000));

    //       // Issue 1 SetToken
    //       const issueQuantity = ether(1);
    //       await systemSetup.issuanceModule.issue(setToken.address, issueQuantity, owner.address);

    //       await systemSetup.weth.transfer(tradeAdapterMock.address, ether(0.5));

    //       // Engage to initial leverage
    //       await leverageStrategyExtension.engage(exchangeName);
    //     });

    //     it("should revert", async () => {
    //       await expect(subject()).to.be.revertedWith("Rebalance is currently in progress");
    //     });
    //   });
    // });

    // describe("#setIncentiveSettings", async () => {
    //   let subjectIncentiveSettings: PerpV2IncentiveSettings;
    //   let subjectCaller: Account;

    //   const initializeSubjectVariables = () => {
    //     subjectIncentiveSettings = {
    //       incentivizedTwapCooldownPeriod: BigNumber.from(30),
    //       incentivizedSlippageTolerance: ether(0.1),
    //       etherReward: ether(5),
    //       incentivizedLeverageRatio: ether(3.2),
    //     };
    //     subjectCaller = owner;
    //   };

    //   async function subject(): Promise<any> {
    //     leverageStrategyExtension = leverageStrategyExtension.connect(subjectCaller.wallet);
    //     return leverageStrategyExtension.setIncentiveSettings(subjectIncentiveSettings);
    //   }

    //   describe("when rebalance is not in progress", () => {
    //     cacheBeforeEach(initializeRootScopeContracts);
    //     beforeEach(initializeSubjectVariables);

    //     it("should set the correct incentive parameters", async () => {
    //       await subject();
    //       const incentive = await leverageStrategyExtension.getIncentive();

    //       expect(incentive.incentivizedTwapCooldownPeriod).to.eq(subjectIncentiveSettings.incentivizedTwapCooldownPeriod);
    //       expect(incentive.incentivizedSlippageTolerance).to.eq(subjectIncentiveSettings.incentivizedSlippageTolerance);
    //       expect(incentive.etherReward).to.eq(subjectIncentiveSettings.etherReward);
    //       expect(incentive.incentivizedLeverageRatio).to.eq(subjectIncentiveSettings.incentivizedLeverageRatio);
    //     });

    //     it("should emit IncentiveSettingsUpdated event", async () => {
    //       await expect(subject()).to.emit(leverageStrategyExtension, "IncentiveSettingsUpdated").withArgs(
    //         subjectIncentiveSettings.etherReward,
    //         subjectIncentiveSettings.incentivizedLeverageRatio,
    //         subjectIncentiveSettings.incentivizedSlippageTolerance,
    //         subjectIncentiveSettings.incentivizedTwapCooldownPeriod
    //       );
    //     });

    //     describe("when the caller is not the operator", async () => {
    //       beforeEach(async () => {
    //         subjectCaller = await getRandomAccount();
    //       });

    //       it("should revert", async () => {
    //         await expect(subject()).to.be.revertedWith("Must be operator");
    //       });
    //     });

    //     describe("when incentivized TWAP cooldown period is greater than TWAP cooldown period", async () => {
    //       beforeEach(async () => {
    //         subjectIncentiveSettings.incentivizedTwapCooldownPeriod = ether(1);
    //       });

    //       it("should revert", async () => {
    //         await expect(subject()).to.be.revertedWith("TWAP cooldown must be greater than incentivized TWAP cooldown");
    //       });
    //     });

    //     describe("when incentivized slippage tolerance is >100%", async () => {
    //       beforeEach(async () => {
    //         subjectIncentiveSettings.incentivizedSlippageTolerance = ether(1.1);
    //       });

    //       it("should revert", async () => {
    //         await expect(subject()).to.be.revertedWith("Incentivized slippage tolerance must be <100%");
    //       });
    //     });

    //     describe("when incentivize leverage ratio is less than max leverage ratio", async () => {
    //       beforeEach(async () => {
    //         subjectIncentiveSettings.incentivizedLeverageRatio = ether(2);
    //       });

    //       it("should revert", async () => {
    //         await expect(subject()).to.be.revertedWith("Incentivized leverage ratio must be > max leverage ratio");
    //       });
    //     });
    //   });

    //   describe("when rebalance is in progress", async () => {
    //     beforeEach(async () => {
    //       await initializeRootScopeContracts();
    //       initializeSubjectVariables();

    //       // Approve tokens to issuance module and call issue
    //       await aWeth.approve(systemSetup.issuanceModule.address, ether(1000));

    //       // Issue 1 SetToken
    //       const issueQuantity = ether(1);
    //       await systemSetup.issuanceModule.issue(setToken.address, issueQuantity, owner.address);

    //       await systemSetup.weth.transfer(tradeAdapterMock.address, ether(0.5));

    //       // Engage to initial leverage
    //       await leverageStrategyExtension.engage(exchangeName);
    //     });

    //     it("should revert", async () => {
    //       await expect(subject()).to.be.revertedWith("Rebalance is currently in progress");
    //     });
    //   });
    // });

    // describe("#addEnabledExchange", async () => {
    //   let subjectExchangeName: string;
    //   let subjectPerpV2ExchangeSettings: PerpV2ExchangeSettings;
    //   let subjectCaller: Account;

    //   const initializeSubjectVariables = () => {
    //     subjectExchangeName = "NewExchange";
    //     subjectPerpV2ExchangeSettings = {
    //       twapMaxTradeSize: ether(100),
    //       incentivizedTwapMaxTradeSize: ether(200),
    //       exchangeLastTradeTimestamp: BigNumber.from(0),
    //       leverExchangeData: EMPTY_BYTES,
    //       deleverExchangeData: EMPTY_BYTES,
    //     };
    //     subjectCaller = owner;
    //   };

    //   async function subject(): Promise<any> {
    //     leverageStrategyExtension = leverageStrategyExtension.connect(subjectCaller.wallet);
    //     return leverageStrategyExtension.addEnabledExchange(subjectExchangeName, subjectPerpV2ExchangeSettings);
    //   }

    //   cacheBeforeEach(initializeRootScopeContracts);
    //   beforeEach(initializeSubjectVariables);

    //   it("should set the correct exchange parameters", async () => {
    //     await subject();
    //     const exchange = await leverageStrategyExtension.getPerpV2ExchangeSettings(subjectExchangeName);

    //     expect(exchange.twapMaxTradeSize).to.eq(subjectPerpV2ExchangeSettings.twapMaxTradeSize);
    //     expect(exchange.incentivizedTwapMaxTradeSize).to.eq(subjectPerpV2ExchangeSettings.incentivizedTwapMaxTradeSize);
    //     expect(exchange.exchangeLastTradeTimestamp).to.eq(0);
    //     expect(exchange.leverExchangeData).to.eq(subjectPerpV2ExchangeSettings.leverExchangeData);
    //     expect(exchange.deleverExchangeData).to.eq(subjectPerpV2ExchangeSettings.deleverExchangeData);
    //   });

    //   it("should add exchange to enabledExchanges", async () => {
    //     await subject();
    //     const finalExchanges = await leverageStrategyExtension.getEnabledExchanges();

    //     expect(finalExchanges.length).to.eq(2);
    //     expect(finalExchanges[1]).to.eq(subjectExchangeName);
    //   });

    //   it("should emit an ExchangeAdded event", async () => {
    //     await expect(subject()).to.emit(leverageStrategyExtension, "ExchangeAdded").withArgs(
    //       subjectExchangeName,
    //       subjectPerpV2ExchangeSettings.twapMaxTradeSize,
    //       subjectPerpV2ExchangeSettings.exchangeLastTradeTimestamp,
    //       subjectPerpV2ExchangeSettings.incentivizedTwapMaxTradeSize,
    //       subjectPerpV2ExchangeSettings.leverExchangeData,
    //       subjectPerpV2ExchangeSettings.deleverExchangeData
    //     );
    //   });

    //   describe("when the caller is not the operator", async () => {
    //     beforeEach(async () => {
    //       subjectCaller = await getRandomAccount();
    //     });

    //     it("should revert", async () => {
    //       await expect(subject()).to.be.revertedWith("Must be operator");
    //     });
    //   });

    //   describe("when exchange has already been added", async () => {
    //     beforeEach(() => {
    //       subjectExchangeName = exchangeName;
    //     });

    //     it("should revert", async () => {
    //       await expect(subject()).to.be.revertedWith("Exchange already enabled");
    //     });
    //   });

    //   describe("when an exchange has a twapMaxTradeSize of 0", async () => {
    //     beforeEach(async () => {
    //       subjectPerpV2ExchangeSettings.twapMaxTradeSize = ZERO;
    //     });

    //     it("should revert", async () => {
    //       await expect(subject()).to.be.revertedWith("Max TWAP trade size must not be 0");
    //     });
    //   });
    // });

    // describe("#updateEnabledExchange", async () => {
    //   let subjectExchangeName: string;
    //   let subjectNewPerpV2ExchangeSettings: PerpV2ExchangeSettings;
    //   let subjectCaller: Account;

    //   const initializeSubjectVariables = () => {
    //     subjectExchangeName = exchangeName;
    //     subjectNewPerpV2ExchangeSettings = {
    //       twapMaxTradeSize: ether(101),
    //       incentivizedTwapMaxTradeSize: ether(201),
    //       exchangeLastTradeTimestamp: BigNumber.from(0),
    //       leverExchangeData: EMPTY_BYTES,
    //       deleverExchangeData: EMPTY_BYTES,
    //     };
    //     subjectCaller = owner;
    //   };

    //   async function subject(): Promise<any> {
    //     leverageStrategyExtension = leverageStrategyExtension.connect(subjectCaller.wallet);
    //     return leverageStrategyExtension.updateEnabledExchange(subjectExchangeName, subjectNewPerpV2ExchangeSettings);
    //   }

    //   cacheBeforeEach(initializeRootScopeContracts);
    //   beforeEach(initializeSubjectVariables);

    //   it("should set the correct exchange parameters", async () => {
    //     await subject();
    //     const exchange = await leverageStrategyExtension.getPerpV2ExchangeSettings(subjectExchangeName);

    //     expect(exchange.twapMaxTradeSize).to.eq(subjectNewPerpV2ExchangeSettings.twapMaxTradeSize);
    //     expect(exchange.incentivizedTwapMaxTradeSize).to.eq(subjectNewPerpV2ExchangeSettings.incentivizedTwapMaxTradeSize);
    //     expect(exchange.exchangeLastTradeTimestamp).to.eq(subjectNewPerpV2ExchangeSettings.exchangeLastTradeTimestamp);
    //     expect(exchange.leverExchangeData).to.eq(subjectNewPerpV2ExchangeSettings.leverExchangeData);
    //     expect(exchange.deleverExchangeData).to.eq(subjectNewPerpV2ExchangeSettings.deleverExchangeData);
    //   });

    //   it("should not add duplicate entry to enabledExchanges", async () => {
    //     await subject();
    //     const finalExchanges = await leverageStrategyExtension.getEnabledExchanges();

    //     expect(finalExchanges.length).to.eq(1);
    //     expect(finalExchanges[0]).to.eq(subjectExchangeName);
    //   });

    //   it("should emit an ExchangeUpdated event", async () => {
    //     await expect(subject()).to.emit(leverageStrategyExtension, "ExchangeUpdated").withArgs(
    //       subjectExchangeName,
    //       subjectNewPerpV2ExchangeSettings.twapMaxTradeSize,
    //       subjectNewPerpV2ExchangeSettings.exchangeLastTradeTimestamp,
    //       subjectNewPerpV2ExchangeSettings.incentivizedTwapMaxTradeSize,
    //       subjectNewPerpV2ExchangeSettings.leverExchangeData,
    //       subjectNewPerpV2ExchangeSettings.deleverExchangeData
    //     );
    //   });

    //   describe("when the caller is not the operator", async () => {
    //     beforeEach(async () => {
    //       subjectCaller = await getRandomAccount();
    //     });

    //     it("should revert", async () => {
    //       await expect(subject()).to.be.revertedWith("Must be operator");
    //     });
    //   });

    //   describe("when exchange has not already been added", async () => {
    //     beforeEach(() => {
    //       subjectExchangeName = "NewExchange";
    //     });

    //     it("should revert", async () => {
    //       await expect(subject()).to.be.revertedWith("Exchange not enabled");
    //     });
    //   });

    //   describe("when an exchange has a twapMaxTradeSize of 0", async () => {
    //     beforeEach(async () => {
    //       subjectNewPerpV2ExchangeSettings.twapMaxTradeSize = ZERO;
    //     });

    //     it("should revert", async () => {
    //       await expect(subject()).to.be.revertedWith("Max TWAP trade size must not be 0");
    //     });
    //   });
    // });

    // describe("#removeEnabledExchange", async () => {
    //   let subjectExchangeName: string;
    //   let subjectCaller: Account;

    //   const initializeSubjectVariables = () => {
    //     subjectExchangeName = exchangeName;
    //     subjectCaller = owner;
    //   };

    //   async function subject(): Promise<any> {
    //     leverageStrategyExtension = leverageStrategyExtension.connect(subjectCaller.wallet);
    //     return leverageStrategyExtension.removeEnabledExchange(subjectExchangeName);
    //   }

    //   cacheBeforeEach(initializeRootScopeContracts);
    //   beforeEach(initializeSubjectVariables);

    //   it("should set the exchange parameters to their default values", async () => {
    //     await subject();
    //     const exchange = await leverageStrategyExtension.getPerpV2ExchangeSettings(subjectExchangeName);

    //     expect(exchange.twapMaxTradeSize).to.eq(0);
    //     expect(exchange.incentivizedTwapMaxTradeSize).to.eq(0);
    //     expect(exchange.exchangeLastTradeTimestamp).to.eq(0);
    //     expect(exchange.leverExchangeData).to.eq(EMPTY_BYTES);
    //     expect(exchange.deleverExchangeData).to.eq(EMPTY_BYTES);
    //   });

    //   it("should remove entry from enabledExchanges list", async () => {
    //     await subject();
    //     const finalExchanges = await leverageStrategyExtension.getEnabledExchanges();

    //     expect(finalExchanges.length).to.eq(0);
    //   });

    //   it("should emit an ExchangeRemoved event", async () => {
    //     await expect(subject()).to.emit(leverageStrategyExtension, "ExchangeRemoved").withArgs(
    //       subjectExchangeName,
    //     );
    //   });

    //   describe("when the caller is not the operator", async () => {
    //     beforeEach(async () => {
    //       subjectCaller = await getRandomAccount();
    //     });

    //     it("should revert", async () => {
    //       await expect(subject()).to.be.revertedWith("Must be operator");
    //     });
    //   });

    //   describe("when exchange has not already been added", async () => {
    //     beforeEach(() => {
    //       subjectExchangeName = "NewExchange";
    //     });

    //     it("should revert", async () => {
    //       await expect(subject()).to.be.revertedWith("Exchange not enabled");
    //     });
    //   });
    // });

    // describe("#withdrawEtherBalance", async () => {
    //   let etherReward: BigNumber;
    //   let subjectCaller: Account;

    //   const initializeSubjectVariables = async () => {
    //     etherReward = ether(0.1);
    //     // Send ETH to contract as reward
    //     await owner.wallet.sendTransaction({to: leverageStrategyExtension.address, value: etherReward});
    //     subjectCaller = owner;
    //   };

    //   async function subject(): Promise<any> {
    //     leverageStrategyExtension = leverageStrategyExtension.connect(subjectCaller.wallet);
    //     return leverageStrategyExtension.withdrawEtherBalance();
    //   }

    //   describe("when rebalance is not in progress", () => {
    //     cacheBeforeEach(initializeRootScopeContracts);
    //     beforeEach(initializeSubjectVariables);

    //     it("should withdraw ETH balance on contract to operator", async () => {
    //       const previousContractEthBalance = await getEthBalance(leverageStrategyExtension.address);
    //       const previousOwnerEthBalance = await getEthBalance(owner.address);

    //       const txHash = await subject();
    //       const txReceipt = await provider.getTransactionReceipt(txHash.hash);
    //       const currentContractEthBalance = await getEthBalance(leverageStrategyExtension.address);
    //       const currentOwnerEthBalance = await getEthBalance(owner.address);
    //       const expectedOwnerEthBalance = previousOwnerEthBalance.add(etherReward).sub(txReceipt.gasUsed.mul(txHash.gasPrice));

    //       expect(previousContractEthBalance).to.eq(etherReward);
    //       expect(currentContractEthBalance).to.eq(ZERO);
    //       expect(expectedOwnerEthBalance).to.eq(currentOwnerEthBalance);
    //     });

    //     describe("when the caller is not the operator", async () => {
    //       beforeEach(async () => {
    //         subjectCaller = await getRandomAccount();
    //       });

    //       it("should revert", async () => {
    //         await expect(subject()).to.be.revertedWith("Must be operator");
    //       });
    //     });
    //   });

    //   describe("when rebalance is in progress", async () => {
    //     beforeEach(async () => {
    //       await initializeRootScopeContracts();
    //       initializeSubjectVariables();

    //       // Approve tokens to issuance module and call issue
    //       await aWeth.approve(systemSetup.issuanceModule.address, ether(1000));

    //       // Issue 1 SetToken
    //       const issueQuantity = ether(1);
    //       await systemSetup.issuanceModule.issue(setToken.address, issueQuantity, owner.address);

    //       await systemSetup.weth.transfer(tradeAdapterMock.address, ether(0.5));

    //       // Engage to initial leverage
    //       await leverageStrategyExtension.engage(exchangeName);
    //     });

    //     it("should revert", async () => {
    //       await expect(subject()).to.be.revertedWith("Rebalance is currently in progress");
    //     });
    //   });
    // });

    // describe("#getCurrentEtherIncentive", async () => {
    //   cacheBeforeEach(async () => {
    //     await initializeRootScopeContracts();

    //     // Approve tokens to issuance module and call issue
    //     await aWeth.approve(systemSetup.issuanceModule.address, ether(1000));

    //     // Issue 1 SetToken
    //     const issueQuantity = ether(1);
    //     await systemSetup.issuanceModule.issue(setToken.address, issueQuantity, owner.address);

    //     await systemSetup.weth.transfer(tradeAdapterMock.address, ether(0.5));

    //     // Add allowed trader
    //     await leverageStrategyExtension.updateCallerStatus([owner.address], [true]);

    //     // Engage to initial leverage
    //     await leverageStrategyExtension.engage(exchangeName);
    //     await increaseTimeAsync(BigNumber.from(100000));
    //     await systemSetup.weth.transfer(tradeAdapterMock.address, ether(0.5));

    //     await leverageStrategyExtension.iterateRebalance(exchangeName);
    //   });

    //   async function subject(): Promise<any> {
    //     return leverageStrategyExtension.getCurrentEtherIncentive();
    //   }

    //   describe("when above incentivized leverage ratio", async () => {
    //     beforeEach(async () => {
    //       await owner.wallet.sendTransaction({to: leverageStrategyExtension.address, value: ether(1)});
    //       await chainlinkBasePriceMock.setLatestAnswer(BigNumber.from(650).mul(10 ** 8));
    //     });

    //     it("should return the correct value", async () => {
    //       const etherIncentive = await subject();

    //       expect(etherIncentive).to.eq(incentive.etherReward);
    //     });

    //     describe("when ETH balance is below ETH reward amount", async () => {
    //       beforeEach(async () => {
    //         await leverageStrategyExtension.withdrawEtherBalance();
    //         // Transfer 0.01 ETH to contract
    //         await owner.wallet.sendTransaction({to: leverageStrategyExtension.address, value: ether(0.01)});
    //       });

    //       it("should return the correct value", async () => {
    //         const etherIncentive = await subject();

    //         expect(etherIncentive).to.eq(ether(0.01));
    //       });
    //     });
    //   });

    //   describe("when below incentivized leverage ratio", async () => {
    //     beforeEach(async () => {
    //       await chainlinkBasePriceMock.setLatestAnswer(BigNumber.from(2000).mul(10 ** 8));
    //     });

    //     it("should return the correct value", async () => {
    //       const etherIncentive = await subject();

    //       expect(etherIncentive).to.eq(ZERO);
    //     });
    //   });
    // });

    // describe("#shouldRebalance", async () => {
    //   cacheBeforeEach(async () => {
    //     await initializeRootScopeContracts();

    //     // Approve tokens to issuance module and call issue
    //     await aWeth.approve(systemSetup.issuanceModule.address, ether(1000));

    //     // Issue 1 SetToken
    //     const issueQuantity = ether(1);
    //     await systemSetup.issuanceModule.issue(setToken.address, issueQuantity, owner.address);

    //     await systemSetup.weth.transfer(tradeAdapterMock.address, ether(0.5));

    //     // Add allowed trader
    //     await leverageStrategyExtension.updateCallerStatus([owner.address], [true]);

    //     // Engage to initial leverage
    //     await leverageStrategyExtension.engage(exchangeName);
    //     await increaseTimeAsync(BigNumber.from(100000));
    //     await systemSetup.weth.transfer(tradeAdapterMock.address, ether(0.5));

    //     await leverageStrategyExtension.iterateRebalance(exchangeName);
    //   });

    //   async function subject(): Promise<[string[], number[]]> {
    //     return leverageStrategyExtension.shouldRebalance();
    //   }

    //   context("when in the midst of a TWAP rebalance", async () => {
    //     cacheBeforeEach(async () => {
    //       // Withdraw balance of USDC from exchange contract from engage
    //       await tradeAdapterMock.withdraw(systemSetup.usdc.address);

    //       // > Max trade size
    //       const newPerpV2ExchangeSettings: PerpV2ExchangeSettings = {
    //         twapMaxTradeSize: ether(0.001),
    //         incentivizedTwapMaxTradeSize: exchange.incentivizedTwapMaxTradeSize,
    //         exchangeLastTradeTimestamp: exchange.exchangeLastTradeTimestamp,
    //         leverExchangeData: EMPTY_BYTES,
    //         deleverExchangeData: EMPTY_BYTES,
    //       };
    //       await leverageStrategyExtension.updateEnabledExchange(exchangeName, newPerpV2ExchangeSettings);

    //       // Set up new rebalance TWAP
    //       await systemSetup.usdc.transfer(tradeAdapterMock.address, BigNumber.from(4000000));
    //       await chainlinkBasePriceMock.setLatestAnswer(BigNumber.from(990).mul(10 ** 8));
    //       await increaseTimeAsync(BigNumber.from(100000));
    //       await leverageStrategyExtension.rebalance(exchangeName);
    //     });

    //     describe("when above incentivized leverage ratio and incentivized TWAP cooldown has elapsed", async () => {
    //       beforeEach(async () => {
    //         // Set to above incentivized ratio
    //         await chainlinkBasePriceMock.setLatestAnswer(BigNumber.from(800).mul(10 ** 8));
    //         await increaseTimeAsync(BigNumber.from(100));
    //       });

    //       it("should return ripcord", async () => {
    //         const [ exchangeNamesArray, shouldRebalanceArray ] = await subject();

    //         expect(exchangeNamesArray[0]).to.eq(exchangeName);
    //         expect(shouldRebalanceArray[0]).to.eq(THREE);
    //       });
    //     });

    //     describe("when below incentivized leverage ratio and regular TWAP cooldown has elapsed", async () => {
    //       beforeEach(async () => {
    //         // Set to below incentivized ratio
    //         await chainlinkBasePriceMock.setLatestAnswer(BigNumber.from(900).mul(10 ** 8));
    //         await increaseTimeAsync(BigNumber.from(4000));
    //       });

    //       it("should return iterate rebalance", async () => {
    //         const [ exchangeNamesArray, shouldRebalanceArray ] = await subject();

    //         expect(exchangeNamesArray[0]).to.eq(exchangeName);
    //         expect(shouldRebalanceArray[0]).to.eq(TWO);
    //       });
    //     });

    //     describe("when above incentivized leverage ratio and incentivized TWAP cooldown has NOT elapsed", async () => {
    //       beforeEach(async () => {
    //         // Set to above incentivized ratio
    //         await chainlinkBasePriceMock.setLatestAnswer(BigNumber.from(800).mul(10 ** 8));
    //       });

    //       it("should not rebalance", async () => {
    //         const [ exchangeNamesArray, shouldRebalanceArray ] = await subject();

    //         expect(exchangeNamesArray[0]).to.eq(exchangeName);
    //         expect(shouldRebalanceArray[0]).to.eq(ZERO);
    //       });
    //     });

    //     describe("when below incentivized leverage ratio and regular TWAP cooldown has NOT elapsed", async () => {
    //       beforeEach(async () => {
    //         // Set to above incentivized ratio
    //         await chainlinkBasePriceMock.setLatestAnswer(BigNumber.from(900).mul(10 ** 8));
    //       });

    //       it("should not rebalance", async () => {
    //         const [ exchangeNamesArray, shouldRebalanceArray ] = await subject();

    //         expect(exchangeNamesArray[0]).to.eq(exchangeName);
    //         expect(shouldRebalanceArray[0]).to.eq(ZERO);
    //       });
    //     });
    //   });

    //   context("when not in a TWAP rebalance", async () => {
    //     describe("when above incentivized leverage ratio and cooldown period has elapsed", async () => {
    //       beforeEach(async () => {
    //         // Set to above incentivized ratio
    //         await chainlinkBasePriceMock.setLatestAnswer(BigNumber.from(800).mul(10 ** 8));
    //         await increaseTimeAsync(BigNumber.from(100));
    //       });

    //       it("should return ripcord", async () => {
    //         const [ exchangeNamesArray, shouldRebalanceArray ] = await subject();

    //         expect(exchangeNamesArray[0]).to.eq(exchangeName);
    //         expect(shouldRebalanceArray[0]).to.eq(THREE);
    //       });
    //     });

    //     describe("when between max and min leverage ratio and rebalance interval has elapsed", async () => {
    //       beforeEach(async () => {
    //         await chainlinkBasePriceMock.setLatestAnswer(BigNumber.from(990).mul(10 ** 8));
    //         await increaseTimeAsync(BigNumber.from(100000));
    //       });

    //       it("should return rebalance", async () => {
    //         const [ exchangeNamesArray, shouldRebalanceArray ] = await subject();

    //         expect(exchangeNamesArray[0]).to.eq(exchangeName);
    //         expect(shouldRebalanceArray[0]).to.eq(ONE);
    //       });
    //     });

    //     describe("when above max leverage ratio but below incentivized leverage ratio", async () => {
    //       beforeEach(async () => {
    //         await chainlinkBasePriceMock.setLatestAnswer(BigNumber.from(850).mul(10 ** 8));
    //       });

    //       it("should return rebalance", async () => {
    //         const [ exchangeNamesArray, shouldRebalanceArray ] = await subject();

    //         expect(exchangeNamesArray[0]).to.eq(exchangeName);
    //         expect(shouldRebalanceArray[0]).to.eq(ONE);
    //       });
    //     });

    //     describe("when below min leverage ratio", async () => {
    //       beforeEach(async () => {
    //         await chainlinkBasePriceMock.setLatestAnswer(BigNumber.from(1400).mul(10 ** 8));
    //       });

    //       it("should return rebalance", async () => {
    //         const [ exchangeNamesArray, shouldRebalanceArray ] = await subject();

    //         expect(exchangeNamesArray[0]).to.eq(exchangeName);
    //         expect(shouldRebalanceArray[0]).to.eq(ONE);
    //       });
    //     });

    //     describe("when above incentivized leverage ratio and incentivized TWAP cooldown has NOT elapsed", async () => {
    //       beforeEach(async () => {
    //         await chainlinkBasePriceMock.setLatestAnswer(BigNumber.from(800).mul(10 ** 8));
    //       });

    //       it("should not rebalance", async () => {
    //         const [ exchangeNamesArray, shouldRebalanceArray ] = await subject();

    //         expect(exchangeNamesArray[0]).to.eq(exchangeName);
    //         expect(shouldRebalanceArray[0]).to.eq(ZERO);
    //       });
    //     });

    //     describe("when between max and min leverage ratio and rebalance interval has NOT elapsed", async () => {
    //       beforeEach(async () => {
    //         await chainlinkBasePriceMock.setLatestAnswer(BigNumber.from(990).mul(10 ** 8));
    //       });

    //       it("should not rebalance", async () => {
    //         const [ exchangeNamesArray, shouldRebalanceArray ] = await subject();

    //         expect(exchangeNamesArray[0]).to.eq(exchangeName);
    //         expect(shouldRebalanceArray[0]).to.eq(ZERO);
    //       });
    //     });
    //   });
    // });

    // describe("#shouldRebalanceWithBounds", async () => {
    //   let subjectMinLeverageRatio: BigNumber;
    //   let subjectMaxLeverageRatio: BigNumber;

    //   cacheBeforeEach(async () => {
    //     await initializeRootScopeContracts();

    //     // Approve tokens to issuance module and call issue
    //     await aWeth.approve(systemSetup.issuanceModule.address, ether(1000));

    //     // Issue 1 SetToken
    //     const issueQuantity = ether(1);
    //     await systemSetup.issuanceModule.issue(setToken.address, issueQuantity, owner.address);

    //     await systemSetup.weth.transfer(tradeAdapterMock.address, ether(0.5));

    //     // Add allowed trader
    //     await leverageStrategyExtension.updateCallerStatus([owner.address], [true]);

    //     // Engage to initial leverage
    //     await leverageStrategyExtension.engage(exchangeName);
    //     await increaseTimeAsync(BigNumber.from(100000));
    //     await systemSetup.weth.transfer(tradeAdapterMock.address, ether(0.5));

    //     await leverageStrategyExtension.iterateRebalance(exchangeName);
    //   });

    //   beforeEach(() => {
    //     subjectMinLeverageRatio = ether(1.6);
    //     subjectMaxLeverageRatio = ether(2.4);
    //   });

    //   async function subject(): Promise<[string[], number[]]> {
    //     return leverageStrategyExtension.shouldRebalanceWithBounds(
    //       subjectMinLeverageRatio,
    //       subjectMaxLeverageRatio
    //     );
    //   }

    //   context("when in the midst of a TWAP rebalance", async () => {
    //     beforeEach(async () => {
    //       // Withdraw balance of USDC from exchange contract from engage
    //       await tradeAdapterMock.withdraw(systemSetup.usdc.address);

    //       // > Max trade size
    //       const newPerpV2ExchangeSettings: PerpV2ExchangeSettings = {
    //         twapMaxTradeSize: ether(0.001),
    //         incentivizedTwapMaxTradeSize: exchange.incentivizedTwapMaxTradeSize,
    //         exchangeLastTradeTimestamp: exchange.exchangeLastTradeTimestamp,
    //         leverExchangeData: EMPTY_BYTES,
    //         deleverExchangeData: EMPTY_BYTES,
    //       };
    //       await leverageStrategyExtension.updateEnabledExchange(exchangeName, newPerpV2ExchangeSettings);

    //       // Set up new rebalance TWAP
    //       await systemSetup.usdc.transfer(tradeAdapterMock.address, BigNumber.from(4000000));
    //       await chainlinkBasePriceMock.setLatestAnswer(BigNumber.from(990).mul(10 ** 8));
    //       await increaseTimeAsync(BigNumber.from(100000));
    //       await leverageStrategyExtension.rebalance(exchangeName);
    //     });

    //     describe("when above incentivized leverage ratio and incentivized TWAP cooldown has elapsed", async () => {
    //       beforeEach(async () => {
    //         // Set to above incentivized ratio
    //         await chainlinkBasePriceMock.setLatestAnswer(BigNumber.from(800).mul(10 ** 8));
    //         await increaseTimeAsync(BigNumber.from(100));
    //       });

    //       it("should return ripcord", async () => {
    //         const [ exchangeNamesArray, shouldRebalanceArray ] = await subject();

    //         expect(exchangeNamesArray[0]).to.eq(exchangeName);
    //         expect(shouldRebalanceArray[0]).to.eq(THREE);
    //       });
    //     });

    //     describe("when below incentivized leverage ratio and regular TWAP cooldown has elapsed", async () => {
    //       beforeEach(async () => {
    //         // Set to below incentivized ratio
    //         await chainlinkBasePriceMock.setLatestAnswer(BigNumber.from(900).mul(10 ** 8));
    //         await increaseTimeAsync(BigNumber.from(4000));
    //       });

    //       it("should return iterate rebalance", async () => {
    //         const [ exchangeNamesArray, shouldRebalanceArray ] = await subject();

    //         expect(exchangeNamesArray[0]).to.eq(exchangeName);
    //         expect(shouldRebalanceArray[0]).to.eq(TWO);
    //       });
    //     });

    //     describe("when above incentivized leverage ratio and incentivized TWAP cooldown has NOT elapsed", async () => {
    //       beforeEach(async () => {
    //         // Set to above incentivized ratio
    //         await chainlinkBasePriceMock.setLatestAnswer(BigNumber.from(800).mul(10 ** 8));
    //       });

    //       it("should not rebalance", async () => {
    //         const [ exchangeNamesArray, shouldRebalanceArray ] = await subject();

    //         expect(exchangeNamesArray[0]).to.eq(exchangeName);
    //         expect(shouldRebalanceArray[0]).to.eq(ZERO);
    //       });
    //     });

    //     describe("when below incentivized leverage ratio and regular TWAP cooldown has NOT elapsed", async () => {
    //       beforeEach(async () => {
    //         // Set to above incentivized ratio
    //         await chainlinkBasePriceMock.setLatestAnswer(BigNumber.from(900).mul(10 ** 8));
    //       });

    //       it("should not rebalance", async () => {
    //         const [ exchangeNamesArray, shouldRebalanceArray ] = await subject();

    //         expect(exchangeNamesArray[0]).to.eq(exchangeName);
    //         expect(shouldRebalanceArray[0]).to.eq(ZERO);
    //       });
    //     });
    //   });

    //   context("when not in a TWAP rebalance", async () => {
    //     describe("when above incentivized leverage ratio and cooldown period has elapsed", async () => {
    //       beforeEach(async () => {
    //         // Set to above incentivized ratio
    //         await chainlinkBasePriceMock.setLatestAnswer(BigNumber.from(800).mul(10 ** 8));
    //         await increaseTimeAsync(BigNumber.from(100));
    //       });

    //       it("should return ripcord", async () => {
    //         const [ exchangeNamesArray, shouldRebalanceArray ] = await subject();

    //         expect(exchangeNamesArray[0]).to.eq(exchangeName);
    //         expect(shouldRebalanceArray[0]).to.eq(THREE);
    //       });
    //     });

    //     describe("when between max and min leverage ratio and rebalance interval has elapsed", async () => {
    //       beforeEach(async () => {
    //         await chainlinkBasePriceMock.setLatestAnswer(BigNumber.from(990).mul(10 ** 8));
    //         await increaseTimeAsync(BigNumber.from(100000));
    //       });

    //       it("should return rebalance", async () => {
    //         const [ exchangeNamesArray, shouldRebalanceArray ] = await subject();

    //         expect(exchangeNamesArray[0]).to.eq(exchangeName);
    //         expect(shouldRebalanceArray[0]).to.eq(ONE);
    //       });
    //     });

    //     describe("when above max leverage ratio but below incentivized leverage ratio", async () => {
    //       beforeEach(async () => {
    //         await chainlinkBasePriceMock.setLatestAnswer(BigNumber.from(850).mul(10 ** 8));
    //       });

    //       it("should return rebalance", async () => {
    //         const [ exchangeNamesArray, shouldRebalanceArray ] = await subject();

    //         expect(exchangeNamesArray[0]).to.eq(exchangeName);
    //         expect(shouldRebalanceArray[0]).to.eq(ONE);
    //       });
    //     });

    //     describe("when below min leverage ratio", async () => {
    //       beforeEach(async () => {
    //         await chainlinkBasePriceMock.setLatestAnswer(BigNumber.from(1400).mul(10 ** 8));
    //       });

    //       it("should return rebalance", async () => {
    //         const [ exchangeNamesArray, shouldRebalanceArray ] = await subject();

    //         expect(exchangeNamesArray[0]).to.eq(exchangeName);
    //         expect(shouldRebalanceArray[0]).to.eq(ONE);
    //       });
    //     });

    //     describe("when above incentivized leverage ratio and incentivized TWAP cooldown has NOT elapsed", async () => {
    //       beforeEach(async () => {
    //         await chainlinkBasePriceMock.setLatestAnswer(BigNumber.from(800).mul(10 ** 8));
    //       });

    //       it("should not rebalance", async () => {
    //         const [ exchangeNamesArray, shouldRebalanceArray ] = await subject();

    //         expect(exchangeNamesArray[0]).to.eq(exchangeName);
    //         expect(shouldRebalanceArray[0]).to.eq(ZERO);
    //       });
    //     });

    //     describe("when between max and min leverage ratio and rebalance interval has NOT elapsed", async () => {
    //       beforeEach(async () => {
    //         await chainlinkBasePriceMock.setLatestAnswer(BigNumber.from(990).mul(10 ** 8));
    //       });

    //       it("should not rebalance", async () => {
    //         const [ exchangeNamesArray, shouldRebalanceArray ] = await subject();

    //         expect(exchangeNamesArray[0]).to.eq(exchangeName);
    //         expect(shouldRebalanceArray[0]).to.eq(ZERO);
    //       });
    //     });

    //     describe("when custom min leverage ratio is above methodology min leverage ratio", async () => {
    //       beforeEach(async () => {
    //         subjectMinLeverageRatio = ether(1.9);
    //       });

    //       it("should revert", async () => {
    //         await expect(subject()).to.be.revertedWith("Custom bounds must be valid");
    //       });
    //     });

    //     describe("when custom max leverage ratio is below methodology max leverage ratio", async () => {
    //       beforeEach(async () => {
    //         subjectMinLeverageRatio = ether(2.2);
    //       });

    //       it("should revert", async () => {
    //         await expect(subject()).to.be.revertedWith("Custom bounds must be valid");
    //       });
    //     });
    //   });
    // });

    // describe("#getChunkRebalanceNotional", async () => {
    //   cacheBeforeEach(async () => {
    //     await initializeRootScopeContracts();

    //     // Approve tokens to issuance module and call issue
    //     await aWeth.approve(systemSetup.issuanceModule.address, ether(1000));

    //     // Issue 1 SetToken
    //     const issueQuantity = ether(1);
    //     await systemSetup.issuanceModule.issue(setToken.address, issueQuantity, owner.address);

    //     await systemSetup.weth.transfer(tradeAdapterMock.address, ether(0.5));

    //     // Add allowed trader
    //     await leverageStrategyExtension.updateCallerStatus([owner.address], [true]);

    //     // Add second exchange
    //     const exchange2 = exchange;
    //     exchange2.twapMaxTradeSize = ether(1);
    //     exchange2.incentivizedTwapMaxTradeSize = ether(2);
    //     await leverageStrategyExtension.addEnabledExchange(exchangeName2, exchange2);

    //     // Engage to initial leverage
    //     await leverageStrategyExtension.engage(exchangeName);
    //     await increaseTimeAsync(BigNumber.from(100000));
    //     await systemSetup.weth.transfer(tradeAdapterMock.address, ether(0.5));

    //     await leverageStrategyExtension.iterateRebalance(exchangeName);
    //   });

    //   async function subject(): Promise<[BigNumber[], Address, Address]> {
    //     return await leverageStrategyExtension.getChunkRebalanceNotional([ exchangeName, exchangeName2 ]);
    //   }

    //   context("when in the midst of a TWAP rebalance", async () => {
    //     beforeEach(async () => {
    //       // Withdraw balance of USDC from exchange contract from engage
    //       await tradeAdapterMock.withdraw(systemSetup.usdc.address);

    //       // > Max trade size
    //       const newPerpV2ExchangeSettings: PerpV2ExchangeSettings = {
    //         twapMaxTradeSize: ether(0.001),
    //         incentivizedTwapMaxTradeSize: ether(0.002),
    //         exchangeLastTradeTimestamp: exchange.exchangeLastTradeTimestamp,
    //         leverExchangeData: EMPTY_BYTES,
    //         deleverExchangeData: EMPTY_BYTES,
    //       };
    //       await leverageStrategyExtension.updateEnabledExchange(exchangeName, newPerpV2ExchangeSettings);

    //       // Set up new rebalance TWAP
    //       await systemSetup.usdc.transfer(tradeAdapterMock.address, BigNumber.from(4000000));
    //       await chainlinkBasePriceMock.setLatestAnswer(BigNumber.from(990).mul(10 ** 8));
    //       await increaseTimeAsync(BigNumber.from(100000));
    //       await leverageStrategyExtension.rebalance(exchangeName);
    //     });

    //     describe("when above incentivized leverage ratio", async () => {
    //       beforeEach(async () => {
    //         // Set to above incentivized ratio
    //         await chainlinkBasePriceMock.setLatestAnswer(BigNumber.from(800).mul(10 ** 8));
    //       });

    //       it("should return correct total rebalance size and isLever boolean", async () => {
    //         const [ chunkRebalances, sellAsset, buyAsset ] = await subject();

    //         const newLeverageRatio = methodology.maxLeverageRatio;
    //         const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();
    //         const expectedTotalRebalance = await calculateTotalRebalanceNotionalAave(setToken, aWeth, currentLeverageRatio, newLeverageRatio);

    //         expect(sellAsset).to.eq(strategy.collateralAsset);
    //         expect(buyAsset).to.eq(strategy.borrowAsset);
    //         expect(chunkRebalances[0]).to.eq(ether(0.002));
    //         expect(chunkRebalances[1]).to.eq(expectedTotalRebalance);
    //       });
    //     });

    //     describe("when below incentivized leverage ratio", async () => {
    //       beforeEach(async () => {
    //         // Set to below incentivized ratio
    //         await chainlinkBasePriceMock.setLatestAnswer(BigNumber.from(900).mul(10 ** 8));
    //       });

    //       it("should return correct total rebalance size and isLever boolean", async () => {
    //         const [ chunkRebalances, sellAsset, buyAsset ] = await subject();

    //         const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();
    //         const newLeverageRatio = await leverageStrategyExtension.twapLeverageRatio();
    //         const expectedTotalRebalance = await calculateTotalRebalanceNotionalAave(setToken, aWeth, currentLeverageRatio, newLeverageRatio);

    //         expect(sellAsset).to.eq(strategy.collateralAsset);
    //         expect(buyAsset).to.eq(strategy.borrowAsset);
    //         expect(chunkRebalances[0]).to.eq(ether(0.001));
    //         expect(chunkRebalances[1]).to.eq(expectedTotalRebalance);
    //       });
    //     });
    //   });

    //   context("when not in a TWAP rebalance", async () => {

    //     beforeEach(async () => {
    //       const exchange2 = exchange;
    //       exchange2.twapMaxTradeSize = ether(0.001);
    //       exchange2.incentivizedTwapMaxTradeSize = ether(0.002);
    //       await leverageStrategyExtension.updateEnabledExchange(exchangeName2, exchange2);
    //     });

    //     describe("when above incentivized leverage ratio", async () => {
    //       beforeEach(async () => {
    //         // Set to above incentivized ratio
    //         await chainlinkBasePriceMock.setLatestAnswer(BigNumber.from(800).mul(10 ** 8));
    //       });

    //       it("should return correct total rebalance size and isLever boolean", async () => {
    //         const [ chunkRebalances, sellAsset, buyAsset ] = await subject();

    //         const newLeverageRatio = methodology.maxLeverageRatio;
    //         const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();
    //         const expectedTotalRebalance = await calculateTotalRebalanceNotionalAave(setToken, aWeth, currentLeverageRatio, newLeverageRatio);

    //         expect(sellAsset).to.eq(strategy.collateralAsset);
    //         expect(buyAsset).to.eq(strategy.borrowAsset);
    //         expect(chunkRebalances[0]).to.eq(expectedTotalRebalance);
    //         expect(chunkRebalances[1]).to.eq(ether(0.002));
    //       });
    //     });

    //     describe("when between max and min leverage ratio", async () => {
    //       beforeEach(async () => {
    //         await chainlinkBasePriceMock.setLatestAnswer(BigNumber.from(990).mul(10 ** 8));
    //       });

    //       it("should return correct total rebalance size and isLever boolean", async () => {
    //         const [ chunkRebalances, sellAsset, buyAsset ] = await subject();

    //         const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();
    //         const newLeverageRatio = calculateNewLeverageRatio(
    //           currentLeverageRatio,
    //           methodology.targetLeverageRatio,
    //           methodology.minLeverageRatio,
    //           methodology.maxLeverageRatio,
    //           methodology.recenteringSpeed
    //         );
    //         const expectedTotalRebalance = await calculateTotalRebalanceNotionalAave(setToken, aWeth, currentLeverageRatio, newLeverageRatio);

    //         expect(sellAsset).to.eq(strategy.collateralAsset);
    //         expect(buyAsset).to.eq(strategy.borrowAsset);
    //         expect(chunkRebalances[0]).to.eq(expectedTotalRebalance);
    //         expect(chunkRebalances[1]).to.eq(ether(0.001));
    //       });
    //     });

    //     describe("when above max leverage ratio but below incentivized leverage ratio", async () => {
    //       beforeEach(async () => {
    //         await chainlinkBasePriceMock.setLatestAnswer(BigNumber.from(850).mul(10 ** 8));
    //       });

    //       it("should return correct total rebalance size and isLever boolean", async () => {
    //         const [ chunkRebalances, sellAsset, buyAsset ] = await subject();

    //         const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();
    //         const newLeverageRatio = calculateNewLeverageRatio(
    //           currentLeverageRatio,
    //           methodology.targetLeverageRatio,
    //           methodology.minLeverageRatio,
    //           methodology.maxLeverageRatio,
    //           methodology.recenteringSpeed
    //         );
    //         const expectedTotalRebalance = await calculateTotalRebalanceNotionalAave(setToken, aWeth, currentLeverageRatio, newLeverageRatio);

    //         expect(sellAsset).to.eq(strategy.collateralAsset);
    //         expect(buyAsset).to.eq(strategy.borrowAsset);
    //         expect(chunkRebalances[0]).to.eq(expectedTotalRebalance);
    //         expect(chunkRebalances[1]).to.eq(ether(0.001));
    //       });
    //     });

    //     describe("when below min leverage ratio", async () => {
    //       beforeEach(async () => {
    //         await chainlinkBasePriceMock.setLatestAnswer(BigNumber.from(1400).mul(10 ** 8));
    //       });

    //       it("should return correct total rebalance size and isLever boolean", async () => {
    //         const [ chunkRebalances, sellAsset, buyAsset ] = await subject();

    //         const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();
    //         const newLeverageRatio = calculateNewLeverageRatio(
    //           currentLeverageRatio,
    //           methodology.targetLeverageRatio,
    //           methodology.minLeverageRatio,
    //           methodology.maxLeverageRatio,
    //           methodology.recenteringSpeed
    //         );
    //         const totalCollateralRebalance = await calculateTotalRebalanceNotionalAave(setToken, aWeth, currentLeverageRatio, newLeverageRatio);
    //         // Multiply collateral by conversion rate (1400 USDC per ETH) and adjust for decimals
    //         const expectedTotalRebalance = preciseMul(totalCollateralRebalance, ether(1400)).div(BigNumber.from(10).pow(12));

  //         expect(sellAsset).to.eq(strategy.borrowAsset);
  //         expect(buyAsset).to.eq(strategy.collateralAsset);
  //         expect(chunkRebalances[0]).to.eq(expectedTotalRebalance);
  //         expect(chunkRebalances[1]).to.eq(preciseMul(ether(0.001), ether(1400)).div(BigNumber.from(10).pow(12)));
  //       });
  //     });
  //   });
  });
});
