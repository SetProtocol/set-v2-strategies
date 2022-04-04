import { BigNumber } from "@ethersproject/bignumber";
import { PerpV2BaseToken, SetToken } from "@setprotocol/set-protocol-v2/typechain";
import { PerpV2Fixture } from "@setprotocol/set-protocol-v2/dist/utils/fixtures";
import { ether, preciseMul, preciseDiv } from "../common";

export function calculateNewLeverageRatio(
  currentLeverageRatio: BigNumber,
  targetLeverageRatio: BigNumber,
  minLeverageRatio: BigNumber,
  maxLeverageRatio: BigNumber,
  recenteringSpeed: BigNumber
): BigNumber {
  const a = preciseMul(targetLeverageRatio, recenteringSpeed);
  const b = preciseMul(ether(1).sub(recenteringSpeed), currentLeverageRatio);
  const c = a.add(b);
  const d = c.lt(maxLeverageRatio) ? c : maxLeverageRatio;
  return minLeverageRatio.gte(d) ? minLeverageRatio : d;
}


export function calculateNewLeverageRatioPerpV2(
  currentLeverageRatio: BigNumber,
  targetLeverageRatio: BigNumber,
  minLeverageRatio: BigNumber,
  maxLeverageRatio: BigNumber,
  recenteringSpeed: BigNumber
): BigNumber {
  const a = preciseMul(targetLeverageRatio.abs(), recenteringSpeed);
  const b = preciseMul(ether(1).sub(recenteringSpeed), currentLeverageRatio.abs());
  const c = a.add(b);
  const d = c.lt(maxLeverageRatio.abs()) ? c : maxLeverageRatio.abs();
  const nlr = minLeverageRatio.abs().gte(d) ? minLeverageRatio.abs() : d;
  return currentLeverageRatio.gt(0) ? nlr : nlr.mul(-1);
}

export function calculateNewLeverageRatioPerpV2Basis(
  currentLeverageRatio: BigNumber,
  methodology: {
    targetLeverageRatio: BigNumber;
    minLeverageRatio: BigNumber;
    maxLeverageRatio: BigNumber;
    recenteringSpeed: BigNumber;
  }
): BigNumber {
  const a = preciseMul(methodology.targetLeverageRatio.abs(), methodology.recenteringSpeed);
  const b = preciseMul(ether(1).sub(methodology.recenteringSpeed), currentLeverageRatio.abs());
  const c = a.add(b);
  const d = c.lt(methodology.maxLeverageRatio.abs()) ? c : methodology.maxLeverageRatio.abs();
  const nlr = methodology.minLeverageRatio.abs().gte(d) ? methodology.minLeverageRatio.abs() : d;
  return currentLeverageRatio.gt(0) ? nlr : nlr.mul(-1);
}

export function calculateCollateralRebalanceUnits(
  currentLeverageRatio: BigNumber,
  newLeverageRatio: BigNumber,
  collateralBalance: BigNumber,
  totalSupply: BigNumber
): BigNumber {
  const a = currentLeverageRatio.gt(newLeverageRatio) ? currentLeverageRatio.sub(newLeverageRatio) : newLeverageRatio.sub(currentLeverageRatio);
  const b = preciseDiv(a, currentLeverageRatio);
  const c = preciseMul(b, collateralBalance);

  return preciseDiv(c, totalSupply);
}

// export async function calculateTotalRebalanceNotionalCompound(
//   setToken: SetToken,
//   cEther: CEther,
//   currentLeverageRatio: BigNumber,
//   newLeverageRatio: BigNumber
// ): Promise<BigNumber> {

//   const collateralCTokenExchangeRate = await cEther.exchangeRateStored();
//   const collateralCTokenBalance = await cEther.balanceOf(setToken.address);
//   const collateralBalance = preciseMul(collateralCTokenBalance, collateralCTokenExchangeRate);
//   const a = currentLeverageRatio.gt(newLeverageRatio) ? currentLeverageRatio.sub(newLeverageRatio) : newLeverageRatio.sub(currentLeverageRatio);
//   const b = preciseDiv(a, currentLeverageRatio);
//   return preciseMul(b, collateralBalance);
// }

// export async function calculateTotalRebalanceNotionalAave(
//   setToken: SetToken,
//   aToken: AaveV2AToken,
//   currentLeverageRatio: BigNumber,
//   newLeverageRatio: BigNumber
// ): Promise<BigNumber> {

//   const collateralBalance = await aToken.balanceOf(setToken.address);
//   const a = currentLeverageRatio.gt(newLeverageRatio) ? currentLeverageRatio.sub(newLeverageRatio) : newLeverageRatio.sub(currentLeverageRatio);
//   const b = preciseDiv(a, currentLeverageRatio);
//   return preciseMul(b, collateralBalance);
// }

export async function calculateTotalRebalanceNotionalPerpV2(
  setToken: SetToken,
  baseToken: PerpV2BaseToken,
  currentLeverageRatio: BigNumber,
  newLeverageRatio: BigNumber,
  perpV2Setup: PerpV2Fixture
): Promise<BigNumber> {
  const baseBalance = await perpV2Setup.accountBalance.getBase(setToken.address, baseToken.address);
  const a = newLeverageRatio.sub(currentLeverageRatio);
  const b = preciseDiv(a, currentLeverageRatio);
  return preciseMul(b, baseBalance);
}

export function calculateMaxBorrowForDelever(
  collateralBalance: BigNumber,
  collateralFactor: BigNumber,
  unutilizedLeveragePercentage: BigNumber,
  collateralPrice: BigNumber,
  borrowPrice: BigNumber,
  borrowBalance: BigNumber,
): BigNumber {
  const collateralValue = preciseMul(collateralBalance, collateralPrice);
  const borrowValue = preciseMul(borrowBalance, borrowPrice);
  const netBorrowLimit = preciseMul(
    preciseMul(collateralValue, collateralFactor),
    ether(1).sub(unutilizedLeveragePercentage)
  );
  const a = preciseMul(collateralBalance, netBorrowLimit.sub(borrowValue));

  return preciseDiv(a, netBorrowLimit);
}

export function calculateMaxRedeemForDeleverToZero(
  currentLeverageRatio: BigNumber,
  newLeverageRatio: BigNumber,
  collateralBalance: BigNumber,
  totalSupply: BigNumber,
  slippageTolerance: BigNumber
): BigNumber {
  const a = currentLeverageRatio.gt(newLeverageRatio) ? currentLeverageRatio.sub(newLeverageRatio) : newLeverageRatio.sub(currentLeverageRatio);
  const b = preciseDiv(a, currentLeverageRatio);
  const rebalanceNotional = preciseMul(b, collateralBalance);
  const notionalRedeemQuantity = preciseMul(rebalanceNotional, ether(1).add(slippageTolerance));

  return preciseDiv(notionalRedeemQuantity, totalSupply);
}
