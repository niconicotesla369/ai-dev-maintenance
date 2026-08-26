import { diskLevelForCapacityPercent } from '../pressure/levels.js';
import { renderVisualReportClient, type VisualReportClientConfig } from './client.js';
import { VISUAL_REPORT_COPY } from './locales.js';
import type {
  VisualCoverage,
  VisualPlanAction,
  VisualProviderId,
  VisualReportModel
} from './model.js';
import { VISUAL_REPORT_STYLES } from './styles.js';

export type VisualReportRenderOptions = {
  token: string;
  nonce: string;
  expiresAtEpochMs: number;
};

type RenderModel = VisualReportModel & {
  aggregateAvailable: boolean;
};

const MAX_SESSION_MS = 30 * 60_000;
const ROUTE_VALUE = /^[A-Za-z0-9_-]{43}$/;
const PLAN_COPY_KEY: Record<VisualPlanAction, keyof typeof VISUAL_REPORT_COPY.en> = {
  'cursor-clean': 'planCursorClean',
  'codex-fix': 'planCodexFix',
  'codex-sparkle-clean': 'planCodexSparkle'
};

export function renderVisualReportHtml(
  model: VisualReportModel,
  options: VisualReportRenderOptions
): string {
  validateRenderOptions(options);
  const safeModel = normalizeModel(model);
  const copy = VISUAL_REPORT_COPY.en;
  const opportunityBytes = safeModel.aggregateAvailable
    ? safeModel.totals.safeBytes + safeModel.totals.reviewBytes
    : undefined;
  const generatedAt = safeModel.generatedAt;
  const capacityPercent = safeModel.volume.capacityPercent;
  const gaugePercent = capacityPercent ?? 0;
  const providerMax = Math.max(1, ...safeModel.providers.map((provider) => provider.bytes));
  const chart = bucketChart(safeModel);
  const clientConfig: VisualReportClientConfig = {
    copy: VISUAL_REPORT_COPY,
    token: options.token,
    expiresAtEpochMs: options.expiresAtEpochMs
  };

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>AIDM · ${escapeHtml(copy.readOnly)}</title>
  <style nonce="${options.nonce}">${VISUAL_REPORT_STYLES}</style>
</head>
<body>
  <header class="app-header">
    <div class="header-inner">
      <div class="brand-lockup" aria-label="AIDM AI Dev Maintenance">
        <span class="brand">AIDM</span>
        <span class="product-name">AI Dev Maintenance</span>
      </div>
      <div class="header-meta">
        <time id="report-time" class="report-time"${generatedAt === undefined ? '' : ` datetime="${generatedAt}" data-timestamp="${generatedAt}"`}>${generatedAt === undefined ? copy.unknown : formatDateEn(generatedAt)}</time>
        <div class="language-switch" role="group" aria-label="日本語 / English">
          <button id="language-ja" type="button" aria-pressed="false">${copy.languageJapanese}</button>
          <button id="language-en" type="button" aria-pressed="true">${copy.languageEnglish}</button>
        </div>
        <span id="read-only-badge" class="read-only-badge" data-copy="readOnly">${escapeHtml(copy.readOnly)}</span>
      </div>
    </div>
  </header>

  <div id="report-root">
    <main id="report-main" class="report-shell">
      <section id="storage-health" class="hero" aria-labelledby="report-title">
        <div>
          <p class="eyebrow" data-copy="storageHealth">${copy.storageHealth}</p>
          <h1 id="report-title" data-copy="${safeModel.volume.diskLevel === 'high' ? 'lowStorage' : 'storageHealth'}">${safeModel.volume.diskLevel === 'high' ? escapeHtml(copy.lowStorage) : copy.storageHealth}</h1>
          <p id="found-opportunity" class="hero-summary"${byteData(opportunityBytes)}>${opportunityBytes === undefined ? copy.unknown : escapeHtml(fillBytes(copy.foundOpportunity, opportunityBytes))}</p>
          <p class="muted" data-copy="noChangesYet">${escapeHtml(copy.noChangesYet)}</p>
          <span class="status-chip"><span data-copy="${diskCopyKey(safeModel.volume.diskLevel)}">${escapeHtml(copy[diskCopyKey(safeModel.volume.diskLevel)])}</span></span>
        </div>

        <div class="gauge-panel" data-level="${safeModel.volume.diskLevel}">
          <svg id="disk-gauge" viewBox="0 0 200 116" role="img" aria-labelledby="gauge-title gauge-description">
            <title id="gauge-title">${escapeHtml(copy.diskPressure)}</title>
            <desc id="gauge-description">${escapeHtml(copy[diskCopyKey(safeModel.volume.diskLevel)])}; ${safeModel.volume.availableBytes === undefined ? copy.unknown : escapeHtml(fillBytes(copy.freeSpace, safeModel.volume.availableBytes))}</desc>
            <path class="gauge-track" pathLength="100" d="M 20 100 A 80 80 0 0 1 180 100"></path>
            <path class="gauge-level" pathLength="100" stroke-dasharray="${formatChartNumber(gaugePercent)} ${formatChartNumber(100 - gaugePercent)}" d="M 20 100 A 80 80 0 0 1 180 100"></path>
          </svg>
          <div id="free-space" class="free-space-value"${byteData(safeModel.volume.availableBytes)}>${safeModel.volume.availableBytes === undefined ? copy.unknown : escapeHtml(fillBytes(copy.freeSpace, safeModel.volume.availableBytes))}</div>
          <p class="disk-pressure-line"><span data-copy="diskPressure">${escapeHtml(copy.diskPressure)}</span> · <strong id="disk-pressure-value" data-level="${safeModel.volume.diskLevel}">${escapeHtml(copy[diskCopyKey(safeModel.volume.diskLevel)])}</strong></p>
        </div>
      </section>

      <section id="opportunity-band" class="opportunity-card" aria-labelledby="tracked-state-heading">
        <h2 id="tracked-state-heading" class="section-heading" data-copy="trackedState">${escapeHtml(copy.trackedState)}</h2>
        <svg class="opportunity-chart" viewBox="0 0 100 4" preserveAspectRatio="none" aria-hidden="true">
          <rect x="0" y="0" width="${chart.safeWidth}" height="4" fill="#2b8a24"></rect>
          <rect x="${chart.reviewX}" y="0" width="${chart.reviewWidth}" height="4" fill="#d98200"></rect>
          <rect x="${chart.protectedX}" y="0" width="${chart.protectedWidth}" height="4" fill="#747c87"></rect>
        </svg>
        <div class="opportunity-legend">
          ${legendItem('safe', 'safeReclaimable', copy.safeReclaimable, safeModel.aggregateAvailable ? safeModel.totals.safeBytes : undefined)}
          ${legendItem('review', 'reviewFirst', copy.reviewFirst, safeModel.aggregateAvailable ? safeModel.totals.reviewBytes : undefined)}
          ${legendItem('protected', 'neverAutoTouch', copy.neverAutoTouch, safeModel.aggregateAvailable ? safeModel.totals.protectedBytes : undefined)}
          <div class="tracked-total">
            <span class="legend-label" data-copy="trackedTotal">${escapeHtml(copy.trackedTotal)}</span>
            ${byteSpan(safeModel.aggregateAvailable ? safeModel.totals.trackedBytes : undefined)}
          </div>
        </div>
        ${coverageWarning(safeModel.coverage)}
      </section>

      <div class="content-grid">
        <section aria-labelledby="recommended-heading">
          <h2 id="recommended-heading" class="section-heading" data-copy="recommendedNext">${escapeHtml(copy.recommendedNext)}</h2>
          <div class="category-list">
            ${categoryCard(
              'safe',
              copy.safe,
              'safeDescription',
              copy.safeDescription,
              safeModel.aggregateAvailable ? safeModel.totals.safeBytes : undefined,
              `<button id="safe-plan-trigger" class="primary-button" type="button" aria-expanded="false" aria-controls="safe-plan-details" data-copy="reviewSafePlan"${safeModel.availablePlans.length === 0 ? ' disabled' : ''}>${escapeHtml(copy.reviewSafePlan)}</button>`
            )}
            ${categoryCard('review', copy.review, 'reviewDescription', copy.reviewDescription, safeModel.aggregateAvailable ? safeModel.totals.reviewBytes : undefined)}
            ${categoryCard('protected', copy.protected, 'protectedDescription', copy.protectedDescription, safeModel.aggregateAvailable ? safeModel.totals.protectedBytes : undefined)}
          </div>
          <section id="safe-plan-details" class="safe-plan-details" tabindex="-1" hidden aria-labelledby="safe-plan-heading">
            <h3 id="safe-plan-heading" data-copy="safePlanHeading">${escapeHtml(copy.safePlanHeading)}</h3>
            ${safeModel.availablePlans.length === 0 ? `<p data-copy="noEligiblePlan">${escapeHtml(copy.noEligiblePlan)}</p>` : planList(safeModel.availablePlans)}
            <p id="copy-status" class="inline-status" role="status" aria-live="polite"></p>
          </section>
          <p id="storage-status" class="inline-status" role="status" aria-live="polite"></p>
        </section>

        <section id="provider-composition" class="provider-panel" aria-labelledby="provider-heading">
          <h2 id="provider-heading" class="section-heading" data-copy="providerBreakdown">${escapeHtml(copy.providerBreakdown)}</h2>
          <ul class="provider-list">
            ${safeModel.providers.map((provider) => providerRow(provider.id, provider.bytes, providerMax)).join('\n')}
          </ul>
          <div class="provider-total"><span data-copy="trackedTotal">${escapeHtml(copy.trackedTotal)}</span>${byteSpan(safeModel.aggregateAvailable ? safeModel.totals.trackedBytes : undefined)}</div>
          <p class="paths-hidden" data-copy="pathsHidden">${escapeHtml(copy.pathsHidden)}</p>
        </section>
      </div>

      <section id="privacy-proof" class="privacy-proof" aria-labelledby="privacy-heading">
        <h2 id="privacy-heading" class="visually-hidden" data-copy="pathsHidden">${escapeHtml(copy.pathsHidden)}</h2>
        ${privacyItem('localOnly', copy.localOnly)}
        ${privacyItem('noUpload', copy.noUpload)}
        ${privacyItem('pathsRedacted', copy.pathsRedacted)}
        ${privacyItem('noSourceChanges', copy.noSourceChanges)}
        ${privacyItem('noHtmlSaved', copy.noHtmlSaved)}
      </section>

      <footer class="report-footer">
        <p data-copy="closeHint">${escapeHtml(copy.closeHint)}</p>
        <p data-copy="jsonRetentionHint">${escapeHtml(copy.jsonRetentionHint)}</p>
      </footer>
    </main>
  </div>
  <script nonce="${options.nonce}">${renderVisualReportClient(clientConfig)}</script>
</body>
</html>`;
}

function validateRenderOptions(options: VisualReportRenderOptions): void {
  if (!ROUTE_VALUE.test(options.token)) throw new Error('invalid visual report token');
  if (!ROUTE_VALUE.test(options.nonce)) throw new Error('invalid visual report nonce');
  const now = Date.now();
  if (
    !Number.isSafeInteger(options.expiresAtEpochMs) ||
    options.expiresAtEpochMs <= now ||
    options.expiresAtEpochMs > now + MAX_SESSION_MS
  ) {
    throw new Error('invalid visual report expiry');
  }
}

function normalizeModel(model: VisualReportModel): RenderModel {
  const generatedAt = canonicalTimestamp(model.generatedAt);
  let reportStatus = visualStatus(model.reportStatus);
  const coverage = visualCoverage(model.coverage);
  const totals = normalizeTotals(model.totals);
  const counts = normalizeCounts(model.counts);
  const providers = normalizeProviders(model.providers);
  const providerTotal = safeSum(providers?.map((provider) => provider.bytes) ?? []);
  const zeroSentinel =
    totals !== undefined &&
    totals.trackedBytes === 0 &&
    providers?.length === 0 &&
    coverage === 'unavailable';
  const aggregateAvailable =
    totals !== undefined &&
    counts !== undefined &&
    providers !== undefined &&
    providerTotal === totals.trackedBytes &&
    !zeroSentinel;
  const volume = normalizeVolume(model.volume);
  if (!aggregateAvailable || volume.valid === false || coverage === 'unavailable') {
    reportStatus = reportStatus === 'ok' ? 'partial' : reportStatus;
  }

  return {
    ...(generatedAt === undefined ? {} : { generatedAt }),
    reportStatus,
    coverage,
    volume: volume.value,
    totals: aggregateAvailable
      ? totals
      : { trackedBytes: 0, safeBytes: 0, reviewBytes: 0, protectedBytes: 0 },
    providers: aggregateAvailable ? providers : [],
    counts: aggregateAvailable ? counts : { safe: 0, review: 0, protected: 0 },
    availablePlans: aggregateAvailable ? normalizePlans(model.availablePlans) : [],
    aggregateAvailable
  };
}

function normalizeTotals(totals: VisualReportModel['totals']): VisualReportModel['totals'] | undefined {
  if (!totals) return undefined;
  const values = [totals.trackedBytes, totals.safeBytes, totals.reviewBytes, totals.protectedBytes];
  if (!values.every(isByteCount)) return undefined;
  return safeSum(values.slice(1)) === totals.trackedBytes ? { ...totals } : undefined;
}

function normalizeCounts(counts: VisualReportModel['counts']): VisualReportModel['counts'] | undefined {
  if (!counts || ![counts.safe, counts.review, counts.protected].every(isByteCount)) return undefined;
  return { safe: counts.safe, review: counts.review, protected: counts.protected };
}

function normalizeProviders(
  providers: VisualReportModel['providers']
): VisualReportModel['providers'] | undefined {
  if (!Array.isArray(providers)) return undefined;
  const combined = new Map<VisualProviderId, number>();
  for (const provider of providers) {
    if (!provider || !isByteCount(provider.bytes)) return undefined;
    const id = visualProvider(provider.id);
    const total = safeAdd(combined.get(id) ?? 0, provider.bytes);
    if (total === undefined) return undefined;
    combined.set(id, total);
  }
  const order: VisualProviderId[] = ['codex', 'cursor', 'claude-code', 'other'];
  return [...combined]
    .map(([id, bytes]) => ({ id, bytes }))
    .sort((left, right) => right.bytes - left.bytes || order.indexOf(left.id) - order.indexOf(right.id));
}

function normalizePlans(plans: VisualReportModel['availablePlans']): VisualPlanAction[] {
  if (!Array.isArray(plans)) return [];
  const allowed = new Set(plans.filter(isVisualPlan));
  return (['cursor-clean', 'codex-fix', 'codex-sparkle-clean'] as const).filter((plan) => allowed.has(plan));
}

function normalizeVolume(volume: VisualReportModel['volume']): {
  valid: boolean;
  value: VisualReportModel['volume'];
} {
  if (!volume || volume.capacityPercent === undefined) {
    const noMetrics =
      volume?.totalBytes === undefined &&
      volume?.usedBytes === undefined &&
      volume?.availableBytes === undefined;
    return { valid: noMetrics, value: { diskLevel: 'unknown' } };
  }
  const { totalBytes, usedBytes, availableBytes, capacityPercent } = volume;
  if (
    !isByteCount(totalBytes) ||
    !isByteCount(usedBytes) ||
    !isByteCount(availableBytes) ||
    !Number.isFinite(capacityPercent) ||
    capacityPercent < 0 ||
    capacityPercent > 100
  ) {
    return { valid: false, value: { diskLevel: 'unknown' } };
  }
  const occupied = safeAdd(usedBytes, availableBytes);
  if (
    occupied === undefined ||
    occupied === 0 ||
    occupied > totalBytes ||
    round1((usedBytes / occupied) * 100) !== capacityPercent
  ) {
    return { valid: false, value: { diskLevel: 'unknown' } };
  }
  return {
    valid: true,
    value: {
      totalBytes,
      usedBytes,
      availableBytes,
      capacityPercent,
      diskLevel: diskLevelForCapacityPercent(capacityPercent)
    }
  };
}

function bucketChart(model: RenderModel): {
  safeWidth: string;
  reviewX: string;
  reviewWidth: string;
  protectedX: string;
  protectedWidth: string;
} {
  if (!model.aggregateAvailable || model.totals.trackedBytes === 0) {
    return { safeWidth: '0', reviewX: '0', reviewWidth: '0', protectedX: '0', protectedWidth: '0' };
  }
  const safe = (model.totals.safeBytes / model.totals.trackedBytes) * 100;
  const review = (model.totals.reviewBytes / model.totals.trackedBytes) * 100;
  const protectedWidth = Math.max(0, 100 - safe - review);
  return {
    safeWidth: formatChartNumber(safe),
    reviewX: formatChartNumber(safe),
    reviewWidth: formatChartNumber(review),
    protectedX: formatChartNumber(safe + review),
    protectedWidth: formatChartNumber(protectedWidth)
  };
}

function legendItem(
  className: 'safe' | 'review' | 'protected',
  copyKey: string,
  label: string,
  bytes: number | undefined
): string {
  return `<div class="legend-item ${className}"><span class="legend-label" data-copy="${copyKey}">${escapeHtml(label)}</span>${byteSpan(bytes)}</div>`;
}

function categoryCard(
  kind: 'safe' | 'review' | 'protected',
  label: string,
  descriptionKey: string,
  description: string,
  bytes: number | undefined,
  action = ''
): string {
  return `<article id="category-${kind}" class="category-card ${kind}">
    <div>
      <p class="category-title"><span class="category-label">${escapeHtml(label)}</span>${byteSpan(bytes)}</p>
      <p class="category-description" data-copy="${descriptionKey}">${escapeHtml(description)}</p>
    </div>
    ${action}
  </article>`;
}

function providerRow(id: VisualProviderId, bytes: number, max: number): string {
  const label = id === 'codex'
    ? 'Codex'
    : id === 'cursor'
      ? 'Cursor'
      : id === 'claude-code'
        ? 'Claude Code'
        : VISUAL_REPORT_COPY.en.providerOther;
  return `<li class="provider-row" data-provider="${id}">
    <span${id === 'other' ? ' data-copy="providerOther"' : ''}>${escapeHtml(label)}</span>
    <progress max="${max}" value="${bytes}" aria-hidden="true"></progress>
    ${byteSpan(bytes)}
  </li>`;
}

function planList(plans: VisualPlanAction[]): string {
  return `<ul class="plan-list">${plans.map((plan) => {
    const key = PLAN_COPY_KEY[plan];
    const command = VISUAL_REPORT_COPY.en[key];
    return `<li class="plan-row" data-plan="${plan}"><code>${escapeHtml(command)}</code><button class="copy-button" type="button" data-plan-copy="${plan}" data-copy="copyCommand">${escapeHtml(VISUAL_REPORT_COPY.en.copyCommand)}</button></li>`;
  }).join('')}</ul>`;
}

function privacyItem(copyKey: string, label: string): string {
  return `<div class="privacy-item"><strong data-copy="${copyKey}">${escapeHtml(label)}</strong></div>`;
}

function coverageWarning(coverage: VisualCoverage): string {
  if (coverage === 'complete') return '';
  const key = coverage === 'lower-bound' ? 'lowerBoundWarning' : 'volumeUnavailable';
  return `<p id="coverage-warning" class="coverage-warning" data-copy="${key}">${escapeHtml(VISUAL_REPORT_COPY.en[key])}</p>`;
}

function byteSpan(bytes: number | undefined): string {
  return `<strong${byteData(bytes)}>${bytes === undefined ? VISUAL_REPORT_COPY.en.unknown : formatBytesEn(bytes)}</strong>`;
}

function byteData(bytes: number | undefined): string {
  return bytes === undefined ? '' : ` data-bytes="${bytes}"`;
}

function fillBytes(template: string, bytes: number): string {
  return template.replace('{bytes}', formatBytesEn(bytes));
}

function formatBytesEn(bytes: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  const digits = index >= 3 ? 1 : 0;
  return `${value.toFixed(digits)} ${units[index]}`;
}

function formatDateEn(timestamp: string): string {
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC'
  }).format(new Date(timestamp));
}

function diskCopyKey(level: VisualReportModel['volume']['diskLevel']): 'diskOk' | 'diskMedium' | 'diskHigh' | 'unknown' {
  if (level === 'ok') return 'diskOk';
  if (level === 'medium') return 'diskMedium';
  if (level === 'high') return 'diskHigh';
  return 'unknown';
}

function visualStatus(status: unknown): VisualReportModel['reportStatus'] {
  if (status === 'ok' || status === 'partial' || status === 'blocked' || status === 'unsupported' || status === 'error') return status;
  return 'error';
}

function visualCoverage(coverage: unknown): VisualCoverage {
  if (coverage === 'complete' || coverage === 'lower-bound' || coverage === 'unavailable') return coverage;
  return 'unavailable';
}

function visualProvider(id: unknown): VisualProviderId {
  if (id === 'codex' || id === 'cursor' || id === 'claude-code') return id;
  return 'other';
}

function isVisualPlan(value: unknown): value is VisualPlanAction {
  return value === 'cursor-clean' || value === 'codex-fix' || value === 'codex-sparkle-clean';
}

function canonicalTimestamp(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return undefined;
  return new Date(parsed).toISOString() === value ? value : undefined;
}

function isByteCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function safeAdd(left: number, right: number): number | undefined {
  const sum = left + right;
  return Number.isSafeInteger(sum) && sum >= 0 ? sum : undefined;
}

function safeSum(values: number[]): number | undefined {
  let total = 0;
  for (const value of values) {
    const next = safeAdd(total, value);
    if (next === undefined) return undefined;
    total = next;
  }
  return total;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function formatChartNumber(value: number): string {
  return Number.isFinite(value) ? String(Math.round(value * 1_000) / 1_000) : '0';
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
