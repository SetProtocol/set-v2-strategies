import { Signer } from "ethers";

import SetDeployHelper from "@setprotocol/set-protocol-v2/utils/deploys";

import DeployManager from "./deployManager";
import DeployMocks from "./deployMocks";
import DeployExtensions from "./deployExtensions";
import DeployFactories from "./deployFactories";
import DeployHooks from "./deployHooks";
import DeploySetV2 from "./deploySetV2";

export default class DeployHelper {
  public extensions: DeployExtensions;
  public factories: DeployFactories;
  public manager: DeployManager;
  public mocks: DeployMocks;
  public hooks: DeployHooks;
  public setV2: DeploySetV2;
  public setDeployer: SetDeployHelper;

  constructor(deployerSigner: Signer) {
    this.extensions = new DeployExtensions(deployerSigner);
    this.factories = new DeployFactories(deployerSigner);
    this.manager = new DeployManager(deployerSigner);
    this.mocks = new DeployMocks(deployerSigner);
    this.hooks = new DeployHooks(deployerSigner);
    this.setV2 = new DeploySetV2(deployerSigner);
    this.setDeployer = new SetDeployHelper(deployerSigner);
  }
}