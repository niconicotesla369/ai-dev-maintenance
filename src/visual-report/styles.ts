const CSS_AT = '@';

export const VISUAL_REPORT_STYLES = String.raw`
:root {
  color-scheme: light;
  font-family: -apple-system, BlinkMacSystemFont, "Hiragino Sans", "Noto Sans JP", "Segoe UI", sans-serif;
  --surface: #fbfaf7;
  --surface-raised: #ffffff;
  --ink: #171717;
  --muted: #5f6570;
  --rule: #dedbd4;
  --blue: #0b62d6;
  --blue-soft: #eef6ff;
  --red: #dc3f35;
  --red-soft: #fff1ef;
  --green: #2b8a24;
  --green-soft: #f1f9ee;
  --amber: #b86500;
  --amber-soft: #fff7e8;
  --protected: #606873;
  --protected-soft: #f3f4f5;
  --focus: #005fcc;
}

* {
  box-sizing: border-box;
}

html {
  min-width: 320px;
  background: var(--surface);
}

body {
  margin: 0;
  min-height: 100vh;
  color: var(--ink);
  background: var(--surface);
  line-height: 1.5;
}

button {
  font: inherit;
}

button:focus-visible,
[tabindex="-1"]:focus-visible {
  outline: 3px solid var(--focus);
  outline-offset: 3px;
}

.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

.app-header {
  border-bottom: 1px solid var(--rule);
  background: rgba(255, 255, 255, 0.88);
}

.header-inner,
.report-shell {
  width: min(100% - 4rem, 1376px);
  margin-inline: auto;
}

.header-inner {
  min-height: 64px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1.5rem;
}

.brand-lockup,
.header-meta,
.language-switch {
  display: flex;
  align-items: center;
}

.brand-lockup {
  gap: 1rem;
  white-space: nowrap;
}

.brand {
  font-size: 1.42rem;
  font-weight: 820;
  letter-spacing: -0.04em;
}

.product-name,
.report-time,
.muted {
  color: var(--muted);
}

.header-meta {
  justify-content: flex-end;
  gap: 1rem;
  flex-wrap: wrap;
}

.language-switch {
  padding: 3px;
  border: 1px solid #c9d9ee;
  border-radius: 10px;
  background: var(--blue-soft);
}

.language-switch button {
  min-height: 34px;
  padding: 0.3rem 0.72rem;
  border: 0;
  border-radius: 7px;
  color: #183557;
  background: transparent;
  cursor: pointer;
}

.language-switch button[aria-pressed="true"] {
  color: #004ca8;
  background: #ffffff;
  box-shadow: 0 1px 4px rgba(18, 55, 96, 0.14);
}

.read-only-badge,
.status-chip,
.category-label {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  font-weight: 700;
  white-space: nowrap;
}

.read-only-badge {
  min-height: 36px;
  padding: 0.32rem 0.78rem;
  border: 1px solid #c9d9ee;
  color: #004ca8;
  background: var(--blue-soft);
}

.report-shell {
  padding-block: clamp(1.5rem, 2.5vw, 2rem) 1.25rem;
}

.hero {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(320px, 0.94fr);
  gap: clamp(2rem, 4vw, 3.5rem);
  align-items: center;
}

.eyebrow {
  margin: 0 0 0.45rem;
  color: var(--red);
  font-size: 0.84rem;
  font-weight: 800;
  letter-spacing: 0.11em;
}

.hero h1 {
  max-width: 15ch;
  margin: 0;
  font-size: clamp(2.5rem, 3.8vw, 3.7rem);
  line-height: 1.04;
  letter-spacing: -0.055em;
}

.hero-summary {
  max-width: 38rem;
  margin: 0.85rem 0 0;
  color: #454b55;
  font-size: clamp(0.96rem, 1.35vw, 1.08rem);
}

.hero .muted {
  margin: 0.25rem 0 0;
  font-size: 0.9rem;
}

.status-chip {
  margin-top: 0.75rem;
  padding: 0.26rem 0.72rem;
  border: 1px solid currentColor;
  color: var(--red);
  background: var(--red-soft);
}

.gauge-panel {
  min-width: 0;
  text-align: center;
}

.gauge-panel svg {
  display: block;
  width: min(100%, 420px);
  height: auto;
  margin-inline: auto;
  overflow: visible;
}

.gauge-track,
.gauge-level {
  fill: none;
  stroke-width: 18;
  stroke-linecap: round;
}

.gauge-track {
  stroke: #e7e7e5;
}

.gauge-level {
  stroke: var(--red);
}

.gauge-panel[data-level="medium"] .gauge-level {
  stroke: var(--amber);
}

.gauge-panel[data-level="ok"] .gauge-level {
  stroke: var(--green);
}

.gauge-panel[data-level="unknown"] .gauge-level {
  stroke: var(--protected);
}

.free-space-value {
  margin-top: -1.4rem;
  font-size: clamp(2.15rem, 3.4vw, 3.25rem);
  font-weight: 820;
  letter-spacing: -0.045em;
}

.disk-pressure-line {
  margin: 0.15rem 0 0;
  color: var(--muted);
  font-size: 0.96rem;
}

.disk-pressure-line strong {
  color: var(--red);
}

.opportunity-card {
  position: relative;
  margin-top: clamp(1rem, 2vw, 1.4rem);
  padding: 0.85rem 1.15rem;
  border: 1px solid var(--rule);
  border-radius: 14px;
  background: var(--surface-raised);
  box-shadow: 0 10px 34px rgba(48, 45, 38, 0.06);
}

.opportunity-card > .section-heading {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

.opportunity-chart {
  display: block;
  width: 100%;
  height: 11px;
  border-radius: 999px;
  overflow: hidden;
}

.opportunity-legend {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr)) auto;
  gap: 1rem;
  align-items: center;
  margin-top: 0.65rem;
}

.legend-item {
  min-width: 0;
}

.legend-label {
  display: block;
  color: var(--muted);
  font-size: 0.8rem;
}

.legend-value {
  display: block;
  margin-top: 0.12rem;
  font-size: 0.96rem;
  font-weight: 760;
}

.legend-item.safe .legend-value { color: var(--green); }
.legend-item.review .legend-value { color: var(--amber); }
.legend-item.protected .legend-value { color: var(--protected); }

.tracked-total {
  min-width: 132px;
  padding-left: 1rem;
  border-left: 1px solid var(--rule);
}

.tracked-total strong {
  display: block;
  font-size: 1.3rem;
  letter-spacing: -0.025em;
}

.coverage-warning {
  margin: 1rem 0 0;
  padding: 0.75rem 0.9rem;
  border-radius: 10px;
  color: #754000;
  background: var(--amber-soft);
}

.content-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.08fr) minmax(340px, 0.92fr);
  gap: clamp(2rem, 4vw, 3.25rem);
  margin-top: clamp(1.4rem, 2.5vw, 1.9rem);
}

.section-heading {
  margin: 0 0 0.65rem;
  font-size: 1.2rem;
  letter-spacing: -0.02em;
}

.category-list {
  display: grid;
  gap: 0.55rem;
}

.category-card {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 1rem;
  align-items: center;
  padding: 0.7rem 0.9rem;
  border-radius: 12px;
}

.category-card.safe { background: var(--green-soft); }
.category-card.review { background: var(--amber-soft); }
.category-card.protected { background: var(--protected-soft); }

.category-title {
  display: flex;
  gap: 0.55rem;
  align-items: baseline;
  margin: 0;
  font-weight: 780;
}

.category-description {
  margin: 0.12rem 0 0;
  color: var(--muted);
  font-size: 0.8rem;
}

.category-label {
  padding: 0.16rem 0.55rem;
  border: 1px solid currentColor;
  font-size: 0.76rem;
  letter-spacing: 0.06em;
}

.category-card.safe .category-label { color: var(--green); }
.category-card.review .category-label { color: var(--amber); }
.category-card.protected .category-label { color: var(--protected); }

.primary-button,
.copy-button {
  border: 0;
  border-radius: 10px;
  color: #ffffff;
  background: var(--blue);
  cursor: pointer;
}

.primary-button {
  min-height: 40px;
  margin: 0;
  padding: 0.55rem 0.9rem;
  font-weight: 760;
}

.primary-button:hover,
.copy-button:hover {
  background: #064ca9;
}

.safe-plan-details {
  margin-top: 1rem;
  padding: 1rem;
  border: 1px solid #c9d9ee;
  border-radius: 14px;
  background: var(--blue-soft);
}

.safe-plan-details h3 {
  margin: 0 0 0.75rem;
}

.plan-list {
  display: grid;
  gap: 0.65rem;
  margin: 0;
  padding: 0;
  list-style: none;
}

.plan-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 0.75rem;
  align-items: center;
  padding: 0.7rem;
  border-radius: 9px;
  background: #ffffff;
}

.plan-row code {
  min-width: 0;
  overflow-wrap: anywhere;
  color: #17365c;
  font-size: 0.82rem;
}

.copy-button {
  min-height: 36px;
  padding: 0.4rem 0.7rem;
  font-size: 0.82rem;
}

.inline-status {
  min-height: 1.2em;
  margin: 0.35rem 0 0;
  color: var(--muted);
  font-size: 0.85rem;
}

.inline-status:empty {
  display: none;
}

.provider-panel {
  padding-left: clamp(0rem, 2.5vw, 2rem);
  border-left: 1px solid var(--rule);
}

.provider-list {
  display: grid;
  gap: 0.7rem;
  margin: 0;
  padding: 0;
  list-style: none;
}

.provider-row {
  display: grid;
  grid-template-columns: 136px minmax(90px, 1fr) auto;
  gap: 0.8rem;
  align-items: center;
}

.provider-row progress {
  width: 100%;
  height: 8px;
  border: 0;
  border-radius: 999px;
  overflow: hidden;
  background: #e6e7e8;
}

.provider-row progress::-webkit-progress-bar {
  background: #e6e7e8;
}

.provider-row progress::-webkit-progress-value {
  background: var(--blue);
}

.provider-row progress::-moz-progress-bar {
  background: var(--blue);
}

.provider-total {
  display: flex;
  justify-content: space-between;
  gap: 1rem;
  margin-top: 0.85rem;
  padding-top: 0.75rem;
  border-top: 1px solid var(--rule);
  font-weight: 760;
}

.paths-hidden {
  margin: 0.35rem 0 0;
  color: var(--muted);
  font-size: 0.88rem;
}

.privacy-proof {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  margin-top: clamp(1.2rem, 2.5vw, 1.75rem);
  border: 1px solid #b9d4f4;
  border-radius: 16px;
  background: var(--blue-soft);
}

.privacy-item {
  min-width: 0;
  padding: 0.7rem 0.8rem;
}

.privacy-item + .privacy-item {
  border-left: 1px solid #c9d9ee;
}

.privacy-item strong {
  display: block;
  color: #12345a;
  font-size: 0.72rem;
  letter-spacing: 0.04em;
}

.report-footer {
  padding: 0.65rem 0 0;
  text-align: center;
  color: var(--muted);
  font-size: 0.85rem;
}

.report-footer p {
  margin: 0.12rem 0;
}

${CSS_AT}media (min-width: 1200px) {
  html[lang="ja"] .hero h1 {
    max-width: none;
    font-size: clamp(2.5rem, 3.65vw, 3.3rem);
    white-space: nowrap;
  }
}

.session-ended {
  width: min(100% - 2rem, 620px);
  margin: 16vh auto 0;
  padding: clamp(1.5rem, 5vw, 3rem);
  border: 1px solid var(--rule);
  border-radius: 18px;
  background: var(--surface-raised);
  text-align: center;
}

.session-ended h1 {
  margin: 0;
  font-size: clamp(1.8rem, 5vw, 2.8rem);
}

.session-ended p {
  margin: 0.8rem 0 0;
  color: var(--muted);
}

[hidden] {
  display: none !important;
}

${CSS_AT}media (max-width: 959px) {
  .header-inner,
  .report-shell {
    width: min(100% - 2rem, 760px);
  }

  .header-inner,
  .hero,
  .content-grid {
    grid-template-columns: 1fr;
  }

  .header-inner {
    padding-block: 0.8rem;
    align-items: flex-start;
  }

  .header-meta {
    gap: 0.55rem;
  }

  .hero {
    gap: 2rem;
  }

  .hero h1 {
    max-width: 18ch;
  }

  .opportunity-legend {
    grid-template-columns: 1fr 1fr;
  }

  .tracked-total {
    padding: 0;
    border: 0;
  }

  .provider-panel {
    padding: 0;
    border: 0;
  }

  .privacy-proof {
    grid-template-columns: 1fr 1fr;
  }

  .privacy-item + .privacy-item {
    border-left: 0;
  }

  .privacy-item:nth-child(even) {
    border-left: 1px solid #c9d9ee;
  }

  .privacy-item:nth-child(n + 3) {
    border-top: 1px solid #c9d9ee;
  }
}

${CSS_AT}media (max-width: 620px) {
  .header-inner {
    display: grid;
  }

  .header-meta {
    justify-content: flex-start;
  }

  .product-name,
  .report-time {
    display: none;
  }

  .opportunity-legend,
  .privacy-proof {
    grid-template-columns: 1fr;
  }

  .privacy-item:nth-child(even) {
    border-left: 0;
  }

  .privacy-item + .privacy-item {
    border-top: 1px solid #c9d9ee;
  }

  .category-card,
  .plan-row,
  .provider-row {
    grid-template-columns: 1fr;
  }

  .category-label,
  .copy-button {
    justify-self: start;
  }
}

${CSS_AT}media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    scroll-behavior: auto !important;
    transition-duration: 0.01ms !important;
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
  }
}
`;
