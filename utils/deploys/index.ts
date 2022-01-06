import { Signer } from "ethers";

import SetDeployHelper from "@setprotocol/set-protocol-v2/utils/deploys";

import DeployManager from "./deployManager";
import DeployMocks from "./deployMocks";
import DeployExtensions from "./deployExtensions";

export default class DeployHelper {
  public extensions: DeployExtensions;
  public manager: DeployManager;
  public mocks: DeployMocks;
  public setDeployer: SetDeployHelper;

  constructor(deployerSigner: Signer) {
    this.extensions = new DeployExtensions(deployerSigner);
    this.manager = new DeployManager(deployerSigner);
    this.mocks = new DeployMocks(deployerSigner);
    this.setDeployer = new SetDeployHelper(deployerSigner);
  }
}