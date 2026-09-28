import vm from 'node:vm';
import { describe, expect, test, vi } from 'vitest';
import { VISUAL_REPORT_COPY } from '../src/visual-report/locales.js';
import { renderVisualReportHtml } from '../src/visual-report/render.js';
import type { VisualReportModel } from '../src/visual-report/model.js';

const GIB = 1024 ** 3;
const TOKEN = 'A'.repeat(43);
const NONCE = 'B'.repeat(43);
const CSS_MEDIA = ['@', 'media'].join('');

describe('visual report renderer', () => {
  test('renders the selected self-contained light-console hierarchy', () => {
    const html = renderVisualReportHtml(reportModel(), renderOptions());

    expect(html.match(/<!doctype html>/gi)).toHaveLength(1);
    expect(html).toContain('id="report-root"');
    expect(html).toContain('id="language-ja"');
    expect(html).toContain('id="language-en"');
    expect(html).toContain('aria-pressed');
    expect(html).toContain('id="read-only-badge"');
    expect(html).toContain('id="storage-health"');
    expect(html).toContain('id="disk-gauge"');
    expect(html).toContain('id="opportunity-band"');
    expect(html).toContain('id="category-safe"');
    expect(html).toContain('id="category-review"');
    expect(html).toContain('id="category-protected"');
    expect(html).toContain('id="provider-composition"');
    expect(html).toContain('id="privacy-proof"');
    expect(html).toContain('id="safe-plan-details"');
    expect(html).toMatch(/id="safe-plan-details"[^>]*hidden/);
    expect(html).toContain(`${CSS_MEDIA} (max-width: 959px)`);
    expect(html).toContain(`${CSS_MEDIA} (prefers-reduced-motion: reduce)`);
    expect(html).not.toMatch(/https?:\/\/|file:\/\/|localStorage|serviceWorker/);
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
    expect(html).not.toMatch(/\sstyle\s*=/i);
    expect(html.match(new RegExp(`<style nonce="${NONCE}">`, 'g'))).toHaveLength(1);
    expect(html.match(new RegExp(`<script nonce="${NONCE}">`, 'g'))).toHaveLength(1);
  });

  test('keeps the read-only plan review action inside the safe category card', () => {
    const html = renderVisualReportHtml(reportModel(), renderOptions());
    const safeCard = html.match(/<article id="category-safe"[\s\S]*?<\/article>/)?.[0];

    expect(safeCard).toContain('id="safe-plan-trigger"');
    expect(html.match(/id="safe-plan-trigger"/g)).toHaveLength(1);
  });

  test('renders truthful values and never infers session-image reclaimability', () => {
    const html = renderVisualReportHtml(reportModel(), renderOptions());

    expect(html).toContain('data-bytes="22870700851"');
    expect(html).toContain('data-bytes="37795712205"');
    expect(html).toContain('data-provider="codex"');
    expect(html).toContain('data-provider="cursor"');
    expect(html).toContain('data-provider="claude-code"');
    expect(html).toContain('data-provider="other"');
    expect(html).toContain('data-plan="cursor-clean"');
    expect(html).toContain('data-plan="codex-fix"');
    expect(html).toContain('data-plan="codex-sparkle-clean"');
    expect(html).not.toMatch(/Session images|セッション画像|image-prune/);
  });

  test('embeds complete English and Japanese controls with fixed commands', () => {
    const html = renderVisualReportHtml(reportModel(), renderOptions());

    expect(html).toContain('Your storage is critically low');
    expect(html).toContain('空き容量が危険水準です');
    expect(html).toContain('Review safe plan');
    expect(html).toContain('安全なプランを確認');
    expect(html).toContain('LOCAL ONLY / ローカルのみ');
    expect(html).toContain('NO HTML SAVED / HTML保存なし');
    expect(html).toContain('aidm plan cursor-clean --json');
    expect(html).toContain('aidm plan codex-fix --json');
    expect(html).toContain('aidm plan codex-sparkle-clean --json');
  });

  test('rejects unsafe render options without reflecting them', () => {
    const model = reportModel();
    const now = Date.now();

    expect(() => renderVisualReportHtml(model, { token: '</script>', nonce: NONCE, expiresAtEpochMs: now + 1_000 })).toThrow('invalid visual report token');
    expect(() => renderVisualReportHtml(model, { token: TOKEN, nonce: '" onload="alert(1)', expiresAtEpochMs: now + 1_000 })).toThrow('invalid visual report nonce');
    expect(() => renderVisualReportHtml(model, { token: TOKEN, nonce: NONCE, expiresAtEpochMs: Number.NaN })).toThrow('invalid visual report expiry');
    expect(() => renderVisualReportHtml(model, { token: TOKEN, nonce: NONCE, expiresAtEpochMs: now - 1 })).toThrow('invalid visual report expiry');
    expect(() => renderVisualReportHtml(model, { token: TOKEN, nonce: NONCE, expiresAtEpochMs: now + 30 * 60_000 + 1_000 })).toThrow('invalid visual report expiry');
  });

  test('fails closed when a test-only forged model carries executable strings', () => {
    const leak = ['', 'Users', 'alice', '<', '/script><script>LEAK_SENTINEL</script>'].join('/');
    const forged = {
      ...reportModel(),
      generatedAt: leak,
      reportStatus: leak,
      coverage: leak,
      providers: [{ id: leak, bytes: 1 }],
      availablePlans: [leak]
    } as unknown as VisualReportModel;

    const html = renderVisualReportHtml(forged, renderOptions());

    expect(html).not.toContain(leak);
    expect(html).not.toContain('LEAK_SENTINEL');
    expect(html).not.toMatch(/<script>LEAK/);
    expect(html).not.toMatch(/\/Users\/alice/);
    expect(html).not.toMatch(/https?:\/\/|file:\/\//);
  });

  test('escapes every script-sensitive JSON character before embedding fixed copy', () => {
    const mutableCopy = VISUAL_REPORT_COPY.en as unknown as Record<string, string>;
    const original = mutableCopy.lowStorage;
    const injected = '</script><script>LEAK&\u2028\u2029';
    try {
      mutableCopy.lowStorage = injected;
      const html = renderVisualReportHtml(reportModel(), renderOptions());
      const source = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)?.[1] ?? '';

      expect(source).not.toContain(injected);
      expect(source).not.toContain('</script><script>');
      expect(source).toContain('\\u003c/script\\u003e\\u003cscript\\u003eLEAK\\u0026\\u2028\\u2029');
    } finally {
      mutableCopy.lowStorage = original;
    }
  });

  test('expires into a fixed localized screen and removes report values and commands', () => {
    const runtime = runClient({ storedLocale: 'ja' });

    runtime.deadline();

    expect(runtime.document.body.textContent).toContain('レポートセッションは終了しました');
    expect(runtime.document.body.textContent).not.toContain('Codex');
    expect(runtime.document.body.textContent).not.toContain('35.2 GiB');
    expect(runtime.document.body.textContent).not.toContain('aidm plan');
    expect(runtime.document.body.children.some((node) => node.id === 'report-root')).toBe(false);
    expect(runtime.clearedIntervals).toContain(runtime.heartbeatId);
    expect(runtime.windowRemovedEvents).toContain('pagehide');
  });

  test('treats a failed heartbeat as confirmed session loss', async () => {
    const runtime = runClient({ fetchOk: false });

    await runtime.heartbeat();
    await Promise.resolve();

    expect(runtime.document.body.textContent).toContain('Report session ended');
    expect(runtime.document.body.textContent).not.toContain('Cursor');
    expect(runtime.document.body.textContent).not.toContain('aidm plan');
  });

  test('switches locale, opens the plan review, copies only an allowlisted command, and reports storage failure inline', async () => {
    const runtime = runClient({ storageThrows: true });

    runtime.node('language-ja').click();
    expect(runtime.document.documentElement.lang).toBe('ja');
    expect(runtime.node('language-ja').getAttribute('aria-pressed')).toBe('true');
    expect(runtime.node('storage-status').textContent).toMatch(/[ぁ-んァ-ヶ一-龠]/);

    runtime.node('safe-plan-trigger').click();
    expect(runtime.node('safe-plan-details').hidden).toBe(false);
    expect(runtime.node('safe-plan-details').focused).toBe(true);

    runtime.copyButton.click();
    await Promise.resolve();
    expect(runtime.clipboardWrites).toEqual(['aidm plan cursor-clean --json']);
  });

  test('omits the reclaim section when no run has been recorded', () => {
    expect(renderVisualReportHtml(reportModel(), renderOptions())).not.toContain('id="last-reclaim"');
  });

  test('renders the latest reclaim run as signed numbers and fixed labels only', () => {
    const html = renderVisualReportHtml({
      ...reportModel(),
      lastReclaim: {
        finishedAt: '2026-09-28T14:13:34.001Z',
        status: 'partial',
        items: [
          { action: 'codex-fix', outcome: 'ok', targetDeltaBytes: -53_624 },
          { action: 'cursor-clean', outcome: 'blocked', targetDeltaBytes: 0 }
        ],
        appliedTargetDeltaBytes: -53_624,
        managedStateDeltaBytes: 8_167_565,
        volumeDeltaBytes: null
      }
    }, renderOptions());

    expect(html).toContain('id="last-reclaim"');
    expect(html).toContain('data-reclaim-status="partial"');
    expect(html).toContain('data-copy="reclaimStatusPartial"');
    expect(html).toContain('data-reclaim-action="codex-fix" data-reclaim-outcome="ok"');
    expect(html).toContain('data-reclaim-action="cursor-clean" data-reclaim-outcome="blocked"');
    expect(html).toContain('data-delta="-53624">-<strong data-bytes="53624">');
    expect(html).toContain('data-delta="8167565">+<strong data-bytes="8167565">');
    expect(html).toMatch(/id="reclaim-volume-change">.*data-copy="notMeasurable"/);
    expect(html).toContain('data-copy="reclaimVolumeChange"');
    expect(html).toContain('not attributed to AIDM');
  });

  test('shows an unreadable or malformed reclaim run as unavailable instead of hiding it', () => {
    for (const lastReclaim of ['unavailable', { finishedAt: 'x', status: 'ok', items: [] }] as const) {
      const html = renderVisualReportHtml({ ...reportModel(), lastReclaim } as VisualReportModel, renderOptions());

      expect(html).toContain('id="last-reclaim"');
      expect(html).toContain('data-copy="lastReclaimUnavailable"');
      expect(html).not.toContain('id="reclaim-target-change"');
    }
  });

  test('provides Japanese copy for every reclaim label', () => {
    for (const key of Object.keys(VISUAL_REPORT_COPY.en).filter((name) => name.startsWith('reclaim') || name.startsWith('lastReclaim'))) {
      expect(VISUAL_REPORT_COPY.ja[key as keyof typeof VISUAL_REPORT_COPY.ja]).not.toBe('');
      expect(VISUAL_REPORT_COPY.ja[key as keyof typeof VISUAL_REPORT_COPY.ja]).not.toBe(VISUAL_REPORT_COPY.en[key as keyof typeof VISUAL_REPORT_COPY.en]);
    }
  });

  test('uses dedicated sentences for unmeasured sizes instead of splicing Unknown into a byte template', () => {
    const runtime = runClient({ unknownSizes: true, storedLocale: 'ja' });

    expect(runtime.node('found-opportunity').textContent).toBe(VISUAL_REPORT_COPY.ja.foundOpportunityUnknown);
    expect(runtime.node('free-space').textContent).toBe(VISUAL_REPORT_COPY.ja.freeSpaceUnknown);
    expect(runtime.node('found-opportunity').textContent).not.toContain('不明の回収候補');

    runtime.node('language-en').click();
    expect(runtime.node('free-space').textContent).toBe(VISUAL_REPORT_COPY.en.freeSpaceUnknown);
  });

  test('renders unmeasured sizes with the dedicated English sentences before the client runs', () => {
    const html = renderVisualReportHtml({
      ...reportModel(),
      coverage: 'unavailable',
      volume: { diskLevel: 'unknown' },
      totals: { trackedBytes: 0, safeBytes: 0, reviewBytes: 0, protectedBytes: 0 },
      providers: [],
      counts: { safe: 0, review: 0, protected: 0 },
      availablePlans: []
    }, renderOptions());

    expect(html).toContain(VISUAL_REPORT_COPY.en.foundOpportunityUnknown);
    expect(html).toContain(VISUAL_REPORT_COPY.en.freeSpaceUnknown);
  });

  test('localizes every timestamp, including the latest reclaim run', () => {
    const runtime = runClient({ storedLocale: 'ja', reclaimTime: '2026-09-28T21:40:18.297Z' });

    expect(runtime.node('reclaim-time').textContent).toMatch(/2026年/);
    expect(runtime.node('report-time').textContent).toMatch(/2026年/);
  });

  test('sends the exact same-origin close route on pagehide', () => {
    const runtime = runClient();

    runtime.pagehide();

    expect(runtime.beacons).toEqual([`/${TOKEN}/close`]);
  });
});

