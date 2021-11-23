import { Signer, BigNumber } from "ethers";
import { Address } from "../types";
import {
  BaseExtensionMock,
  ChainlinkAggregatorMock,
  MutualUpgradeMock,
  StandardTokenMock,
  StringArrayUtilsMock,
} from "../contracts/index";

import { BaseExtensionMock__factory } from "../../typechain/factories/BaseExtensionMock__factory";
import { ChainlinkAggregatorMock__factory  } from "../../typechain/factories/ChainlinkAggregatorMock__factory";
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

  public async deployChainlinkAggregatorMock(decimals: number): Promise<ChainlinkAggregatorMock> {
    return await new ChainlinkAggregatorMock__factory(this._deployerSigner).deploy(decimals);
  }

  public async deployStringArrayUtilsMock(): Promise<StringArrayUtilsMock> {
    return await new StringArrayUtilsMock__factory(this._deployerSigner).deploy();
  }
}
