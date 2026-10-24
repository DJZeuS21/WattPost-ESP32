import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

test('native cache upgrade closes old unguarded writers before accepting a new context', async () => {
  const require = createRequire(import.meta.url);
  const modules = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim();
  const { chromium } = require(path.join(modules, 'playwright'));
  const source = fs.readFileSync(new URL('../js/history-cache.js', import.meta.url), 'utf8');
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><script>' + source + '</script>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const result = await page.evaluate(async () => {
      const old = await new Promise((resolve, reject) => {
        const request = indexedDB.open('wattpost-mini', 2);
        request.onupgradeneeded = () => {
          request.result.createObjectStore('history-v2', { keyPath: 't' });
          request.result.createObjectStore('metadata');
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      await new Promise((resolve, reject) => {
        const tx = old.transaction('history-v2', 'readwrite');
        tx.objectStore('history-v2').put({ t: 100, source: 'previous epoch' });
        tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
      });
      let closed = false;
      // This listener is also present in the previous production v2 cache.
      old.onversionchange = () => { closed = true; old.close(); };
      const cache = new window.HistoryCache();
      await cache.setContext('new-device:2');
      const current = await cache.loadState('new-device:2');
      let oldWriteError;
      try { old.transaction('history-v2', 'readwrite'); }
      catch (error) { oldWriteError = error.name; }
      const reopenError = await new Promise(resolve => {
        const request = indexedDB.open('wattpost-mini', 2);
        request.onerror = () => resolve(request.error.name);
        request.onsuccess = () => { request.result.close(); resolve('unexpected success'); };
      });
      return { closed, oldWriteError, reopenError, records: current.records.length,
        version: (await cache._open()).version };
    });
    assert.deepEqual(result, { closed: true, oldWriteError: 'InvalidStateError',
      reopenError: 'VersionError', records: 0, version: 3 });
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
});
