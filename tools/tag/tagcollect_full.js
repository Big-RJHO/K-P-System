// The owner has TAG's written permission to collect these reports and images for personal research.
// TAG data (reports, scans, cert lists) never goes into this repository: point the env vars below at a
// directory outside it.
//
// Collect TAG DIG reports and full-card scans for personal grading research (owner has TAG's written
// permission for reports and images). Reads only rendered public pages, as a browser does; never decodes
// TAG's API responses. Every page load, across all agents, waits for a shared pace (>= 5 s apart).
// Stops on any block (429 without Retry-After, 403, CAPTCHA or login wall) instead of working around it.
//
//   node tagcollect.js year   <year> <agent>                 -> sets in that year with graded totals
//   node tagcollect.js set    <set-url> <agent>              -> cards x grades with counts and their cert-list URLs
//   node tagcollect.js certs  <card-grade-url> <max> <agent> -> certs listed for that card and grade
//   TAGDB_OUT=DIR node tagcollect_full.js fetch <agent> <cert> ... -> DIR/<cert>/{report.json,report.txt,fetch.json,front.jpg,back.jpg} (full size)
//
// TAGDB_OUT: fetch output directory (outside the repo). TAGDB_CAP_BYTES: stop once it holds this much (default 9e9).
// TAGDB_PACE_DIR (required): the directory every collector shares for the pace lock (.pace, .pace.lock)
// and requests.log. All agents must use the same one, so the >= 5 s pace holds across all of them.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { parse } = require('./tagparse.js');

const PACE_DIR = process.env.TAGDB_PACE_DIR;
const UA = 'Mozilla/5.0 (K-P-System personal grading research; owner has TAG written permission; low rate)';
const PACE_MS = 5400;   // 5 s minimum plus a margin for lock and logging jitter
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (!PACE_DIR) { console.error('ERROR: set TAGDB_PACE_DIR (shared pace lock and requests.log directory)'); process.exit(2); }
fs.mkdirSync(PACE_DIR, { recursive: true });

class Blocked extends Error {}

async function pace(agent, url) {
  const lock = path.join(PACE_DIR, '.pace.lock'), file = path.join(PACE_DIR, '.pace');
  for (;;) {
    try { fs.mkdirSync(lock); break; } catch (e) {
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 60000) fs.rmdirSync(lock); } catch {}
      await sleep(150 + Math.random() * 200);
    }
  }
  try {
    const next = Number((fs.existsSync(file) && fs.readFileSync(file, 'utf8')) || 0);
    const wait = next - Date.now();
    if (wait > 0) await sleep(wait);
    const tmp = `${file}.${process.pid}`;   // write-then-rename: a reader never sees a half-written file
    fs.writeFileSync(tmp, String(Date.now() + PACE_MS)); fs.renameSync(tmp, file);
    fs.appendFileSync(path.join(PACE_DIR, 'requests.log'), `${new Date().toISOString()}\t${agent}\t${url}\n`);
  } finally { try { fs.rmdirSync(lock); } catch {} }
}

function holdOff(ms) {   // a 429's Retry-After pushes the shared pace back for everyone
  const file = path.join(PACE_DIR, '.pace');
  const next = Number((fs.existsSync(file) && fs.readFileSync(file, 'utf8')) || 0);
  const tmp = `${file}.${process.pid}`;
  fs.writeFileSync(tmp, String(Math.max(next, Date.now() + ms))); fs.renameSync(tmp, file);
}

async function open(agent, keepImages) {
  const b = await chromium.launch();
  const p = await b.newPage({ userAgent: UA, viewport: { width: 1400, height: 1000 } });
  // Download only what's needed: page code and data, plus the two full-card scans on a DIG page.
  await p.route('**/*', (route) => {
    const r = route.request(), t = r.resourceType(), u = r.url();
    if (['image', 'media', 'font'].includes(t)) return keepImages && /_(FRONT|BACK)_MAIN\.jpg/.test(u) ? route.continue() : route.abort();
    if (/googletagmanager|intercom|google-analytics|facebook|hotjar/.test(u)) return route.abort();
    return route.continue();
  });
  return { b, p };
}

async function go(p, agent, url, waitFor) {
  for (let attempt = 0; attempt < 2; attempt++) {
    await pace(agent, url);
    let res;
    try { res = await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 }); }
    catch (e) { if (attempt) throw e; await sleep(10000); continue; }
    const status = res ? res.status() : 0;
    if (status === 429) {
      const ra = Number(res.headers()['retry-after']);
      if (!ra) throw new Blocked('429 without Retry-After');
      holdOff(ra * 1000); continue;
    }
    if (status === 403 || status === 401) throw new Blocked(`HTTP ${status}`);
    if (waitFor) await p.waitForSelector(waitFor, { timeout: 45000 }).catch(() => {});
    await p.waitForTimeout(2500);
    const text = await p.innerText('body').catch(() => '');
    if (/captcha|verify you are human|access denied|are you a robot|please log ?in to/i.test(text)) throw new Blocked('block or CAPTCHA page');
    return text;
  }
  throw new Error('failed twice: ' + url);
}

async function year(y, agent) {
  const { b, p } = await open(agent, false);
  try {
    await go(p, agent, `https://my.taggrading.com/pop-report/Pok%C3%A9mon/${y}`, 'text=Pokémon Sets');
    const sets = await p.$$eval('tr', (trs) => trs.map((tr) => {
      const a = tr.querySelector('a[href*="/pop-report/"]');
      const cells = [...tr.querySelectorAll('td')].map((td) => td.textContent.trim());
      return a ? { name: a.textContent.trim(), url: a.href, total: Number((cells[cells.length - 1] || '0').replace(/,/g, '')) } : null;
    }).filter(Boolean));
    console.log(JSON.stringify(sets));
  } finally { await b.close(); }
}

