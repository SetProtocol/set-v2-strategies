import axios from "axios";
import { providers, BigNumber } from "ethers";
import { Address, TradeInfo, BatchTradeResult } from "@utils/types";
import { BatchTradeExtension } from "../contracts/index";

export class BatchTradeUtils {
  public provider: providers.Web3Provider | providers.JsonRpcProvider;

  constructor(_provider: providers.Web3Provider | providers.JsonRpcProvider) {
    this.provider = _provider;
  }

  // Helper to fetch transaction statuses
  public async getBatchTradeResults(
    batchTradeInstance: BatchTradeExtension,
    transactionHash: string,
    trades: TradeInfo[]
  ): Promise<BatchTradeResult[]> {

    const receipt = await this.provider.getTransactionReceipt(transactionHash);
    const results: BatchTradeResult[] = [];

    for (const trade of trades) {
      results.push({
        success: true,
        tradeInfo: trade,
      });
    }

    for (const log of receipt.logs) {
      try {
        const decodedLog = batchTradeInstance.interface.parseLog({
          data: log.data,
          topics: log.topics,
        });

        if (decodedLog.name === "StringTradeFailed") {
          const tradeIndex = (decodedLog.args as any)._index.toNumber();
          results[tradeIndex].success = false;
          results[tradeIndex].revertReason = (decodedLog.args as any)._reason;
        }

        if (decodedLog.name === "BytesTradeFailed") {
          const tradeIndex = (decodedLog.args as any)._index.toNumber();
          results[tradeIndex].success = false;
          results[tradeIndex].revertReason = (decodedLog.args as any)._reason;
        }
      } catch(e) {
        // ignore all non-batch trade events
      }
    }

    return results;
  }

  // Helper to fetch trade quotes from 0x
  public async getZeroExQuote(
    delegatedManager: Address,
    sellToken: Address,
    buyToken: Address,
    amount: BigNumber,
    slippagePercentage: number = .02 // Default to 2%
  ) {
    const url = "https://api.0x.org/swap/v1/quote";

    const params = {
      sellToken,
      buyToken,
      slippagePercentage,
      sellAmount: amount.toString(),
      takerAddress: delegatedManager,
      excludedSources: [],
      skipValidation: true,
    };

    const headers = {
      "Content-Type": "application/json",
      "Accept": "application/json",
    };

    const response = await axios.get(url, {
      params,
      headers,
    });

    return response.data;
  }
}