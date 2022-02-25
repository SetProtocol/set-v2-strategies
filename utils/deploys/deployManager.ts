import { Signer } from "ethers";
import { Address } from "../types";
import {
  BaseManager,
  DelegatedManager
} from "../contracts/index";

import { BaseManager__factory } from "../../typechain/factories/BaseManager__factory";
import { DelegatedManager__factory } from "../../typechain/factories/DelegatedManager__factory";

export default class DeployToken {
  private _deployerSigner: Signer;

  constructor(deployerSigner: Signer) {
    this._deployerSigner = deployerSigner;
  }

  public async deployBaseManager(
    set: Address,
    operator: Address,
    methodologist: Address
  ): Promise<BaseManager> {
    return await new BaseManager__factory(this._deployerSigner).deploy(
      set,
      operator,
      methodologist
    );
  }

  public async deployDelegatedManager(
    setToken: Address,
    factory: Address,
    methodologist: Address,
    extensions: Address[],
    operators: Address[],
    allowedAssets: Address[],
  ): Promise<DelegatedManager> {
    return await new DelegatedManager__factory(this._deployerSigner).deploy(
      setToken,
      factory,
      methodologist,
      extensions,
      operators,
      allowedAssets
    );
  }
}