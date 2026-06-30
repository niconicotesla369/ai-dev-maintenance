export type Tone = 'default' | 'muted' | 'info' | 'success' | 'warning' | 'danger' | 'accent';

export type ColorOptions = {
  color?: boolean;
};

export type BoxOptions = ColorOptions & {
  width: number;
  tone?: Tone;
};

export type MeterOptions = ColorOptions & {
  tone?: Tone;
};

const ANSI_RE = /\u001b\[[0-9;]*m/g;

const COLORS: Record<Tone, string> = {
  default: '',
  muted: '\u001b[2m',
  info: '\u001b[36m',
  success: '\u001b[32m',
  warning: '\u001b[33m',
  danger: '\u001b[31m',
  accent: '\u001b[35m'
};

export function stripAnsi(value: string): string {
  return value.replace(ANSI_RE, '');
}

export function visibleLength(value: string): number {
  return [...stripAnsi(value)].length;
}

export function colorize(value: string, tone: Tone, enabled = true): string {
  if (!enabled || tone === 'default') return value;
  return `${COLORS[tone]}${value}\u001b[0m`;
}

export function padVisible(value: string, width: number): string {
  const padding = Math.max(0, width - visibleLength(value));
  return `${value}${' '.repeat(padding)}`;
}

export function truncateVisible(value: string, width: number): string {
  if (visibleLength(value) <= width) return value;
  if (width <= 1) return '…'.slice(0, width);
  return `${[...stripAnsi(value)].slice(0, width - 1).join('')}…`;
}

export function wrapText(value: string, width: number): string[] {
  const normalized = stripAnsi(value).replace(/\s+/g, ' ').trim();
  if (normalized.length === 0) return [''];
  if (width <= 0) return [''];

  const lines: string[] = [];
  let current = '';
  for (const word of normalized.split(' ')) {
    if (visibleLength(word) > width) {
      if (current) {
        lines.push(current);
        current = '';
      }
      for (let index = 0; index < word.length; index += width) {
        lines.push(word.slice(index, index + width));
      }
      continue;
    }
    const next = current ? `${current} ${word}` : word;
    if (visibleLength(next) > width) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
  }
  if (current) lines.push(current);
  return lines;
}

export function box(title: string, lines: string[], options: BoxOptions): string {
  const width = Math.max(12, options.width);
  const innerWidth = width - 4;
  const titleText = title ? ` ${title} ` : '';
  const coloredTitle = colorize(titleText, options.tone ?? 'info', options.color);
  const topFill = Math.max(0, width - 3 - visibleLength(titleText));
  const output = [
    `╭─${coloredTitle}${'─'.repeat(topFill)}╮`
  ];

  for (const line of lines) {
    for (const wrapped of wrapPreservingBlank(line, innerWidth)) {
      output.push(`│ ${padVisible(wrapped, innerWidth)} │`);
    }
  }

  output.push(`╰${'─'.repeat(width - 2)}╯`);
  return `${output.join('\n')}\n`;
}

export function meter(value: number, max: number, width: number, options: MeterOptions = {}): string {
  const safeMax = Number.isFinite(max) && max > 0 ? max : 1;
  const safeValue = Number.isFinite(value) ? Math.max(0, Math.min(value, safeMax)) : 0;
  const filled = Math.round((safeValue / safeMax) * width);
  const output = `${'▰'.repeat(filled)}${'▱'.repeat(Math.max(0, width - filled))}`;
  return colorize(output, options.tone ?? 'info', options.color);
}

export function twoColumns(left: string, right: string, gap = 2): string {
  const leftLines = left.trimEnd().split('\n');
  const rightLines = right.trimEnd().split('\n');
  const leftWidth = Math.max(...leftLines.map(visibleLength), 0);
  const height = Math.max(leftLines.length, rightLines.length);
  const rows: string[] = [];
  for (let index = 0; index < height; index += 1) {
    const leftLine = leftLines[index] ?? '';
    const rightLine = rightLines[index] ?? '';
    rows.push(`${padVisible(leftLine, leftWidth)}${' '.repeat(gap)}${rightLine}`);
  }
  return `${rows.join('\n')}\n`;
}

export function shouldPrettyPrint(options: {
  json?: boolean;
  plain?: boolean;
  ci?: boolean;
  noColor?: boolean;
  isTty?: boolean;
  columns?: number;
  minColumns?: number;
}): boolean {
  return (
    options.json !== true &&
    options.plain !== true &&
    options.ci !== true &&
    options.noColor !== true &&
    options.isTty === true &&
    (options.columns ?? 80) >= (options.minColumns ?? 80)
  );
}

function wrapPreservingBlank(value: string, width: number): string[] {
  if (value.trim() === '') return [''];
  if (visibleLength(value) <= width) return [value];
  return wrapText(value, width);
}
