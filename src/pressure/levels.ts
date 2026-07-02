import type { PressureLevel } from './types.js';

export function cpuLevelForPercent(cpuPercent: number): PressureLevel {
  if (cpuPercent >= 80) return 'high';
  if (cpuPercent >= 30) return 'medium';
  return 'ok';
}
