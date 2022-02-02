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

export interface PerpV2ContractSettings {
  setToken: Address;
  perpV2LeverageModule: Address;
  perpV2AccountBalance: Address;
  baseUSDPriceOracle: Address;
  twapInterval: BigNumber;
  basePriceDecimalAdjustment: BigNumber;
  virtualBaseAddress: Address;
  virtualQuoteAddress: Address;
}

export interface PerpV2MethodologySettings {
  targetLeverageRatio: BigNumber;
  minLeverageRatio: BigNumber;
  maxLeverageRatio: BigNumber;
  recenteringSpeed: BigNumber;
  rebalanceInterval: BigNumber;
}

export interface PerpV2ExecutionSettings {
  twapCooldownPeriod: BigNumber;
  slippageTolerance: BigNumber;
}

export interface PerpV2ExchangeSettings {
  twapMaxTradeSize: BigNumber;
  incentivizedTwapMaxTradeSize: BigNumber;
}

export interface PerpV2IncentiveSettings {
  incentivizedTwapCooldownPeriod: BigNumber;
  incentivizedSlippageTolerance: BigNumber;
  etherReward: BigNumber;
  incentivizedLeverageRatio: BigNumber;
}