async function set(url, agent) {
  const { b, p } = await open(agent, false);
  try {
    await go(p, agent, url, 'text=CARD #');
    const rows = await p.$$eval('a[href*="grades="]', (as) => as.map((a) => {
      const u = new URL(a.href);
      const parts = u.pathname.split('/').map(decodeURIComponent);   // decode after splitting: "4%2F102" holds a slash
      return { name: parts[parts.length - 2], number: parts[parts.length - 1], variation: u.searchParams.get('variation') || '',
        grade: u.searchParams.get('grades'), count: Number(a.textContent.trim().replace(/,/g, '')) || 0, url: a.href };
    }).filter((r) => r.count > 0));
    console.log(JSON.stringify(rows));
  } finally { await b.close(); }
}

async function certs(url, max, agent) {
  const { b, p } = await open(agent, false);
  try {
    await go(p, agent, url, 'text=CERT NUMBER');
    const rows = await p.$$eval('a[href*="/card/"]', (as) => as.map((a) => {
      const tr = a.closest('tr');
      const cells = tr ? [...tr.querySelectorAll('td')].map((td) => td.textContent.trim()) : [];
      return { cert: a.href.split('/card/')[1], grade_cell: cells[1] || '', completed: cells[cells.length - 2] || '' };
    }));
    console.log(JSON.stringify(rows.slice(0, Number(max) || 3)));
  } finally { await b.close(); }
}

// Full-size variant: saves into $TAGDB_OUT/<cert>/ and keeps the scans exactly as served (never shrunk),
// with their source URLs and SHA-256 in fetch.json. Stops once $TAGDB_OUT holds CAP_BYTES.
const crypto = require('crypto');
const OUT = process.env.TAGDB_OUT;
const CAP_BYTES = Number(process.env.TAGDB_CAP_BYTES || 9e9);
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
function dirBytes(d) {
  let n = 0;
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const f = path.join(d, e.name);
    n += e.isDirectory() ? dirBytes(f) : fs.statSync(f).size;
  }
  return n;
}

async function fetchCerts(agent, list) {
  if (!OUT) throw new Error('set TAGDB_OUT');
  fs.mkdirSync(OUT, { recursive: true });
  const { b, p } = await open(agent, true);
  const out = [];
  try {
    for (const cert of list) {
      if (!/^[A-Z0-9]{6,12}$/.test(cert)) { out.push({ cert, error: 'bad cert' }); continue; }
      const dir = path.join(OUT, cert);
      if (fs.existsSync(path.join(dir, 'fetch.json'))) { out.push({ cert, skipped: 'already saved' }); continue; }
      if (dirBytes(OUT) >= CAP_BYTES) { out.push({ cert, stopped: 'size cap reached' }); console.log(JSON.stringify(out)); process.exitCode = 4; return; }
      fs.mkdirSync(dir, { recursive: true });
      const scans = {}, urls = {};
      const onResp = async (r) => {
        const m = r.url().match(/_(FRONT|BACK)_MAIN\.jpg/);
        if (m && r.status() === 200) { try { const s = m[1].toLowerCase(); scans[s] = await r.body(); urls[s] = r.url(); } catch {} }
      };
      p.on('response', onResp);
      try {
        const text = await go(p, agent, 'https://tagd.co/' + cert, 'text=TAG SCORE');
        await p.waitForTimeout(4000);   // let the two scans finish
        const fetched_at = new Date().toISOString();
        const r = { ...parse(text, cert), cert, source_url: p.url(), fetched_at, agent };
        fs.writeFileSync(path.join(dir, 'report.txt'), text);
        const images = {};
        for (const [side, buf] of Object.entries(scans)) {
          fs.writeFileSync(path.join(dir, `${side}.jpg`), buf);
          images[side] = { url: urls[side], sha256: sha(buf), bytes: buf.length };
        }
        r.scans = Object.keys(scans);
        fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(r, null, 1));
        fs.writeFileSync(path.join(dir, 'fetch.json'), JSON.stringify({ cert, source_url: r.source_url, fetched_at, agent,
          report_txt_sha256: sha(Buffer.from(text)), parser: 'tagparse.js', images }, null, 1));
        out.push({ cert, grade: r.grade, score: r.score, card: r.card_name, scans: r.scans, dings: r.ding_list.length });
      } catch (e) {
        if (e instanceof Blocked) { out.push({ cert, blocked: e.message }); console.log(JSON.stringify(out)); process.exitCode = 3; return; }
        out.push({ cert, error: String(e.message || e).slice(0, 200) });
      } finally { p.off('response', onResp); }
    }
    console.log(JSON.stringify(out));
  } finally { await b.close(); }
}

(async () => {
  const [cmd, ...a] = process.argv.slice(2);
  try {
    if (cmd === 'year') await year(a[0], a[1] || 'cli');
    else if (cmd === 'set') await set(a[0], a[1] || 'cli');
    else if (cmd === 'certs') await certs(a[0], a[1], a[2] || 'cli');
    else if (cmd === 'fetch') await fetchCerts(a[0], a.slice(1));
    else { console.error('usage: year|set|certs|fetch'); process.exit(2); }
  } catch (e) {
    console.error((e instanceof Blocked ? 'BLOCKED: ' : 'ERROR: ') + String(e.message || e));
    process.exit(e instanceof Blocked ? 3 : 1);
  }
})();
