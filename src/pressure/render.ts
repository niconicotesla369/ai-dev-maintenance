import { formatBytes, row } from '../cli-render.js';
import { box, colorize, meter, padVisible, truncateVisible, twoColumns } from '../ui/components.js';
import type { PressureLevel, PressureProcess, PressureReport } from './types.js';

export type PressureRenderOptions = {
  pretty?: boolean;
  color?: boolean;
  columns?: number;
};

export function renderPressureReport(report: PressureReport, options: PressureRenderOptions = {}): string {
  if (options.pretty === true && (options.columns ?? 80) >= 80) {
    return renderPrettyPressureReport(report, options);
  }
  return renderSimplePressureReport(report);
}

function renderSimplePressureReport(report: PressureReport): string {
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

function renderPrettyPressureReport(report: PressureReport, options: PressureRenderOptions): string {
  const columns = Math.max(80, Math.min(options.columns ?? 100, 118));
  const color = options.color === true;
  const captured = capturedTime(report.generatedAt);
  const heading = box('AIDM SYSTEM PULSE', [
    `${statusIcon(report.status)} Live pressure: ${statusText(report.status)}${captured ? `    Captured ${captured}` : ''}`,
    '',
    metricLine('Memory free', memoryFreeText(report), memoryLabel(report), memoryMeterValue(report), 100, report.pressureLevel.memory, color),
    metricLine('Disk used', diskText(report), diskLabel(report), report.disk.capacityPercent ?? 0, 100, report.pressureLevel.disk, color),
    metricLine('AI CPU', `${report.totals.aiCpuPercent.toFixed(1)}%`, cpuLabel(report.pressureLevel.cpu), report.totals.aiCpuPercent, 100, report.pressureLevel.cpu, color),
    metricLine('AI RSS', formatBytes(report.totals.aiRssBytes), rssLabel(report.totals.aiRssBytes), report.totals.aiRssBytes, 2 * 1024 * 1024 * 1024, rssTone(report.totals.aiRssBytes), color),
    metricLine('Processes', String(report.totals.processCount), processLabel(report.totals.processCount), report.totals.processCount, 50, processTone(report.totals.processCount), color)
  ], { width: columns, color, tone: toneForLevel(report.pressureLevel.overall) });

  const topCpu = [...report.processes].sort((a, b) => b.cpuPercent - a.cpuPercent).slice(0, 5);
  const topMem = [...report.processes].sort((a, b) => b.rssBytes - a.rssBytes).slice(0, 5);
  const panels = processPanels(topCpu, topMem, columns, color);
  const warnings = report.warnings.map((warning) => `! ${warning}`);
  const reasons = report.pressureLevel.reasons.slice(0, 3).map((reason) => `Reason: ${reason}`);
  const next = box('What should I do next?', [
    ...warnings,
    ...reasons,
    ...report.nextActions.map((action, index) => `${index + 1}. ${action}`)
  ], { width: columns, color, tone: report.pressureLevel.overall === 'high' ? 'warning' : 'info' });

  return `${heading}\n${panels}\n${next}`;
}

function memoryFreeText(report: PressureReport): string {
  if (report.memory.freePercent !== undefined) return `${report.memory.freePercent}%`;
  if (report.memory.freeBytes !== undefined) return formatBytes(report.memory.freeBytes);
  return 'unknown';
}

function diskText(report: PressureReport): string {
  return report.disk.capacityPercent === undefined ? 'unknown' : `${report.disk.capacityPercent}%`;
}

function processRow(process: PressureProcess, mode: 'cpu' | 'rss'): string {
  const metric = mode === 'cpu'
    ? `${process.cpuPercent.toFixed(1)}%`
    : formatBytes(process.rssBytes);
  return row(process.displayName || process.provider, `${metric} ${process.category} pid=${process.pid}`);
}

function metricLine(
  label: string,
  value: string,
  state: string,
  meterValue: number,
  meterMax: number,
  level: PressureLevel,
  color: boolean
): string {
  const tone = toneForLevel(level);
  return [
    padVisible(label, 14),
    padVisible(value, 12),
    padVisible(colorize(state, tone, color), 8),
    meter(meterValue, meterMax, 22, { color, tone })
  ].join('  ');
}

function processPanels(topCpu: PressureProcess[], topMem: PressureProcess[], columns: number, color: boolean): string {
  const panelGap = 2;
  if (columns >= 110) {
    const panelWidth = Math.floor((columns - panelGap) / 2);
    return twoColumns(
      box('What is using CPU?', processLines(topCpu, 'cpu', color), { width: panelWidth, color, tone: 'info' }),
      box('What is using RAM?', processLines(topMem, 'rss', color), { width: columns - panelGap - panelWidth, color, tone: 'info' }),
      panelGap
    );
  }
  return [
    box('What is using CPU?', processLines(topCpu, 'cpu', color), { width: columns, color, tone: 'info' }),
    box('What is using RAM?', processLines(topMem, 'rss', color), { width: columns, color, tone: 'info' })
  ].join('\n');
}

function processLines(processes: PressureProcess[], mode: 'cpu' | 'rss', color: boolean): string[] {
  if (processes.length === 0) return ['No matching processes detected.'];
  return processes.map((process, index) => {
    const nameTone = process.provider === 'codex' ? 'accent' : process.category === 'system' ? 'muted' : 'default';
    const name = colorize(truncateVisible(process.displayName || process.provider, 18), nameTone, color);
    const metric = mode === 'cpu' ? `${process.cpuPercent.toFixed(1)}%` : formatBytes(process.rssBytes);
    return [
      String(index + 1).padStart(2, ' '),
      padVisible(name, 18),
      padVisible(metric, 10),
      padVisible(process.category, 14),
      `pid ${process.pid}`
    ].join('  ');
  });
}

function memoryLabel(report: PressureReport): string {
  if (report.memory.freePercent === undefined && report.memory.freeBytes === undefined) return 'UNKNOWN';
  if (report.pressureLevel.memory === 'high') return 'TIGHT';
  if (report.pressureLevel.memory === 'medium') return 'LOW';
  return 'OK';
}

function diskLabel(report: PressureReport): string {
  if (report.disk.capacityPercent === undefined) return 'UNKNOWN';
  if (report.pressureLevel.disk === 'high') return 'HIGH';
  if (report.pressureLevel.disk === 'medium') return 'ELEVATED';
  return 'OK';
}

function cpuLabel(level: PressureLevel): string {
  if (level === 'high') return 'HEAVY';
  if (level === 'medium') return 'BUSY';
  return 'OK';
}

function rssLabel(bytes: number): string {
  if (bytes >= 2 * 1024 * 1024 * 1024) return 'HEAVY';
  if (bytes >= 1 * 1024 * 1024 * 1024) return 'BUSY';
  return 'OK';
}

function processLabel(count: number): string {
  if (count >= 50) return 'MANY';
  if (count >= 25) return 'BUSY';
  return 'OK';
}

function memoryMeterValue(report: PressureReport): number {
  if (report.memory.freePercent !== undefined) return report.memory.freePercent;
  if (report.memory.freeBytes !== undefined) return Math.min(100, (report.memory.freeBytes / (4 * 1024 * 1024 * 1024)) * 100);
  return 0;
}

function rssTone(bytes: number): PressureLevel {
  if (bytes >= 2 * 1024 * 1024 * 1024) return 'high';
  if (bytes >= 1 * 1024 * 1024 * 1024) return 'medium';
  return 'ok';
}

function processTone(count: number): PressureLevel {
  if (count >= 50) return 'high';
  if (count >= 25) return 'medium';
  return 'ok';
}

function toneForLevel(level: PressureLevel): 'success' | 'warning' | 'danger' | 'info' {
  if (level === 'high') return 'danger';
  if (level === 'medium') return 'warning';
  return 'success';
}

function statusIcon(status: PressureReport['status']): string {
  return status === 'ok' ? '✓' : '!';
}

function statusText(status: PressureReport['status']): string {
  return status.toUpperCase();
}

function capturedTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString().slice(11, 16);
}
