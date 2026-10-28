import type { TradingSettings } from '@workspace/api-client-react';

export function effectiveTradingRules(settings: TradingSettings, equityUsd?: number) {
  const crazy = settings.riskMode === 'crazy';
  const positionPercent = crazy ? settings.normalEquityPct ?? 8 : null;
  const liquidityUsd = crazy ? Math.max(settings.pumpHuntEnabled ? 600 : 1000, settings.crazyMinLiquidityUsd ?? 1000) : settings.minLiquidityUsd;
  const volumeUsd = crazy ? settings.crazyMinVolumeUsd ?? 0 : settings.minVolumeUsd;
  const projectedPositionUsd = crazy
    ? equityUsd !== undefined && Number.isFinite(equityUsd) && equityUsd > 0 &&
      Number.isFinite(positionPercent) && positionPercent! > 0 && positionPercent! <= 15
      ? Math.floor(equityUsd * positionPercent! / 100 * 100) / 100 : null
    : settings.positionSizeUsd;
  return { crazy, liquidityUsd, volumeUsd, positionPercent, projectedPositionUsd,
    fixedPositionUsd: crazy ? null : settings.positionSizeUsd,
    scanMinutes: crazy ? 2 : settings.scanIntervalMinutes };
}
