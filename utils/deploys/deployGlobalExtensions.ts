import { Signer } from "ethers";
import { Address } from "../types";
import {
  BatchTradeExtension,
  IssuanceExtension,
  StreamingFeeSplitExtension,
  TradeExtension
} from "../contracts/index";

import { BatchTradeExtension__factory } from "../../typechain/factories/BatchTradeExtension__factory";
import { IssuanceExtension__factory } from "../../typechain/factories/IssuanceExtension__factory";
import { StreamingFeeSplitExtension__factory } from "../../typechain/factories/StreamingFeeSplitExtension__factory";
import { TradeExtension__factory } from "../../typechain/factories/TradeExtension__factory";

export default class DeployGlobalExtensions {
  private _deployerSigner: Signer;

  constructor(deployerSigner: Signer) {
    this._deployerSigner = deployerSigner;
  }

  public async deployBatchTradeExtension(
    managerCore: Address,
    tradeModule: Address
  ): Promise<BatchTradeExtension> {
    return await new BatchTradeExtension__factory(this._deployerSigner).deploy(
      managerCore,
      tradeModule,
    );
  }

  public async deployIssuanceExtension(
    managerCore: Address,
    basicIssuanceModule: Address
  ): Promise<IssuanceExtension> {
    return await new IssuanceExtension__factory(this._deployerSigner).deploy(
      managerCore,
      basicIssuanceModule,
    );
  }

  public async deployStreamingFeeSplitExtension(
    managerCore: Address,
    streamingFeeModule: Address
  ): Promise<StreamingFeeSplitExtension> {
    return await new StreamingFeeSplitExtension__factory(this._deployerSigner).deploy(
      managerCore,
      streamingFeeModule,
    );
  }

  public async deployTradeExtension(
    managerCore: Address,
    tradeModule: Address
  ): Promise<TradeExtension> {
    return await new TradeExtension__factory(this._deployerSigner).deploy(
      managerCore,
      tradeModule,
    );
  }
}