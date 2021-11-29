import { Signer, BigNumber, BigNumberish  } from "ethers";
import { Address } from "../types";
import { convertLibraryNameToLinkId } from "../common";
import {
  AaveLeverageModule,
  AaveV2,
  AirdropModule,
  BasicIssuanceModule,
  Compound,
  CompoundLeverageModule,
  Controller,
  ComptrollerMock,
  ContractCallerMock,
  DebtIssuanceModule,
  GeneralIndexModule,
  GovernanceModule,
  IntegrationRegistry,
  StreamingFeeModule,
  SetToken,
  SetTokenCreator,
  SingleIndexModule,
  UniswapV2ExchangeAdapter,
  PerpV2,
  PerpV2LeverageModule,
  WETH9,
  AaveLeverageModule__factory,
  AaveV2__factory,
  AirdropModule__factory,
  BasicIssuanceModule__factory,
  Controller__factory,
  Compound__factory,
  CompoundLeverageModule__factory,
  ComptrollerMock__factory,
  ContractCallerMock__factory,
  DebtIssuanceModule__factory,
  GeneralIndexModule__factory,
  GovernanceModule__factory,
  IntegrationRegistry__factory,
  SingleIndexModule__factory,
  StreamingFeeModule__factory,
  SetToken__factory,
  SetTokenCreator__factory,
  UniswapV2ExchangeAdapter__factory,
  PerpV2__factory,
  PerpV2LeverageModule__factory,
  WETH9__factory,
} from "../contracts/setV2";

import { StandardTokenMock } from "../contracts/index";
import { StandardTokenMock__factory } from "../../typechain/factories/StandardTokenMock__factory";
import { ether } from "../common";
export default class DeploySetV2 {
  private _deployerSigner: Signer;

  constructor(deployerSigner: Signer) {
    this._deployerSigner = deployerSigner;
  }

  public async deployController(feeRecipient: Address): Promise<Controller> {
    return await new Controller__factory(this._deployerSigner).deploy(feeRecipient);
  }

  public async deploySetTokenCreator(controller: Address): Promise<SetTokenCreator> {
    return await new SetTokenCreator__factory(this._deployerSigner).deploy(controller);
  }

  public async deployCompoundLib(): Promise<Compound> {
    return await new Compound__factory(this._deployerSigner).deploy();
  }

  public async deploySetToken(
    _components: Address[],
    _units: BigNumberish[],
    _modules: Address[],
    _controller: Address,
    _manager: Address,
    _name: string,
    _symbol: string,
  ): Promise<SetToken> {
    return await new SetToken__factory(this._deployerSigner).deploy(
      _components,
      _units,
      _modules,
      _controller,
      _manager,
      _name,
      _symbol,
    );
  }

  public async deployBasicIssuanceModule(controller: Address): Promise<BasicIssuanceModule> {
    return await new BasicIssuanceModule__factory(this._deployerSigner).deploy(controller);
  }

  public async deployContractCallerMock(): Promise<ContractCallerMock> {
    return await new ContractCallerMock__factory(this._deployerSigner).deploy();
  }

  public async deployComptrollerMock(
    comp: Address,
    compAmount: BigNumber,
    cToken: Address
  ): Promise<ComptrollerMock> {
    return await new ComptrollerMock__factory(this._deployerSigner).deploy(
      comp,
      compAmount,
      cToken
    );
  }

  public async deployDebtIssuanceModule(controller: Address): Promise<DebtIssuanceModule> {
    return await new DebtIssuanceModule__factory(this._deployerSigner).deploy(controller);
  }

  public async deployStreamingFeeModule(controller: Address): Promise<StreamingFeeModule> {
    return await new StreamingFeeModule__factory(this._deployerSigner).deploy(controller);
  }

  public async deploySingleIndexModule(
    controller: Address,
    weth: Address,
    uniswapRouter: Address,
    sushiswapRouter: Address,
    balancerProxy: Address
  ): Promise<SingleIndexModule> {
    return await new SingleIndexModule__factory(this._deployerSigner).deploy(
      controller,
      weth,
      uniswapRouter,
      sushiswapRouter,
      balancerProxy
    );
  }

