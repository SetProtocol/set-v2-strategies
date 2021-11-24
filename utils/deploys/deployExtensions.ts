import { Signer, BigNumber } from "ethers";
import {
  Address,
  PerpV2ContractSettings,
  PerpV2MethodologySettings,
  PerpV2ExecutionSettings,
  PerpV2IncentiveSettings,
  PerpV2ExchangeSettings
} from "../types";
import {
  PerpV2LeverageStrategyExtension,
  StreamingFeeSplitExtension
} from "../contracts/index";

import { PerpV2LeverageStrategyExtension__factory } from "../../typechain/factories/PerpV2LeverageStrategyExtension__factory";
import { StreamingFeeSplitExtension__factory } from "../../typechain/factories/StreamingFeeSplitExtension__factory";

export default class DeployExtensions {
  private _deployerSigner: Signer;

  constructor(deployerSigner: Signer) {
    this._deployerSigner = deployerSigner;
  }
 
  public async deployPerpV2LeverageStrategyExtension(
    manager: Address,
    contractSettings: PerpV2ContractSettings,
    methodologySettings: PerpV2MethodologySettings,
    executionSettings: PerpV2ExecutionSettings,
    incentiveSettings: PerpV2IncentiveSettings,
    exchangeSettings: PerpV2ExchangeSettings
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

  public async deployStreamingFeeSplitExtension(
    manager: Address,
    streamingFeeModule: Address,
    operatorFeeSplit: BigNumber,
    operatorFeeRecipient: Address,
  ): Promise<StreamingFeeSplitExtension> {
    return await new StreamingFeeSplitExtension__factory(this._deployerSigner).deploy(
      manager,
      streamingFeeModule,
      operatorFeeSplit,
      operatorFeeRecipient
    );
  }
}