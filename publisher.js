// publisher.js  (LOG ONLY: reads from the game and prints what it WOULD publish; changes nothing)
const BASE = 'https://v3.g.ladypopular.com';
const FORM = {
  accept: '*/*', 'accept-language': 'en-US,en;q=0.9',
  'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
  'x-requested-with': 'XMLHttpRequest',
  referer: `${BASE}/wardrobe.php?wardrobetype=lady&archive=0&category_id%5B0%5D=9`
};
const HTML = {
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.9', referer: `${BASE}/welcome.php`
};
const pad = (n) => String(n).padStart(2, '0');

async function getText(page, path) {
  const res = await page.request.get(BASE + path, { headers: HTML });
  if (!res.ok()) throw new Error(`GET ${path} returned HTTP ${res.status()}`);
  return res.text();
}
async function postJson(page, path, body) {
  const res = await page.request.post(BASE + path, { headers: FORM, data: body });
  if (!res.ok()) throw new Error(`POST ${path} returned HTTP ${res.status()}`);
  const t = await res.text();
  try { return JSON.parse(t); } catch (e) { throw new Error(`${path} gave non-JSON: ${t.slice(0, 150)}`); }
}
// reads the JSON object/array that follows a marker, matching brackets
function grab(text, marker, open, close) {
  const s = text.indexOf(marker); if (s === -1) return null;
  const b = text.indexOf(open, s); if (b === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = b; i < text.length; i++) {
    const c = text[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === open) depth++;
    else if (c === close) { depth--; if (depth === 0) return JSON.parse(text.slice(b, i + 1)); }
  }
  return null;
}

async function readHeader(page, html) {
  return page.evaluate((h) => {
    const doc = new DOMParser().parseFromString(h, 'text/html');
    const txt = (el, sel) => { const e = el.querySelector(sel); return e ? e.textContent.trim() : ''; };
    const tiles = [...doc.querySelectorAll('[data-entity_type="collection"]')].map(el => {
      const left = el.querySelector('.item-timeleft');
      const a = el.querySelector('a');
      return {
        id: Number(el.getAttribute('data-id')),
        flashback: el.getAttribute('data-is_flashback') === '1',
        name: txt(el, '.item-title'),
        counter: txt(el, '.all-rewards-button-label'),
        hoursLeft: left ? Number((Number(left.getAttribute('data-time-left')) / 3600).toFixed(1)) : null,
        href: a ? a.getAttribute('href') : null
      };
    });
    const freeSlot = !!doc.querySelector('.choose-flashback-button-js[data-type="collection_types"]');
    return { tiles, freeSlot };
  }, html);
}

async function ownedInCollection(page, storeId) {
  const re = /\$\('#item-(\d+)'\)\.data\('item',\s*(\{[^\n]*?\})\);/g;
  const rows = [];
  for (let p = 1; p <= 10; p++) {
    const j = await postJson(page, '/ajax/wardrobe.php',
      `wardrobetype=lady&archive=0&pet=0&empty_filter=false&default_category=false&store_id%5B%5D=${storeId}` +
      `&page=${p}&currentPageNum=${p}&updatePartials%5B%5D=3`);
    const html = j && j.partials && j.partials.partial3;
    if (!html) break;
    for (const m of html.matchAll(re)) {
      try {
        const it = JSON.parse(m[2]);
        rows.push({ itemId: Number(it.id), category: Number(it.type), colours: (it.colors || []).map(c => Number(c.color)) });
      } catch (e) { /* skip */ }
    }
    if (!(j.options && j.options.hasMore)) break;
    await page.waitForTimeout(400);
  }
  return rows;
}

async function collectionListing(page, href) {
  const o = grab(await getText(page, href), 'setMallOptions(', '{', '}');
  if (!o) throw new Error('collection data (setMallOptions) not found');
  const items = Object.values(o.pagination.itemsOnPages || {}).flat();
  return { items, itemsCount: o.itemsCount, itemsPerPage: o.itemsPerPage, pageType: o.collectionsPage };
}

const mallCache = {};
async function mallLookup(page, categoryId, itemId) {
  if (!mallCache[categoryId]) {
    const o = grab(await getText(page, `/mall/mall.php?action=loadMallContent&mallType=1&nextLevelItems=false&categoryId=${categoryId}`),
      'setMallOptions(', '{', '}');
    mallCache[categoryId] = o;
  }
  const o = mallCache[categoryId];
  if (!o) return { found: false, reason: 'mall data not found for this category' };
  for (const [pageNum, items] of Object.entries(o.pagination.itemsOnPages || {})) {
    const it = items.find(x => Number(x.id) === itemId);
    if (it) return { found: true, pageNum: Number(pageNum), storeId: it.store_id, canBuy: it.can_buy,
      minLevel: it.min_level, price: it.price, currency: it.currency, colours: it.colors,
      orderBy: (o.orderItems && o.orderItems.by) || '', orderType: (o.orderItems && o.orderItems.type) || '' };
  }
  return { found: false, reason: 'not in the mall listing (expired collection, or above this level)' };
}