function reportModel(): VisualReportModel {
  const safeBytes = Math.round(7.7 * GIB);
  const reviewBytes = Math.round(13.6 * GIB);
  const trackedBytes = Math.round(35.2 * GIB);
  const protectedBytes = trackedBytes - safeBytes - reviewBytes;
  return {
    generatedAt: '2026-08-25T01:42:00.000Z',
    reportStatus: 'ok',
    coverage: 'complete',
    volume: {
      totalBytes: 250 * GIB,
      usedBytes: 246 * GIB,
      availableBytes: 4 * GIB,
      capacityPercent: 98.4,
      diskLevel: 'high'
    },
    totals: { trackedBytes, safeBytes, reviewBytes, protectedBytes },
    providers: [
      { id: 'codex', bytes: 28 * GIB },
      { id: 'cursor', bytes: 4 * GIB },
      { id: 'claude-code', bytes: 2 * GIB },
      { id: 'other', bytes: trackedBytes - 34 * GIB }
    ],
    counts: { safe: 2, review: 5, protected: 3 },
    availablePlans: ['cursor-clean', 'codex-fix', 'codex-sparkle-clean']
  };
}

function renderOptions() {
  return {
    token: TOKEN,
    nonce: NONCE,
    expiresAtEpochMs: Date.now() + 60_000
  };
}

