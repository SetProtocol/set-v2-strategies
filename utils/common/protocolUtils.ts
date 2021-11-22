import { BigNumber, constants, ethers, providers } from "ethers";

export class ProtocolUtils {
  public _provider: providers.Web3Provider | providers.JsonRpcProvider;

  constructor(_provider: providers.Web3Provider | providers.JsonRpcProvider) {
    this._provider = _provider;
  }

  public async getCreatedSetTokenAddress (txnHash: string | undefined): Promise<string> {
    if (!txnHash) {
      throw new Error("Invalid transaction hash");
    }

    const abi = ["event SetTokenCreated(address indexed _setToken, address _manager, string _name, string _symbol)"];
    const iface = new ethers.utils.Interface(abi);

    const topic = ethers.utils.id("SetTokenCreated(address,address,string,string)");
    const logs = await this._provider.getLogs({
      fromBlock: "latest",
      toBlock: "latest",
      topics: [topic],
    });

    const parsed = iface.parseLog(logs[logs.length - 1]);
    return parsed.args._setToken;
  }
}