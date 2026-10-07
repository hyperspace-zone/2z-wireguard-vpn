import type { PublicTradingLatencyResponse } from "@hyperspace-zone/contracts";

/** Pure, bounded selection over one snapshot. Unknown target retains the
 * existing first-target fallback; query variants never create cache entries.
 */
export function selectPublicTradingLatency(data: PublicTradingLatencyResponse, category?: string, targetKey?: string): PublicTradingLatencyResponse {
  const targets = data.targets.filter(target => !category || target.category === category);
  const ids = new Set(targets.map(target => target.id));
  const selected = targetKey ? [...targets].sort((a, b) => Number(b.key === targetKey) - Number(a.key === targetKey)
    || a.sortOrder - b.sortOrder || a.key.localeCompare(b.key))[0]?.id : undefined;
  return { ...data, targets, measurements: data.measurements.filter(value => ids.has(value.targetId) && (!targetKey || value.targetId === selected)) };
}
