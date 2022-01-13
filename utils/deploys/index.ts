import { Signer } from "ethers";

import SetDeployHelper from "@setprotocol/set-protocol-v2/utils/deploys";

import DeployManager from "./deployManager";
import DeployMocks from "./deployMocks";
import DeployExtensions from "./deployExtensions";
import DeploySetV2 from "./deploySetV2";

export default class DeployHelper {
  public extensions: DeployExtensions;
  public manager: DeployManager;
  public mocks: DeployMocks;
  public setV2: DeploySetV2;
  public setDeployer: SetDeployHelper;

  constructor(deployerSigner: Signer) {
    this.extensions = new DeployExtensions(deployerSigner);
    this.manager = new DeployManager(deployerSigner);
    this.mocks = new DeployMocks(deployerSigner);
    this.setV2 = new DeploySetV2(deployerSigner);
    this.setDeployer = new SetDeployHelper(deployerSigner);
  }
}