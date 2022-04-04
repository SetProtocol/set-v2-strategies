import { Signer, BigNumber } from "ethers";
import {
  Address,
  PerpV2LeverageContractSettings,
  PerpV2LeverageMethodologySettings,
  PerpV2LeverageExecutionSettings,
  PerpV2LeverageIncentiveSettings,
  PerpV2LeverageExchangeSettings,
  PerpV2BasisContractSettings,
  PerpV2BasisMethodologySettings,
  PerpV2BasisExecutionSettings,
  PerpV2BasisIncentiveSettings,
  PerpV2BasisExchangeSettings
} from "../types";
import {
  DeltaNeutralBasisTradingStrategyExtension,
  PerpV2LeverageStrategyExtension,
  FeeSplitExtension
} from "../contracts/index";

import { DeltaNeutralBasisTradingStrategyExtension__factory } from "../../typechain/factories/DeltaNeutralBasisTradingStrategyExtension__factory";
import { PerpV2LeverageStrategyExtension__factory } from "../../typechain/factories/PerpV2LeverageStrategyExtension__factory";
import { FeeSplitExtension__factory } from "../../typechain/factories/FeeSplitExtension__factory";

export default class DeployExtensions {
  private _deployerSigner: Signer;

  constructor(deployerSigner: Signer) {
    this._deployerSigner = deployerSigner;
  }

  public async deployPerpV2LeverageStrategyExtension(
    manager: Address,
    contractSettings: PerpV2LeverageContractSettings,
    methodologySettings: PerpV2LeverageMethodologySettings,
    executionSettings: PerpV2LeverageExecutionSettings,
    incentiveSettings: PerpV2LeverageIncentiveSettings,
    exchangeSettings: PerpV2LeverageExchangeSettings
  ): Promise<PerpV2LeverageStrategyExtension> {
    return await new PerpV2LeverageStrategyExtension__factory(this._deployerSigner).deploy(
      manager,
      contractSettings,
      methodologySettings,
      executionSettings,
      incentiveSettings,
      exchangeSettings,
    );
  }

  public async deployDeltaNeutralBasisTradingStrategyExtension(
    manager: Address,
    contractSettings: PerpV2BasisContractSettings,
    methodologySettings: PerpV2BasisMethodologySettings,
    executionSettings: PerpV2BasisExecutionSettings,
    incentiveSettings: PerpV2BasisIncentiveSettings,
    exchangeSettings: PerpV2BasisExchangeSettings
  ): Promise<DeltaNeutralBasisTradingStrategyExtension> {
    return await new DeltaNeutralBasisTradingStrategyExtension__factory(this._deployerSigner).deploy(
      manager,
      contractSettings,
      methodologySettings,
      executionSettings,
      incentiveSettings,
      exchangeSettings,
    );
  }

  public async deployFeeSplitExtension(
    manager: Address,
    streamingFeeModule: Address,
    debtIssuanceModule: Address,
    operatorFeeSplit: BigNumber,
    operatorFeeRecipient: Address
  ): Promise<FeeSplitExtension> {
    return await new FeeSplitExtension__factory(this._deployerSigner).deploy(
      manager,
      streamingFeeModule,
      debtIssuanceModule,
      operatorFeeSplit,
      operatorFeeRecipient
    );
  }
}
