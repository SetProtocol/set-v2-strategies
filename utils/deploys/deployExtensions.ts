import { Signer, BigNumber } from "ethers";
import {
  Address
} from "../types";
import {
  StreamingFeeSplitExtension
} from "../contracts/index";

import { StreamingFeeSplitExtension__factory } from "../../typechain/factories/StreamingFeeSplitExtension__factory";

export default class DeployExtensions {
  private _deployerSigner: Signer;

  constructor(deployerSigner: Signer) {
    this._deployerSigner = deployerSigner;
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