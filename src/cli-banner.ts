export type BannerOptions = {
  json: boolean;
  noBanner: boolean;
  ci: boolean;
  noColor: boolean;
  plain?: boolean;
  isTty: boolean;
};

export type BannerStyle = 'compact' | 'hero' | 'none';

export type BannerTextOptions = {
  style?: BannerStyle;
  color?: boolean;
  columns?: number;
};

const HERO_LINES = [
  '    AAAAA   III  DDDD   M   M',
  '    A   A    I   D   D  MM MM',
  '    AAAAA    I   D   D  M M M',
  '    A   A    I   D   D  M   M',
  '    A   A   III  DDDD   M   M',
  '      AI Dev Maintenance'
];

const COMPACT_LINES = ['AI DEV MAINTENANCE', 'Codex log doctor'];

export function bannerText(options: BannerTextOptions = {}): string {
  const style = chooseBannerStyle({ requested: options.style ?? 'compact', columns: options.columns });
  if (style === 'none') return '';
  const lines = style === 'hero' ? HERO_LINES : COMPACT_LINES;
  const output = lines.join('\n');
  return `${options.color ? colorize(output) : output}\n`;
}

export function chooseBannerStyle(options: { requested: BannerStyle; columns?: number }): BannerStyle {
  if (options.requested !== 'hero') return options.requested;
  return (options.columns ?? 80) >= 72 ? 'hero' : 'compact';
}

export function shouldShowBanner(options: BannerOptions): boolean {
  return !options.json && !options.noBanner && !options.ci && !options.noColor && options.plain !== true && options.isTty;
}

function colorize(output: string): string {
  return `\u001b[36m${output}\u001b[0m`;
}
