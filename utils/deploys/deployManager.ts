import { Signer } from "ethers";
import { Address } from "../types";
import { BaseManagerV2 } from "../contracts/index";
import { BaseManagerV2__factory } from "../../typechain/factories/BaseManagerV2__factory";

export default class DeployToken {
  private _deployerSigner: Signer;

  constructor(deployerSigner: Signer) {
    this._deployerSigner = deployerSigner;
  }

  public async deployBaseManagerV2(
    set: Address,
    operator: Address,
    methodologist: Address
  ): Promise<BaseManagerV2> {
    return await new BaseManagerV2__factory(this._deployerSigner).deploy(
      set,
      operator,
      methodologist
    );
  }
}