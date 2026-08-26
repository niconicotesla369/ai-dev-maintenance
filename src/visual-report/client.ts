export type VisualReportClientConfig = {
  copy: Record<'en' | 'ja', Record<string, string>> | null;
  token: string | null;
  expiresAtEpochMs: number;
};

export function renderVisualReportClient(config: VisualReportClientConfig): string {
  return `(${visualReportClient.toString()})(${safeJson(config)});`;
}

function safeJson(value: unknown): string {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (character) => {
    if (character === '<') return '\\u003c';
    if (character === '>') return '\\u003e';
    if (character === '&') return '\\u0026';
    if (character === '\u2028') return '\\u2028';
    return '\\u2029';
  });
}

function visualReportClient(config: VisualReportClientConfig): void {
  type Locale = 'en' | 'ja';

  const localeTags: Record<Locale, string> = { en: 'en-US', ja: 'ja-JP' };
  const storageFailureCopy: Record<Locale, string> = {
    en: 'Language preference could not be saved for this tab.',
    ja: 'このタブの言語設定を保存できませんでした。'
  };
  const planCopyKeys: Record<string, string> = {
    'cursor-clean': 'planCursorClean',
    'codex-fix': 'planCodexFix',
    'codex-sparkle-clean': 'planCodexSparkle'
  };
  const scriptElement = document.currentScript;
  let copyByLocale = config.copy;
  let heartbeatPath: string | null = config.token === null ? null : `/${config.token}/heartbeat`;
  let closePath: string | null = config.token === null ? null : `/${config.token}/close`;
  let storageUnavailable = false;
  let locale: Locale = initialLocale();
  let ended = false;
  let heartbeatPending = false;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;

  function copy(): Record<string, string> {
    return copyByLocale?.[locale] ?? {};
  }

  function initialLocale(): Locale {
    try {
      const stored = sessionStorage.getItem('aidm-report-locale');
      if (stored === 'ja' || stored === 'en') return stored;
    } catch {
      storageUnavailable = true;
    }
    const preferred = Array.isArray(navigator.languages) ? navigator.languages[0] : undefined;
    return typeof preferred === 'string' && preferred.toLowerCase().startsWith('ja') ? 'ja' : 'en';
  }

  function element(id: string): HTMLElement | null {
    return document.getElementById(id);
  }

  function formatBytes(raw: string | undefined): string {
    const bytes = raw === undefined ? Number.NaN : Number(raw);
    if (!Number.isSafeInteger(bytes) || bytes < 0) return copy().unknown ?? 'Unknown';
    const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
    let value = bytes;
    let unitIndex = 0;
    while (value >= 1024 && unitIndex < units.length - 1) {
      value /= 1024;
      unitIndex += 1;
    }
    const formatter = new Intl.NumberFormat(localeTags[locale], {
      minimumFractionDigits: unitIndex >= 3 ? 1 : 0,
      maximumFractionDigits: unitIndex >= 3 ? 1 : 0
    });
    return `${formatter.format(value)} ${units[unitIndex]}`;
  }

  function template(key: string, bytes: string | undefined): string {
    const source = copy()[key] ?? '';
    return source.replace('{bytes}', formatBytes(bytes));
  }

  function applyLocale(nextLocale: Locale, persist: boolean): void {
    locale = nextLocale;
    document.documentElement.lang = locale;
    document.title = `AIDM · ${copy().readOnly ?? ''}`;
    element('language-ja')?.setAttribute('aria-pressed', String(locale === 'ja'));
    element('language-en')?.setAttribute('aria-pressed', String(locale === 'en'));

    for (const candidate of document.querySelectorAll<HTMLElement>('[data-copy]')) {
      const key = candidate.dataset.copy;
      if (key !== undefined && copy()[key] !== undefined) candidate.textContent = copy()[key]!;
    }
    for (const candidate of document.querySelectorAll<HTMLElement>('[data-bytes]')) {
      candidate.textContent = formatBytes(candidate.dataset.bytes);
    }

    const opportunity = element('found-opportunity');
    if (opportunity) opportunity.textContent = template('foundOpportunity', opportunity.dataset.bytes);
    const freeSpace = element('free-space');
    if (freeSpace) freeSpace.textContent = template('freeSpace', freeSpace.dataset.bytes);
    const diskPressure = element('disk-pressure-value');
    const diskLevel = diskPressure?.dataset.level;
    if (diskPressure) {
      const key = diskLevel === 'ok'
        ? 'diskOk'
        : diskLevel === 'medium'
          ? 'diskMedium'
          : diskLevel === 'high'
            ? 'diskHigh'
            : 'unknown';
      diskPressure.textContent = copy()[key] ?? '';
    }
    const gauge = element('disk-gauge');
    if (gauge) {
      gauge.setAttribute(
        'aria-label',
        `${copy().diskPressure ?? ''}: ${diskPressure?.textContent ?? copy().unknown ?? ''}; ${freeSpace?.textContent ?? copy().unknown ?? ''}`
      );
    }
    const reportTime = element('report-time');
    const timestamp = reportTime?.dataset.timestamp;
    if (reportTime && timestamp) {
      const parsed = new Date(timestamp);
      if (Number.isFinite(parsed.getTime())) {
        reportTime.textContent = new Intl.DateTimeFormat(localeTags[locale], {
          year: 'numeric',
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit'
        }).format(parsed);
      }
    }

    if (persist) {
      try {
        sessionStorage.setItem('aidm-report-locale', locale);
      } catch {
        storageUnavailable = true;
      }
    }
    const storageStatus = element('storage-status');
    if (storageStatus) storageStatus.textContent = storageUnavailable ? storageFailureCopy[locale] : '';
  }

  function openPlanReview(): void {
    if (ended) return;
    const details = element('safe-plan-details');
    const trigger = element('safe-plan-trigger');
    if (!details || !trigger) return;
    details.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    details.focus();
  }

  async function copyPlan(action: string | undefined): Promise<void> {
    if (ended || action === undefined) return;
    const copyKey = planCopyKeys[action];
    const command = copyKey === undefined ? undefined : copyByLocale?.en[copyKey];
    const sameJapaneseCommand = copyKey === undefined ? undefined : copyByLocale?.ja[copyKey];
    const status = element('copy-status');
    if (command === undefined || command !== sameJapaneseCommand || status === null) return;
    try {
      if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(command);
      status.textContent = copy().copied ?? '';
    } catch {
      status.textContent = copy().copyFailed ?? '';
    }
  }

  function onPagehide(): void {
    if (!ended && closePath !== null && typeof navigator.sendBeacon === 'function') {
      navigator.sendBeacon(closePath);
    }
  }

  function endSession(): void {
    if (ended) return;
    ended = true;
    if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer);
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
    window.removeEventListener('pagehide', onPagehide);

    const endedCopy = copy();
    const main = document.createElement('main');
    const heading = document.createElement('h1');
    const description = document.createElement('p');
    main.id = 'session-ended';
    main.className = 'session-ended';
    heading.textContent = endedCopy.sessionEnded ?? 'Report session ended';
    description.textContent = endedCopy.sessionEndedDescription ?? 'Run the command again to open a fresh report.';
    main.append(heading, description);
    document.body.replaceChildren(main);

    copyByLocale = null;
    heartbeatPath = null;
    closePath = null;
    config.copy = null;
    config.token = null;
    config.expiresAtEpochMs = 0;
    heartbeatTimer = undefined;
    deadlineTimer = undefined;
  }

  async function heartbeat(): Promise<void> {
    if (ended || heartbeatPending || heartbeatPath === null) return;
    heartbeatPending = true;
    try {
      const response = await fetch(heartbeatPath, {
        method: 'POST',
        body: null,
        cache: 'no-store',
        credentials: 'same-origin',
        keepalive: true,
        referrerPolicy: 'no-referrer'
      });
      if (!response.ok) endSession();
    } catch {
      endSession();
    } finally {
      heartbeatPending = false;
    }
  }

  element('language-ja')?.addEventListener('click', () => applyLocale('ja', true));
  element('language-en')?.addEventListener('click', () => applyLocale('en', true));
  element('safe-plan-trigger')?.addEventListener('click', openPlanReview);
  for (const button of document.querySelectorAll<HTMLElement>('[data-plan-copy]')) {
    button.addEventListener('click', () => void copyPlan(button.dataset.planCopy));
  }
  window.addEventListener('pagehide', onPagehide);

  applyLocale(locale, false);
  heartbeatTimer = setInterval(() => void heartbeat(), 15_000);
  deadlineTimer = setTimeout(endSession, Math.max(0, config.expiresAtEpochMs - Date.now()));
  scriptElement?.remove();
}