type RuntimeOptions = {
  unknownSizes?: boolean;
  reclaimTime?: string;
  storedLocale?: string;
  fetchOk?: boolean;
  storageThrows?: boolean;
};

function runClient(options: RuntimeOptions = {}) {
  const html = renderVisualReportHtml(reportModel(), renderOptions());
  const source = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)?.[1];
  if (!source) throw new Error('client script missing');

  const document = new FakeDocument();
  document.mountReport();
  if (options.unknownSizes) document.mountUnknownSizes();
  if (options.reclaimTime) document.mountReclaimTime(options.reclaimTime);
  const intervals = new Map<number, () => void | Promise<void>>();
  const timeouts = new Map<number, () => void>();
  const clearedIntervals: number[] = [];
  const clearedTimeouts: number[] = [];
  const windowEvents = new Map<string, () => void>();
  const windowRemovedEvents: string[] = [];
  const clipboardWrites: string[] = [];
  const beacons: string[] = [];
  let nextTimerId = 1;

  const storage = {
    getItem: vi.fn(() => {
      if (options.storageThrows) throw new Error('storage unavailable');
      return options.storedLocale ?? null;
    }),
    setItem: vi.fn(() => {
      if (options.storageThrows) throw new Error('storage unavailable');
    })
  };

  vm.runInNewContext(source, {
    document,
    navigator: {
      languages: ['en-US'],
      clipboard: { writeText: async (value: string) => { clipboardWrites.push(value); } },
      sendBeacon: (value: string) => { beacons.push(value); return true; }
    },
    sessionStorage: storage,
    Intl,
    Date,
    Promise,
    fetch: async () => ({ ok: options.fetchOk ?? true }),
    setInterval: (callback: () => void | Promise<void>) => {
      const id = nextTimerId++;
      intervals.set(id, callback);
      return id;
    },
    clearInterval: (id: number) => { clearedIntervals.push(id); intervals.delete(id); },
    setTimeout: (callback: () => void) => {
      const id = nextTimerId++;
      timeouts.set(id, callback);
      return id;
    },
    clearTimeout: (id: number) => { clearedTimeouts.push(id); timeouts.delete(id); },
    window: {
      addEventListener: (name: string, callback: () => void) => { windowEvents.set(name, callback); },
      removeEventListener: (name: string) => { windowRemovedEvents.push(name); windowEvents.delete(name); }
    }
  });

  const heartbeatId = [...intervals.keys()][0]!;
  const deadlineId = [...timeouts.keys()][0]!;
  return {
    document,
    node: (id: string) => {
      const node = document.getElementById(id);
      if (!node) throw new Error(`missing fake node: ${id}`);
      return node;
    },
    copyButton: document.copyButton,
    heartbeatId,
    clearedIntervals,
    clearedTimeouts,
    windowRemovedEvents,
    clipboardWrites,
    beacons,
    heartbeat: async () => { await intervals.get(heartbeatId)?.(); },
    deadline: () => { timeouts.get(deadlineId)?.(); },
    pagehide: () => { windowEvents.get('pagehide')?.(); }
  };
}

