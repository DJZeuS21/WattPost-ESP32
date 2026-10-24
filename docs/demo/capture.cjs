/* Documentation capture only. No production DOM, styles or application state patches. */
const { chromium } = require('playwright');
const { resolve } = require('node:path');
const { mkdirSync, writeFileSync } = require('node:fs');
const { execFileSync } = require('node:child_process');
const root = resolve(__dirname, '../..');
const output = resolve(process.env.WATTPOST_SCREENSHOT_DIR || resolve(root, 'docs/screenshots'));
const origin = 'http://127.0.0.1:8765';
const now = Date.parse('2026-10-24T17:00:00Z');
const errors = [], requests = [], checks = [];

(async () => {
  mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1600, height: 1100 },
      deviceScaleFactor: 1, locale: 'uk-UA', timezoneId: 'Europe/Kyiv' });
    // Fix only wall-clock time for reproducible periods and labels; timers run normally.
    await context.addInitScript(({ now }) => {
      const OriginalDate = Date;
      window.Date = class extends OriginalDate {
        constructor(...args) { super(...(args.length ? args : [now])); }
        static now() { return now; }
      };
    }, { now });
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin || route.request().method() !== 'GET') {
        errors.push(`Blocked non-demo request: ${route.request().method()} ${url.origin}${url.pathname}`);
        return route.abort();
      }
      return route.continue();
    });
    const page = await context.newPage();
    page.on('console', msg => { if (['error', 'warning'].includes(msg.type())) errors.push(msg.text()); });
    page.on('pageerror', error => errors.push(error.message));
    page.on('response', response => {
      if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
      if (response.url().includes('/api/')) requests.push(new URL(response.url()).pathname);
    });
    async function ready() {
      await page.waitForFunction(() => window.ApiClient?.historyData.length >= 145 &&
        window.ApiClient?.connectivityState === 'FRESH' && window.ApiClient?._historyLoadingOps === 0,
        null, { timeout: 90000 });
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(1800);
    }
    async function shot(name, clipTo = null) {
      await page.mouse.move(0, 0);
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(500);
      const state = await page.evaluate(() => ({ title: document.title, url: location.hash,
        width: innerWidth, scrollWidth: document.documentElement.scrollWidth,
        content: document.querySelector('.view.is-active')?.innerText.length || document.body.innerText.length,
        records: window.ApiClient.historyData.length,
        canvases: [...document.querySelectorAll('.view.is-active canvas')].map(c => ({id:c.id,
          datasets: window.Chart.getChart(c)?.data.datasets.map(d => d.data.length)})) }));
      if (state.width < state.scrollWidth) throw Error(`Horizontal overflow in ${name}`);
      if (state.content < 100) throw Error(`Blank view in ${name}`);
      if (state.title !== 'WattPost — Battery Energy Monitoring') throw Error('Unexpected page title');
      if (state.canvases.some(c => !c.datasets?.length || c.datasets.some(n => n < 1))) {
        throw Error(`Empty chart in ${name}`);
      }
      const expectedPoints = name === 'history-week' ? 1009 : 145;
      if (state.canvases.filter(c => !c.id.includes('mode')).some(c => c.datasets.some(n => n !== expectedPoints))) {
        throw Error(`Unexpected chart density in ${name}`);
      }
      const clip = clipTo ? await page.locator(clipTo).boundingBox() : null;
      const frame = clip ? { fullPage: true, clip: { x: 0, y: 0, width: state.width, height: Math.ceil(clip.y + clip.height + 24) } } : { fullPage: true };
      const png = await page.screenshot({ path: resolve(output, name + '.png'), ...frame, animations: 'disabled' });
      state.image = { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
      if (clip && state.image.height !== frame.clip.height) throw Error(`Clipped screenshot in ${name}`);
      checks.push({ name, ...state });
      console.log(name, JSON.stringify(state));
    }
    await page.goto(origin, { waitUntil: 'networkidle' });
    await ready();
    await shot('dashboard', '#metrics-grid');
    await shot('dashboard-full');
    await page.locator('#tab-history').click();
    await ready();
    await page.locator('.metric-pill').filter({ hasText: 'Напруга' }).click();
    await shot('history');
    await shot('history-overview', '.history-row-1');
    await page.locator('[data-group="temperature"]').click();
    await page.locator('.metric-pill').filter({ hasText: 'MOSFET' }).click();
    await shot('history-temperature');
    await page.locator('[data-period="7d"]').click();
    await page.waitForFunction(() => window.ApiClient.historyData.length >= 1009 &&
      window.ApiClient._historyLoadingOps === 0, null, { timeout: 90000 });
    await page.locator('[data-group="cells"]').click();
    await page.waitForTimeout(1800);
    await shot('history-week');
    await page.locator('[data-period="14d"]').click();
    await page.waitForFunction(() => window.ApiClient.historyData.length === 2017 &&
      window.ApiClient._historyLoadingOps === 0 &&
      Chart.getChart('history-soc-chart').data.datasets[0].data.length === 2017, null, { timeout: 90000 });
    const allPoints = await page.evaluate(() => Chart.getChart('history-soc-chart').data.datasets[0].data.length);
    if (allPoints !== 2017) throw Error('Incomplete 14-day chart');
    checks.push({ period14d: true, records: 2017, chartPoints: allPoints });
    await page.locator('#tab-bms-settings').click();
    await page.waitForSelector('.setting-row');
    const rowCount = await page.locator('.setting-row').count();
    if (rowCount !== 53) throw Error(`Expected 53 settings, got ${rowCount}`);
    const blanks = await page.locator('.setting-value').allTextContents();
    if (blanks.some(t => t.trim() === '—')) throw Error('Missing demo setting');
    await page.locator('#settings-search-input').fill('баланс');
    const filteredRows = await page.locator('.setting-row:visible').count();
    if (!filteredRows || filteredRows >= rowCount) throw Error('Settings search failed');
    await page.locator('#settings-search-clear').click();
    await page.locator('#settings-search-input').blur();
    if (await page.locator('.setting-row:visible').count() !== 53) throw Error('Settings search did not clear');
    checks.push({ bmsSettings: true, rows: rowCount, searchFilteredRows: filteredRows, searchCleared: true });
    await shot('bms-settings');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#tab-dashboard').click();
    await page.waitForTimeout(2000);
    await shot('dashboard-mobile', '#metrics-grid');
    await page.locator('#tab-history').click();
    await page.locator('[data-period="24h"]').click();
    await page.locator('[data-group="electric"]').click();
    await page.locator('.metric-pill').filter({ hasText: 'Напруга' }).click();
    await page.waitForTimeout(1500);
    await shot('history-mobile', '.history-power-card');
    if (errors.length) throw Error(JSON.stringify(errors));
    writeFileSync(resolve(output, 'capture-report.json'), JSON.stringify({
      sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding:'utf8' }).trim(),
      webTree: execFileSync('git', ['rev-parse', 'HEAD:esp32_monitor/web'], { cwd: root, encoding:'utf8' }).trim(),
      browser: browser.version(), now: new Date(now).toISOString(), checks,
      errors, apiPaths: [...new Set(requests)] }, null, 2) + '\n');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