module.exports = async function runPublisher(page) {
  console.log('📰 PUBLISHER (log only, nothing is sent anywhere)');
  const out = { errors: [] };
  const fail = (where, e) => { out.errors.push(`${where}: ${e.message}`); console.log(`❌ ${where}: ${e.message}`); };

  // 1) server date + header
  let tiles = [];
  try {
    const html = await getText(page, '/wardrobe.php?wardrobetype=lady&archive=0&category_id%5B0%5D=9');
    const m = html.match(/var currentTime = new Date\('([^']+)'\)/);
    if (!m) throw new Error('server clock not found');
    const d = new Date(m[1]);
    out.gameDate = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    out.gameTime = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    const nm = html.match(/id="lady-name-container">([^<]*)</);
    out.accountName = nm ? nm[1] : null;
    const h = await readHeader(page, html);
    tiles = h.tiles; out.freeFlashbackSlot = h.freeSlot;
    console.log(`🪪 Account: ${out.accountName} | 🕒 Server ${out.gameDate} ${out.gameTime} | free flashback slot: ${out.freeFlashbackSlot}`);
    console.log(`🗂️ Active collections: ${tiles.map(t => `${t.name} (${t.id}, ${t.flashback ? 'FLASHBACK' : 'LIVE'}, ${t.hoursLeft}h left, ${t.counter})`).join(' | ') || 'none'}`);
  } catch (e) { fail('server date/header', e); }

  // 2) what main is wearing
  let worn = [];
  try {
    const j = await postJson(page, '/ajax/wardrobe.php',
      'wardrobetype=lady&category_id%5B%5D=9&archive=0&pet=0&updatePartials%5B%5D=8');
    const arr = grab(j.partials && j.partials.partial8 || '', 'initModelImages(', '[', ']');
    if (!arr) throw new Error('worn items not found');
    worn = arr.map(x => ({
      itemId: Number(x.id), name: x.name, category: Number(x.type),
      colour: Number(x.additional && x.additional.color), layer: x.additional ? x.additional.offset : null,
      storeId: x.store_id ? Number(x.store_id) : null, eventId: x.event_id ? Number(x.event_id) : null,
      price: Number(x.price), currency: Number(x.currency), minLevel: Number(x.min_level), purchasable: Number(x.purchasable)
    }));
  } catch (e) { fail('worn items', e); }

  // 3) owned items per active collection (+ checksum against the header counter)
  out.collections = [];
  for (const t of tiles) {
    const c = { id: t.id, name: t.name, kind: t.flashback ? 'flashback' : 'live', hoursLeft: t.hoursLeft };
    try {
      c.owned = await ownedInCollection(page, t.id);
      const have = c.owned.reduce((n, r) => n + r.colours.length, 0);
      const cm = (t.counter || '').match(/^(\d+)\s*\/\s*(\d+)/);
      c.headerOwned = cm ? Number(cm[1]) : null;
      c.checksumOk = c.headerOwned === have;
      await page.waitForTimeout(400);
      const L = await collectionListing(page, t.href);
      c.itemsCount = L.itemsCount; c.pageType = L.pageType;
      const byId = {}; L.items.forEach(i => { byId[i.id] = i; });
      c.owned.forEach(r => { const i = byId[r.itemId]; if (i) { r.price = i.price; r.currency = i.currency; } });
      console.log(`📦 ${t.name}: owned colours found ${have}, header says ${c.headerOwned} -> ${c.checksumOk ? 'OK' : 'MISMATCH (would not publish)'} | listing ${L.items.length} of ${L.itemsCount} items`);
      c.owned.forEach(r => console.log(`    item ${r.itemId} (category ${r.category}) colours ${r.colours.join('/')}${r.price != null ? ` | price ${r.price}, currency ${r.currency}` : ''}`));
    } catch (e) { fail(`collection ${t.id}`, e); }
    out.collections.push(c);
  }

  // 4) sort the worn items and decide
  out.worn = [];
  for (const w of worn) {
    let kind;
    if (w.eventId) kind = 'event';
    else {
      const t = tiles.find(x => x.id === w.storeId);
      if (t) kind = t.flashback ? 'flashback-collection' : 'live-collection';
      else {
        try { w.mall = await mallLookup(page, w.category, w.itemId); } catch (e) { w.mall = { found: false, reason: e.message }; }
        kind = w.mall.found ? 'mall' : 'not-in-mall';
        await page.waitForTimeout(300);
      }
    }
    w.kind = kind; out.worn.push(w);
    console.log(`👗 layer ${w.layer}: item ${w.itemId} ${w.name} colour ${w.colour} | store ${w.storeId} event ${w.eventId} | ${kind}` +
      (w.mall ? (w.mall.found ? ` (mall page ${w.mall.pageNum}, price ${w.mall.price}, currency ${w.mall.currency}, min level ${w.mall.minLevel})` : ` (${w.mall.reason})`) : ''));
  }
  out.dressUp = out.worn.length > 0 && !out.worn.some(w => w.eventId);
  out.reason = out.worn.length === 0 ? 'no worn items read'
    : out.dressUp ? 'no event items, so this is a themed look' : 'an event item is worn, so stay in default';
  console.log(`🎯 Dress up today: ${out.dressUp ? 'YES' : 'NO'} (${out.reason})`);
  console.log(out.collections.every(c => c.checksumOk) && out.errors.length === 0
    ? '✅ Everything read cleanly: this is what would be published.'
    : '⚠️ Something did not read cleanly: nothing would be published.');

  // GitHub hides square brackets in logs, so they are swapped for ⟦ ⟧ in this line
  console.log('PUBLISH_PREVIEW_JSON ' + JSON.stringify(out).replace(/\[/g, '⟦').replace(/\]/g, '⟧'));
};