type Listener = () => void | Promise<void>;

class FakeNode {
  id = '';
  hidden = false;
  focused = false;
  dataset: Record<string, string> = {};
  children: FakeNode[] = [];
  private ownText = '';
  private readonly attributes = new Map<string, string>();
  private readonly listeners = new Map<string, Listener[]>();

  constructor(readonly tagName: string) {}

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  get textContent(): string {
    return [this.ownText, ...this.children.map((child) => child.textContent)].join('');
  }

  set textContent(value: string) {
    this.ownText = value;
    this.children = [];
  }

  addEventListener(name: string, listener: Listener): void {
    const listeners = this.listeners.get(name) ?? [];
    listeners.push(listener);
    this.listeners.set(name, listeners);
  }

  append(...nodes: FakeNode[]): void {
    this.children.push(...nodes);
  }

  replaceChildren(...nodes: FakeNode[]): void {
    this.ownText = '';
    this.children = nodes;
  }

  focus(): void {
    this.focused = true;
  }

  click(): void {
    for (const listener of this.listeners.get('click') ?? []) void listener();
  }

  remove(): void {}
}

class FakeDocument {
  readonly documentElement = { lang: 'en' };
  readonly body = new FakeNode('body');
  private readonly nodes = new Map<string, FakeNode>();
  private readonly copyNodes: FakeNode[] = [];
  private readonly byteNodes: FakeNode[] = [];
  private readonly planButtons: FakeNode[] = [];
  readonly copyButton = this.node('button', 'copy-cursor');
  currentScript: FakeNode | null = new FakeNode('script');

