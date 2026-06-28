export type BannerOptions = {
  json: boolean;
  noBanner: boolean;
  ci: boolean;
  noColor: boolean;
  isTty: boolean;
};

export function bannerText(): string {
  return ['AI DEV MAINTENANCE', 'Codex log doctor', ''].join('\n');
}

export function shouldShowBanner(options: BannerOptions): boolean {
  return !options.json && !options.noBanner && !options.ci && !options.noColor && options.isTty;
}
