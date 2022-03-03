import { Signer } from "ethers";
import { Address } from "../types";
import {
  BasicIssuanceExtension,
  StreamingFeeSplitExtension,
  TradeExtension
} from "../contracts/index";

import { BasicIssuanceExtension__factory } from "../../typechain/factories/BasicIssuanceExtension__factory";
import { StreamingFeeSplitExtension__factory } from "../../typechain/factories/StreamingFeeSplitExtension__factory";
import { TradeExtension__factory } from "../../typechain/factories/TradeExtension__factory";

export default class DeployGlobalExtensions {
  private _deployerSigner: Signer;

  constructor(deployerSigner: Signer) {
    this._deployerSigner = deployerSigner;
  }

  public async deployBasicIssuanceExtension(
    basicIssuanceModule: Address
  ): Promise<BasicIssuanceExtension> {
    return await new BasicIssuanceExtension__factory(this._deployerSigner).deploy(
      basicIssuanceModule,
    );
  }

  public async deployStreamingFeeSplitExtension(
    streamingFeeModule: Address
  ): Promise<StreamingFeeSplitExtension> {
    return await new StreamingFeeSplitExtension__factory(this._deployerSigner).deploy(
      streamingFeeModule,
    );
  }

  public async deployTradeExtension(
    tradeModule: Address
  ): Promise<TradeExtension> {
    return await new TradeExtension__factory(this._deployerSigner).deploy(
      tradeModule,
    );
  }
}