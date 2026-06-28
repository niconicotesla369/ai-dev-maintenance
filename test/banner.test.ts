import { describe, expect, test } from 'vitest';
import { bannerText, chooseBannerStyle, shouldShowBanner } from '../src/cli.js';

describe('CLI banner', () => {
  test('renders a wide hero banner when terminal width allows it', () => {
    const output = bannerText({ style: 'hero', color: false, columns: 100 });

    expect(output).toContain('AAAAA   III  DDDD   M   M');
    expect(output).toContain('AI Dev Maintenance');
    expect(output).not.toContain('\u001b[');
  });

  test('falls back to compact banner on narrow terminals', () => {
    expect(chooseBannerStyle({ requested: 'hero', columns: 71 })).toBe('compact');
    expect(chooseBannerStyle({ requested: 'hero', columns: 72 })).toBe('hero');
  });

  test('can render hero banner with minimal ANSI color', () => {
    const output = bannerText({ style: 'hero', color: true, columns: 100 });

    expect(output).toContain('\u001b[');
    expect(output).toContain('AI Dev Maintenance');
  });

  test('suppresses banner for plain, JSON, CI, NO_COLOR, no-banner flag, and non-TTY output', () => {
    expect(shouldShowBanner({ json: true, noBanner: false, ci: false, noColor: false, plain: false, isTty: true })).toBe(false);
    expect(shouldShowBanner({ json: false, noBanner: true, ci: false, noColor: false, plain: false, isTty: true })).toBe(false);
    expect(shouldShowBanner({ json: false, noBanner: false, ci: true, noColor: false, plain: false, isTty: true })).toBe(false);
    expect(shouldShowBanner({ json: false, noBanner: false, ci: false, noColor: true, plain: false, isTty: true })).toBe(false);
    expect(shouldShowBanner({ json: false, noBanner: false, ci: false, noColor: false, plain: true, isTty: true })).toBe(false);
    expect(shouldShowBanner({ json: false, noBanner: false, ci: false, noColor: false, plain: false, isTty: false })).toBe(false);
    expect(shouldShowBanner({ json: false, noBanner: false, ci: false, noColor: false, plain: false, isTty: true })).toBe(true);
  });
});
