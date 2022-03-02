import { Signer } from "ethers";
import {
  Address
} from "../types";

import { SetToken } from "@setprotocol/set-protocol-v2/typechain/SetToken";
import { SetToken__factory } from "@setprotocol/set-protocol-v2/typechain/factories/SetToken__factory";
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

  /* GETTERS */

  public async getSetToken(setTokenAddress: Address): Promise<SetToken> {
    return await new SetToken__factory(this._deployerSigner).attach(setTokenAddress);
  }
}
