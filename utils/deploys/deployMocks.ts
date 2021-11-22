import { Signer, BigNumber } from "ethers";
import { Address } from "../types";
import {
  BaseExtensionMock,
  MutualUpgradeMock,
  StandardTokenMock,
  StringArrayUtilsMock,
} from "../contracts/index";

import { BaseExtensionMock__factory } from "../../typechain/factories/BaseExtensionMock__factory";
import { ChainlinkAggregatorV3Mock__factory  } from "../../typechain/factories/ChainlinkAggregatorV3Mock__factory";
import { MutualUpgradeMock__factory } from "../../typechain/factories/MutualUpgradeMock__factory";
import { StandardTokenMock__factory  } from "../../typechain/factories/StandardTokenMock__factory";
import { StringArrayUtilsMock__factory  } from "../../typechain/factories/StringArrayUtilsMock__factory";

export default class DeployMocks {
  private _deployerSigner: Signer;

  constructor(deployerSigner: Signer) {
    this._deployerSigner = deployerSigner;
  }

  public async deployBaseExtensionMock(manager: Address): Promise<BaseExtensionMock> {
    return await new BaseExtensionMock__factory(this._deployerSigner).deploy(manager);
  }

  public async deployMutualUpgradeMock(owner: Address, methodologist: string): Promise<MutualUpgradeMock> {
    return await new MutualUpgradeMock__factory(this._deployerSigner).deploy(owner, methodologist);
  }

  public async deployStandardTokenMock(owner: Address, decimals: number): Promise<StandardTokenMock> {
    return await new StandardTokenMock__factory(this._deployerSigner).deploy(owner, BigNumber.from(1000000).mul(BigNumber.from(10).pow(decimals)), "USDCoin", "USDC", decimals);
  }

  public async deployChainlinkAggregatorMock() {
    return await new ChainlinkAggregatorV3Mock__factory(this._deployerSigner).deploy();
  }

  public async deployStringArrayUtilsMock(): Promise<StringArrayUtilsMock> {
    return await new StringArrayUtilsMock__factory(this._deployerSigner).deploy();
  }
}
