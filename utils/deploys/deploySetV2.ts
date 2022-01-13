import { Signer } from "ethers";
import {
  Address
} from "../types";

import { DebtIssuanceModule } from "@setprotocol/set-protocol-v2/typechain/DebtIssuanceModule";
import { DebtIssuanceModule__factory } from "@setprotocol/set-protocol-v2/typechain/factories/DebtIssuanceModule__factory";

export default class DeploySetV2 {
  private _deployerSigner: Signer;

  constructor(deployerSigner: Signer) {
    this._deployerSigner = deployerSigner;
  }

  public async deployDebtIssuanceModule(
    controller: Address,
  ): Promise<DebtIssuanceModule> {
    return await new DebtIssuanceModule__factory(this._deployerSigner).deploy(
      controller,
    );
  }
}
