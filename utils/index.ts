import { ethers } from "hardhat";
import { Blockchain } from "./common";

const provider = ethers.provider;
export const getBlockchainUtils = () => new Blockchain(provider);

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
  calculateNewLeverageRatio,
  calculateCollateralRebalanceUnits,
  calculateMaxBorrowForDelever,
  calculateMaxRedeemForDeleverToZero,
  calculateTotalRebalanceNotionalPerpV2,
  calculateNewLeverageRatioPerpV2
} from "./flexibleLeverageUtils";