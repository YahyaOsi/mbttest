import { TradingError } from "./store";

type LiquidityAllocation = {
  partnerPermanentLockedLiquidityPercentage: number;
  creatorPermanentLockedLiquidityPercentage: number;
  partnerLiquidityPercentage: number;
  creatorLiquidityPercentage: number;
};
export function assertDbcEntryLiquidity(config: LiquidityAllocation) {
  const parts = [config.partnerPermanentLockedLiquidityPercentage, config.creatorPermanentLockedLiquidityPercentage,
    config.partnerLiquidityPercentage, config.creatorLiquidityPercentage];
  if (parts.some(p => !Number.isInteger(p) || p < 0 || p > 100) ||
      parts[0] + parts[1] !== 100 || parts[2] + parts[3] !== 0) {
    throw new TradingError("DBC entry blocked: all migration liquidity must be independently verified as permanently locked; creator/partner withdrawable or unverifiable allocations are not accepted.");
  }
}
