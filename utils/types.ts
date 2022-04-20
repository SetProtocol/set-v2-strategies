import {
  ContractTransaction as ContractTransactionType,
  Wallet as WalletType
} from "ethers";
import { BigNumber } from "ethers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";

export type Account = {
  address: Address;
  wallet: SignerWithAddress;
};

export type Address = string;
export type Bytes = string;

export type ContractTransaction = ContractTransactionType;
export type Wallet = WalletType;

export interface MerkleDistributorInfo {
  merkleRoot: string;
  tokenTotal: string;
  claims: {
    [account: string]: {
      index: number;
      amount: string;
      proof: string[];
      flags?: {
        [flag: string]: boolean;
      };
    };
  };
}

export type DistributionFormat = { address: string; earnings: BigNumber };

export interface PerpV2LeverageContractSettings {
  setToken: Address;
  perpV2LeverageModule: Address;
  perpV2AccountBalance: Address;
  baseUSDPriceOracle: Address;
  twapInterval: BigNumber;
  basePriceDecimalAdjustment: BigNumber;
  virtualBaseAddress: Address;
  virtualQuoteAddress: Address;
}

export interface PerpV2LeverageMethodologySettings {
  targetLeverageRatio: BigNumber;
  minLeverageRatio: BigNumber;
  maxLeverageRatio: BigNumber;
  recenteringSpeed: BigNumber;
  rebalanceInterval: BigNumber;
}

export interface PerpV2LeverageExecutionSettings {
  twapCooldownPeriod: BigNumber;
  slippageTolerance: BigNumber;
}

export interface PerpV2LeverageExchangeSettings {
  twapMaxTradeSize: BigNumber;
  incentivizedTwapMaxTradeSize: BigNumber;
}

export interface PerpV2LeverageIncentiveSettings {
  incentivizedTwapCooldownPeriod: BigNumber;
  incentivizedSlippageTolerance: BigNumber;
  etherReward: BigNumber;
  incentivizedLeverageRatio: BigNumber;
}

export interface PerpV2BasisContractSettings {
  setToken: Address;
  basisTradingModule: Address;
  tradeModule: Address;
  quoter: Address;
  perpV2AccountBalance: Address;
  baseUSDPriceOracle: Address;
  twapInterval: BigNumber;
  basePriceDecimalAdjustment: BigNumber;
  virtualBaseAddress: Address;
  virtualQuoteAddress: Address;
  spotAssetAddress: Address;
}

export interface PerpV2BasisMethodologySettings {
  targetLeverageRatio: BigNumber;
  minLeverageRatio: BigNumber;
  maxLeverageRatio: BigNumber;
  recenteringSpeed: BigNumber;
  rebalanceInterval: BigNumber;
  reinvestInterval: BigNumber;
  minReinvestUnits: BigNumber;
}

export interface PerpV2BasisExecutionSettings {
  twapCooldownPeriod: BigNumber;
  slippageTolerance: BigNumber;
}

export interface PerpV2BasisExchangeSettings {
  exchangeName: string;
  buyExactSpotTradeData: Bytes;
  sellExactSpotTradeData: Bytes;
  buySpotQuoteExactInputPath: Bytes;
  twapMaxTradeSize: BigNumber;
  incentivizedTwapMaxTradeSize: BigNumber;
}

export interface PerpV2BasisIncentiveSettings {
  incentivizedTwapCooldownPeriod: BigNumber;
  incentivizedSlippageTolerance: BigNumber;
  etherReward: BigNumber;
  incentivizedLeverageRatio: BigNumber;
}

export interface StreamingFeeState {
  feeRecipient: Address;
  streamingFeePercentage: BigNumber;
  maxStreamingFeePercentage: BigNumber;
  lastStreamingFeeTimestamp: BigNumber;
}