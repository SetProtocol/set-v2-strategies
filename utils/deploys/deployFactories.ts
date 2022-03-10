import { Signer } from "ethers";
import {
  Address
} from "../types";

import { DelegatedManagerFactory } from "../contracts";
import { DelegatedManagerFactory__factory } from "../../typechain/factories/DelegatedManagerFactory__factory";

export default class DeployFactories {
  private _deployerSigner: Signer;

  constructor(deployerSigner: Signer) {
    this._deployerSigner = deployerSigner;
  }

  public async deployDelegatedManagerFactory(
    managerCore: Address,
    setTokenFactory: Address
  ): Promise<DelegatedManagerFactory> {
    return await new DelegatedManagerFactory__factory(this._deployerSigner).deploy(managerCore, setTokenFactory);
  }
}