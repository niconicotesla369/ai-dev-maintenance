import { formatBytes, row } from '../cli-render.js';
import type { PressureProcess, PressureReport } from './types.js';

export function renderPressureReport(report: PressureReport): string {
  const lines = [
    row('Live pressure', report.status),
    row('Memory free', memoryFreeText(report)),
    row('Pressure level', report.pressureLevel.overall),
    row('Disk used', report.disk.capacityPercent === undefined ? 'unknown' : `${report.disk.capacityPercent}%`),
    row('AI CPU', `${report.totals.aiCpuPercent.toFixed(1)}%`),
    row('AI RSS', formatBytes(report.totals.aiRssBytes)),
    row('Processes', String(report.totals.processCount))
  ];

  for (const warning of report.warnings) lines.push(row('Warning', warning));
  for (const reason of report.pressureLevel.reasons.slice(0, 3)) lines.push(row('Reason', reason));

  const topCpu = [...report.processes].sort((a, b) => b.cpuPercent - a.cpuPercent).slice(0, 5);
  if (topCpu.length > 0) {
    lines.push('', row('Top CPU', ''));
    for (const process of topCpu) lines.push(processRow(process, 'cpu'));
  }

  const topMem = [...report.processes].sort((a, b) => b.rssBytes - a.rssBytes).slice(0, 5);
  if (topMem.length > 0) {
    lines.push('', row('Top RAM', ''));
    for (const process of topMem) lines.push(processRow(process, 'rss'));
  }

  for (const action of report.nextActions) lines.push(row('Next', action));
  return `${lines.join('\n')}\n`;
}

function memoryFreeText(report: PressureReport): string {
  if (report.memory.freePercent !== undefined) return `${report.memory.freePercent}%`;
  if (report.memory.freeBytes !== undefined) return formatBytes(report.memory.freeBytes);
  return 'unknown';
}

function processRow(process: PressureProcess, mode: 'cpu' | 'rss'): string {
  const metric = mode === 'cpu'
    ? `${process.cpuPercent.toFixed(1)}%`
    : formatBytes(process.rssBytes);
  return row(process.displayName || process.provider, `${metric} ${process.category} pid=${process.pid}`);
}
