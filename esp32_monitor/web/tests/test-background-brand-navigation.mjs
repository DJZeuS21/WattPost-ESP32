import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INDEX = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'css/styles.css'), 'utf8');
const APP = fs.readFileSync(path.join(ROOT, 'js/app.js'), 'utf8');

test('shared page background uses the original WattPost grid treatment', () => {
  assert.match(CSS, /body\s*\{[\s\S]*?background:\s*#080b10;/);
  const backgroundBlock = CSS.match(/\.bg-grid\s*\{([\s\S]*?)\n\}/)?.[1] || '';
  assert.match(backgroundBlock, /linear-gradient\(rgba\(255,255,255,0\.02\) 1px, transparent 1px\)/);
  assert.match(backgroundBlock, /linear-gradient\(90deg, rgba\(255,255,255,0\.02\) 1px, transparent 1px\)/);
  assert.match(backgroundBlock, /background-size:\s*60px 60px/);
  assert.doesNotMatch(backgroundBlock, /ellipse 90% 70% at 50% 0%/);
  assert.match(CSS, /\.bg-spot-secondary[\s\S]*?rgba\(88,166,255,0\.04\)/);
});

test('WattPost brand is an accessible local Dashboard link by default', () => {
  assert.match(
    INDEX,
    /<a class="brand" id="brand-home-link" href="#dashboard"[^>]*aria-label="WattPost — до панелі"/
  );
  assert.match(INDEX, /<span class="brand-name">WattPost<\/span>/);
  assert.match(CSS, /\.brand:focus-visible/);
});

test('Cloud runtime redirects the same shared brand to the account device panel', () => {
  assert.match(APP, /const brandLink = document\.getElementById\('brand-home-link'\)/);
  assert.match(APP, /brandLink\.href = '\/account\?list=1'/);
  assert.match(APP, /capabilities\.accountControls !== true/);
});
