// Fails when any page from the sitemap overflows horizontally at common mobile widths.
// Usage: node check-mobile-overflow.mjs <base-url> <path-to-sitemap.xml>
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const WIDTHS = [320, 375, 390, 430];
const PORT = 9399;
const [base, sitemapPath] = process.argv.slice(2);
if (!base || !sitemapPath) {
  console.error('usage: check-mobile-overflow.mjs <base-url> <sitemap.xml>');
  process.exit(2);
}

const paths = [...readFileSync(sitemapPath, 'utf8').matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => new URL(m[1]).pathname);
if (!paths.length) {
  console.error(`no <loc> entries in ${sitemapPath}`);
  process.exit(2);
}

const chromeBin = process.env.CHROME_BIN || 'google-chrome';
const chrome = spawn(chromeBin, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'chrome-'))}`,
  '--no-first-run', ...(process.env.CHROME_NO_SANDBOX ? ['--no-sandbox'] : []), 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });
let chromeStderr = '';
let chromeExit = null;
chrome.stderr.on('data', d => { chromeStderr = (chromeStderr + d).slice(-4000); });
chrome.on('exit', (code, signal) => { chromeExit = `code=${code} signal=${signal}`; });
chrome.on('error', err => { console.error(`cannot start ${chromeBin}: ${err.message}`); process.exit(2); });

const sleep = ms => new Promise(r => setTimeout(r, ms));
let targets;
for (let i = 0; i < 120 && !targets && chromeExit === null; i++) {
  await sleep(500);
  try { targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); } catch {}
}
if (!targets) {
  console.error(`chrome did not start (${chromeBin}, exit: ${chromeExit ?? 'still running'})`);
  console.error(chromeStderr);
  chrome.kill();
  process.exit(2);
}

const ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
let id = 0;
const pending = {};
const waiters = [];
ws.onmessage = e => {
  const m = JSON.parse(e.data);
  if (m.id && pending[m.id]) { pending[m.id](m); delete pending[m.id]; }
  if (m.method === 'Page.loadEventFired') waiters.splice(0).forEach(r => r());
};
await new Promise(r => { ws.onopen = r; });
const send = (method, params = {}) => new Promise((resolve, reject) => {
  pending[++id] = m => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result));
  ws.send(JSON.stringify({ id, method, params }));
});

const findOverflow = `(() => {
  const vw = document.documentElement.clientWidth;
  const hits = new Set();
  for (const el of document.querySelectorAll('body *')) {
    if (el.closest('.sr-only, .skip-link')) continue;
    const r = el.getBoundingClientRect();
    if (!r.width || r.right <= vw + 1) continue;
    const childOverflows = [...el.children].some(c => c.getBoundingClientRect().right > vw + 1);
    if (!childOverflows) {
      const cls = String(el.className).trim().split(/\\s+/).slice(0, 3).join('.');
      hits.add(el.tagName.toLowerCase() + (cls ? '.' + cls : '') + ' right=' + Math.round(r.right) + 'px "' + (el.innerText || '').trim().slice(0, 40).replace(/\\s+/g, ' ') + '"');
    }
  }
  return [...hits];
})()`;

await send('Page.enable');
let failed = false;
try {
  for (const path of paths) {
    for (const width of WIDTHS) {
      await send('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 2, mobile: true });
      const loaded = new Promise(r => waiters.push(r));
      await send('Page.navigate', { url: base + path });
      await Promise.race([loaded, sleep(15000)]);
      await sleep(300);
      const { result } = await send('Runtime.evaluate', { expression: findOverflow, returnByValue: true });
      if (result.value.length) {
        failed = true;
        console.log(`FAIL ${path} @${width}px`);
        for (const hit of result.value.slice(0, 10)) console.log(`  ${hit}`);
      } else {
        console.log(`ok   ${path} @${width}px`);
      }
    }
  }
} finally {
  ws.close();
  chrome.kill();
}
process.exit(failed ? 1 : 0);
