import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load app.js in a mock global environment
const appJsPath = path.join(__dirname, '../js/app.js');
const appJsCode = fs.readFileSync(appJsPath, 'utf8');
const indexHtml = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');

function setupEnvironment() {
  const mockGlobal = {};
  const fn = new Function('window', 'global', appJsCode);
  fn(mockGlobal, mockGlobal);
  return mockGlobal.WattLogo;
}

test('WattLogo defines candidates in deterministic priority order', () => {
  const WattLogo = setupEnvironment();
  assert.ok(WattLogo, 'WattLogo must be exported');
  assert.deepEqual(WattLogo.CANDIDATES, [
    'assets/logo.svg',
    'assets/logo.png',
    'assets/logo.webp',
    'assets/logo.jpg',
    'assets/logo.jpeg'
  ]);
});

test('WattLogo.resolve picks SVG when SVG is available', async () => {
  const WattLogo = setupEnvironment();
  const probeMock = async (src) => src === 'assets/logo.svg' || src === 'assets/logo.png';
  const result = await WattLogo.resolve(WattLogo.CANDIDATES, probeMock);
  assert.equal(result, 'assets/logo.svg');
});

test('WattLogo.resolve cascades to PNG when SVG is missing', async () => {
  const WattLogo = setupEnvironment();
  const probeMock = async (src) => src === 'assets/logo.png' || src === 'assets/logo.webp';
  const result = await WattLogo.resolve(WattLogo.CANDIDATES, probeMock);
  assert.equal(result, 'assets/logo.png');
});

test('WattLogo.resolve cascades to WebP when SVG and PNG are missing', async () => {
  const WattLogo = setupEnvironment();
  const probeMock = async (src) => src === 'assets/logo.webp';
  const result = await WattLogo.resolve(WattLogo.CANDIDATES, probeMock);
  assert.equal(result, 'assets/logo.webp');
});

test('WattLogo.resolve cascades to JPG when earlier formats are missing', async () => {
  const WattLogo = setupEnvironment();
  const probeMock = async (src) => src === 'assets/logo.jpg';
  const result = await WattLogo.resolve(WattLogo.CANDIDATES, probeMock);
  assert.equal(result, 'assets/logo.jpg');
});

test('WattLogo.resolve cascades to JPEG when earlier formats are missing', async () => {
  const WattLogo = setupEnvironment();
  const probeMock = async (src) => src === 'assets/logo.jpeg';
  const result = await WattLogo.resolve(WattLogo.CANDIDATES, probeMock);
  assert.equal(result, 'assets/logo.jpeg');
});

test('WattLogo.resolve returns null gracefully when no candidate exists', async () => {
  const WattLogo = setupEnvironment();
  const probeMock = async () => false;
  const result = await WattLogo.resolve(WattLogo.CANDIDATES, probeMock);
  assert.equal(result, null);
});

test('canonical logo is present in initial HTML and versioned with the shared web version', () => {
  assert.match(
    indexHtml,
    /id="brand-logo"[^>]*src="assets\/logo\.svg\?v=__WATTPOST_WEB_VERSION__"[^>]*data-logo-canonical="assets\/logo\.svg\?v=__WATTPOST_WEB_VERSION__"/,
  );
  assert.match(
    indexHtml,
    /id="app-favicon"[^>]*href="assets\/logo\.svg\?v=__WATTPOST_WEB_VERSION__"[^>]*type="image\/svg\+xml"/,
  );
  assert.doesNotMatch(indexHtml, /id="brand-logo"[^>]*style="display:\s*none/);
});

test('WattLogo.apply uses canonical markup URL without probing again', async () => {
  const WattLogo = setupEnvironment();
  let probes = 0;
  const canonical = 'assets/logo.svg?v=V18.4.41';
  const mockBrandImg = {
    src: canonical,
    style: { display: '' },
    getAttribute(name) {
      return name === 'data-logo-canonical' ? canonical : null;
    },
  };
  const mockFavicon = { href: canonical, type: 'image/svg+xml', rel: 'icon' };
  const mockDoc = {
    getElementById: id => id === 'brand-logo' ? mockBrandImg : null,
    querySelector: sel => sel.includes('icon') ? mockFavicon : null,
  };

  const result = await WattLogo.apply(mockDoc, async () => {
    probes += 1;
    return 'assets/logo.png';
  });

  assert.equal(result, canonical);
  assert.equal(probes, 0);
  assert.equal(mockBrandImg.src, canonical);
  assert.equal(mockFavicon.href, canonical);
});

test('WattLogo.apply updates DOM image and favicon elements with appropriate type', async () => {
  const WattLogo = setupEnvironment();
  const mockBrandImg = { src: '', style: { display: 'none' }, tagName: 'IMG' };
  const mockFavicon = { href: '', type: '', rel: 'icon' };
  const mockDoc = {
    getElementById: (id) => id === 'brand-logo' ? mockBrandImg : null,
    querySelector: (sel) => sel.includes('icon') ? mockFavicon : null,
    createElement: () => ({ rel: 'icon' }),
    head: {}
  };

  await WattLogo.apply(mockDoc, async () => 'assets/logo.svg');

  assert.equal(mockBrandImg.src, 'assets/logo.svg');
  assert.equal(mockBrandImg.style.display, '');
  assert.equal(mockFavicon.href, 'assets/logo.svg');
  assert.equal(mockFavicon.type, 'image/svg+xml');
});

test('WattLogo.apply gracefully hides image element when no logo found', async () => {
  const WattLogo = setupEnvironment();
  const mockBrandImg = { src: 'old.png', style: { display: '' }, tagName: 'IMG' };
  const mockFavicon = { href: 'old.png', type: 'image/png', rel: 'icon' };
  const mockDoc = {
    getElementById: (id) => id === 'brand-logo' ? mockBrandImg : null,
    querySelector: (sel) => sel.includes('icon') ? mockFavicon : null
  };

  await WattLogo.apply(mockDoc, async () => null);

  assert.equal(mockBrandImg.style.display, 'none');
});
