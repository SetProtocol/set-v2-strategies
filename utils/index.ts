import { ethers } from "hardhat";
import { Blockchain } from "./common";
import { Address } from "./types";

const provider = ethers.provider;
export const getBlockchainUtils = () => new Blockchain(provider);

import {
  AaveV2Fixture,
  CompoundFixture,
  SetFixture,
  UniswapFixture,
  UniswapV3Fixture
} from "./fixtures";

import {
  PerpV2Fixture
} from "@setprotocol/set-protocol-v2/utils/fixtures";

export const getSetFixture = (ownerAddress: Address) => new SetFixture(provider, ownerAddress);
export const getAaveV2Fixture = (ownerAddress: Address) => new AaveV2Fixture(provider, ownerAddress);
export const getCompoundFixture = (ownerAddress: Address) => new CompoundFixture(provider, ownerAddress);
export const getUniswapFixture = (ownerAddress: Address) => new UniswapFixture(provider, ownerAddress);
export const getUniswapV3Fixture = (ownerAddress: Address) => new UniswapV3Fixture(provider, ownerAddress);

export const getPerpV2Fixture = (ownerAddress: Address) => new PerpV2Fixture(provider, ownerAddress);

export {
  getAccounts,
  getEthBalance,
  getLastBlockTimestamp,
  getProvider,
  getTransactionTimestamp,
  getWaffleExpect,
  addSnapshotBeforeRestoreAfterEach,
  getRandomAccount,
  getRandomAddress,
  increaseTimeAsync,
  mineBlockAsync,
  cacheBeforeEach,
} from "./test";

export {
  bigNumberToData,
  bitcoin,
  divDown,
  ether,
  gWei,
  min,
  preciseDiv,
  preciseDivCeil,
  preciseMul,
  preciseMulCeil,
  preciseMulCeilInt,
  preciseDivCeilInt,
  sqrt,
  usdc,
  wbtc,
} from "./common";

export {
  setUniswapPoolToPrice
} from "./externalProtocolUtils";