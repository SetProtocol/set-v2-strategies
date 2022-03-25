import { Signer, BigNumber } from "ethers";
import { Address } from "../types";
import {
  AddressArrayUtilsMock,
  BaseExtensionMock,
  BaseGlobalExtensionMock,
  ManagerMock,
  ModuleMock,
  MutualUpgradeMock,
  StandardTokenMock,
  StringArrayUtilsMock,
  PerpV2PriceFeedMock
} from "../contracts/index";

import {
  ChainlinkAggregatorMock,
  ContractCallerMock
} from "@setprotocol/set-protocol-v2/typechain";

import { AddressArrayUtilsMock__factory } from "../../typechain/factories/AddressArrayUtilsMock__factory";
import { BaseExtensionMock__factory } from "../../typechain/factories/BaseExtensionMock__factory";
import { BaseGlobalExtensionMock__factory } from "../../typechain/factories/BaseGlobalExtensionMock__factory";
import { ManagerMock__factory } from "../../typechain/factories/ManagerMock__factory";
import { ModuleMock__factory } from "../../typechain/factories/ModuleMock__factory";
import { ChainlinkAggregatorMock__factory  } from "@setprotocol/set-protocol-v2/dist/typechain";
import { ContractCallerMock__factory } from "@setprotocol/set-protocol-v2/dist/typechain";
import { MutualUpgradeMock__factory } from "../../typechain/factories/MutualUpgradeMock__factory";
import { MutualUpgradeV2Mock__factory } from "../../typechain/factories/MutualUpgradeV2Mock__factory";
import { PerpV2PriceFeedMock__factory } from "../../typechain/factories/PerpV2PriceFeedMock__factory";
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

  public async deployBaseGlobalExtensionMock(managerCore: Address, module: Address): Promise<BaseGlobalExtensionMock> {
    return await new BaseGlobalExtensionMock__factory(this._deployerSigner).deploy(managerCore, module);
  }

  public async deployManagerMock(setToken: Address): Promise<ManagerMock> {
    return await new ManagerMock__factory(this._deployerSigner).deploy(setToken);
  }

  public async deployModuleMock(controller: Address): Promise<ModuleMock> {
    return await new ModuleMock__factory(this._deployerSigner).deploy(controller);
  }

  public async deployAddressArrayUtilsMock(): Promise<AddressArrayUtilsMock> {
    return await new AddressArrayUtilsMock__factory(this._deployerSigner).deploy();
  }

  public async deployMutualUpgradeMock(owner: Address, methodologist: string): Promise<MutualUpgradeMock> {
    return await new MutualUpgradeMock__factory(this._deployerSigner).deploy(owner, methodologist);
  }

  public async deployMutualUpgradeV2Mock(owner: Address, methodologist: string): Promise<MutualUpgradeMock> {
    return await new MutualUpgradeV2Mock__factory(this._deployerSigner).deploy(owner, methodologist);
  }

  public async deployStandardTokenMock(owner: Address, decimals: number): Promise<StandardTokenMock> {
    return await new StandardTokenMock__factory(this._deployerSigner).deploy(
      owner,
      BigNumber.from(1000000).mul(BigNumber.from(10).pow(decimals)),
      "USDCoin",
      "USDC",
      decimals
    );
  }

  public async deployChainlinkAggregatorMock(decimals: number): Promise<ChainlinkAggregatorMock> {
    return await new ChainlinkAggregatorMock__factory(this._deployerSigner).deploy(decimals);
  }

  public async deployStringArrayUtilsMock(): Promise<StringArrayUtilsMock> {
    return await new StringArrayUtilsMock__factory(this._deployerSigner).deploy();
  }

  public async deployContractCallerMock(): Promise<ContractCallerMock> {
    return await new ContractCallerMock__factory(this._deployerSigner).deploy();
  }

  public async deployPerpV2PriceFeedMock(decimals: number): Promise<PerpV2PriceFeedMock> {
    return await new PerpV2PriceFeedMock__factory(this._deployerSigner).deploy(decimals);
  }
}
