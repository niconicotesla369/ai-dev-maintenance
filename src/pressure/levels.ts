import type { PressureLevel } from './types.js';

export function cpuLevelForPercent(cpuPercent: number): PressureLevel {
  if (cpuPercent >= 80) return 'high';
  if (cpuPercent >= 30) return 'medium';
  return 'ok';
}

export function cpuLevelForCapacityPercent(cpuCapacityPercent: number): PressureLevel {
  if (cpuCapacityPercent >= 50) return 'high';
  if (cpuCapacityPercent >= 25) return 'medium';
  return 'ok';
}

export function diskLevelForCapacityPercent(
  capacityPercent: number | undefined
): PressureLevel | 'unknown' {
  if (capacityPercent === undefined) return 'unknown';
  if (capacityPercent >= 90) return 'high';
  if (capacityPercent >= 80) return 'medium';
  return 'ok';
}