  public async deployGeneralIndexModule(
    controller: Address,
    weth: Address,
  ): Promise<GeneralIndexModule> {
    return await new GeneralIndexModule__factory(this._deployerSigner).deploy(
      controller,
      weth,
    );
  }

  public async deployWETH(): Promise<WETH9> {
    return await new WETH9__factory(this._deployerSigner).deploy();
  }

  public async deployIntegrationRegistry(controller: Address): Promise<IntegrationRegistry> {
    return await new IntegrationRegistry__factory(this._deployerSigner).deploy(controller);
  }

  public async deployCompoundLeverageModule(
    controller: Address,
    compToken: Address,
    comptroller: Address,
    cEther: Address,
    weth: Address,
  ): Promise<CompoundLeverageModule> {
    const compoundLib = await this.deployCompoundLib();

    const linkId = convertLibraryNameToLinkId(
      "contracts/protocol/integration/lib/Compound.sol:Compound"
    );

    return await new CompoundLeverageModule__factory(
      // @ts-ignore
      {
        [linkId]: compoundLib.address,
      },
      // @ts-ignore
      this._deployerSigner
    ).deploy(
      controller,
      compToken,
      comptroller,
      cEther,
      weth,
    );
  }

  public async deployGovernanceModule(controller: Address): Promise<GovernanceModule> {
    return await new GovernanceModule__factory(this._deployerSigner).deploy(controller);
  }

  public async deployUniswapV2ExchangeAdapter(
    router: Address
  ): Promise<UniswapV2ExchangeAdapter> {
    return await new UniswapV2ExchangeAdapter__factory(this._deployerSigner).deploy(
      router
    );
  }

  public async deployTokenMock(
    initialAccount: Address,
    initialBalance: BigNumberish = ether(1000000000),
    decimals: BigNumberish = 18,
    name: string = "Token",
    symbol: string = "Symbol"
  ): Promise<StandardTokenMock> {
    return await new StandardTokenMock__factory(this._deployerSigner)
      .deploy(initialAccount, initialBalance, name, symbol, decimals);
  }

  public async getTokenMock(token: Address): Promise<StandardTokenMock> {
    return await new StandardTokenMock__factory(this._deployerSigner).attach(token);
  }

  public async deployAaveV2Lib(): Promise<AaveV2> {
    return await new AaveV2__factory(this._deployerSigner).deploy();
  }

  public async deployAaveLeverageModule(
    controller: string,
    lendingPoolAddressesProvider: string,
  ): Promise<AaveLeverageModule> {
    const aaveV2Lib = await this.deployAaveV2Lib();

    const linkId = convertLibraryNameToLinkId(
      "contracts/protocol/integration/lib/AaveV2.sol:AaveV2"
    );

    return await new AaveLeverageModule__factory(
      // @ts-ignore
      {
        [linkId]: aaveV2Lib.address,
      },
      // @ts-ignore
      this._deployerSigner
    ).deploy(
      controller,
      lendingPoolAddressesProvider
    );
  }

  public async deployPerpV2Lib(): Promise<PerpV2> {
    return await new PerpV2__factory(this._deployerSigner).deploy();
  }

  public async deployPerpV2LeverageModule(
    controller: string,
    perpVault: string,
    perpQuoter: string,
    perpMarketRegistry: string,
  ): Promise<PerpV2LeverageModule> {
    const perpV2Lib = await this.deployPerpV2Lib();

    const linkId = convertLibraryNameToLinkId(
      "contracts/protocol/integration/lib/PerpV2.sol:PerpV2"
    );

    return await new PerpV2LeverageModule__factory(
      // @ts-ignore
      {
        [linkId]: perpV2Lib.address,
      },
      // @ts-ignore
      this._deployerSigner
    ).deploy(
      controller,
      perpVault,
      perpQuoter,
      perpMarketRegistry
    );
  }

  public async deployAirdropModule(controller: Address): Promise<AirdropModule> {
    return await new AirdropModule__factory(this._deployerSigner).deploy(controller);
  }
}