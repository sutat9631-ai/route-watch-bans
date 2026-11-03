/* Route Watch – the team's flood file. Fetches highway incidents (HDMS, กรมทางหลวง), ThaiWater road-flood sensors and
 * Longdo flood reports once for everybody, merges reports of the same place into events (lib/flood.js) and writes
 * flood.json for GitHub Pages. The extension reads that file instead of asking each source from every browser.
 *
 * lib/ holds copies of the extension's lib/sources.js, lib/flood.js and lib/geo.js: the same readers, so the file
 * has exactly the shape the extension already understands.
 *
 *   node flood/run.js --out site/flood.json
 */
const fs = require("fs"), path = require("path"), vm = require("vm");
for (const f of ["geo.js", "sources.js", "flood.js"]) vm.runInThisContext(fs.readFileSync(path.join(__dirname, "lib", f), "utf8"), { filename: f });
const RW = globalThis.RW;

const out = (() => { const i = process.argv.indexOf("--out"); return i > 0 ? process.argv[i + 1] : "site/flood.json"; })();
const UA = process.env.RW_UA || "RouteWatch-flood/1.0";
const nativeFetch = globalThis.fetch;
globalThis.fetch = (url, init) => {   // same requests as the extension, with a name and a time limit
  const o = Object.assign({}, init || {}); delete o.cache;
  o.headers = Object.assign({ "User-Agent": UA, Accept: "application/json, */*" }, o.headers || {});
  o.signal = AbortSignal.timeout(60000);
  return nativeFetch(url, o);
};

const SOURCES = { hdms: RW.fetchHDMS, thaiwater: RW.fetchThaiWater, longdo: RW.fetchLongdo };
(async () => {
  // keep everything from 1 cm and 7 days back: each browser applies its own threshold and age on top
  const ctx = { settings: { thresholdCm: 1, maxAgeDays: 7 }, zones: [] };
  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(out + ".prev", "utf8")); } catch (e) { /* first run */ }
  const sources = {};
  for (const [id, run] of Object.entries(SOURCES)) {
    const t0 = Date.now();
    try {
      const result = await run(ctx);
      sources[id] = { ok: true, at: Date.now(), ms: Date.now() - t0, result };
      console.log(`${id}: ok ${(result.points || []).length + (result.roads || []).length} items in ${Date.now() - t0} ms`);
    } catch (e) {
      if (e.cause) e = new Error(`${e.message}: ${e.cause.code || ""} ${e.cause.message || ""}`.trim());   // "fetch failed" alone says nothing
      // a source that failed this round: the last good copy (up to 12 h) stays in the file, marked with its own time
      const old = prev && prev.sources && prev.sources[id];
      const keep = old && old.ok && Date.now() - old.at < 12 * 3600e3;
      sources[id] = keep ? Object.assign({}, old, { lastError: String(e.message || e), errorAt: Date.now() }) : { ok: false, at: Date.now(), error: String(e.message || e) };
      console.log(`${id}: FAILED ${e.message || e}${keep ? " (kept the copy from " + new Date(old.at).toISOString() + ")" : ""}`);
    }
  }
  const items = RW.floodItems({ hdms: sources.hdms.ok && sources.hdms.result, thaiwater: sources.thaiwater.ok && sources.thaiwater.result, longdo: sources.longdo.ok && sources.longdo.result });
  const events = RW.floodEvents(items).map((e) => Object.assign({}, e, { sources: e.sources.map((s) => ({ src: s.src, levelCm: s.levelCm, passable: s.passable, time: s.time, title: s.title })) }));
  const file = { v: 1, generated: Date.now(), sources, events,
    thresholds: RW.FLOOD_VEH, note: "Route Watch flood feed: HDMS (กรมทางหลวง), ThaiWater flood_road, Longdo events. Rebuilt every 15 minutes." };
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(file));
  console.log(`events: ${events.length} (${events.filter((e) => e.status === "confirmed").length} confirmed) → ${out}`);
  if (!Object.values(sources).some((s) => s.ok)) process.exitCode = 1;   // nothing at all: the run shows red, Pages keeps the last file
})();