  mountReport(): void {
    const root = this.node('main', 'report-root');
    root.textContent = 'Codex Cursor Claude Code 35.2 GiB aidm plan cursor-clean --json';
    this.body.children = [root];
    for (const id of [
      'language-ja',
      'language-en',
      'safe-plan-trigger',
      'safe-plan-details',
      'copy-status',
      'storage-status',
      'report-time',
      'found-opportunity',
      'free-space',
      'disk-pressure-value',
      'disk-gauge'
    ]) {
      this.node(id === 'safe-plan-details' ? 'section' : 'button', id);
    }
    this.getElementById('safe-plan-details')!.hidden = true;
    this.getElementById('report-time')!.dataset.timestamp = '2026-08-25T01:42:00.000Z';
    this.getElementById('found-opportunity')!.dataset.bytes = '22870700851';
    this.getElementById('free-space')!.dataset.bytes = String(4 * GIB);
    this.getElementById('disk-pressure-value')!.dataset.level = 'high';

    const localized = this.node('span', 'localized-label');
    localized.dataset.copy = 'reviewSafePlan';
    this.copyNodes.push(localized);

    const bytes = this.node('span', 'tracked-bytes');
    bytes.dataset.bytes = String(Math.round(35.2 * GIB));
    this.byteNodes.push(bytes);

    this.copyButton.dataset.planCopy = 'cursor-clean';
    this.planButtons.push(this.copyButton);
  }

  getElementById(id: string): FakeNode | null {
    return this.nodes.get(id) ?? null;
  }

  querySelectorAll(selector: string): FakeNode[] {
    if (selector === '[data-copy]') return this.copyNodes;
    if (selector === '[data-bytes]') return this.byteNodes;
    if (selector === '[data-plan-copy]') return this.planButtons;
    if (selector === '[data-timestamp]') return [...this.nodes.values()].filter((node) => node.dataset.timestamp !== undefined);
    return [];
  }

  mountUnknownSizes(): void {
    delete this.getElementById('found-opportunity')!.dataset.bytes;
    delete this.getElementById('free-space')!.dataset.bytes;
  }

  mountReclaimTime(timestamp: string): void {
    this.node('time', 'reclaim-time').dataset.timestamp = timestamp;
  }

  createElement(tagName: string): FakeNode {
    return new FakeNode(tagName);
  }

  private node(tagName: string, id: string): FakeNode {
    const node = new FakeNode(tagName);
    node.id = id;
    this.nodes.set(id, node);
    return node;
  }
}
