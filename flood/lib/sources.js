/* Route Watch – data sources (run in the service worker).
 * Each fetcher returns { points:[], areas:[], warnings:[] } in one common shape:
 *   point   { source, lat, lng, title, detail, level, time }
 *   area    { source, rings:[ring], bbox, time }            (flood extent polygons)
 *   warning { source, title, detail, provinces:[], issued, expires, link }
 *   road    { source, lat, lng, road, km, title, passable, level, line:[[lng,lat]…] }   (optional 4th list)
 */
(function (root) {
  const RW = root.RW || (root.RW = {});
  const H = 3600 * 1000;

  async function getText(url, init) {
    const res = await fetch(url, Object.assign({ cache: "no-store" }, init || {}));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
  }
  async function getJSON(url, init) {
    const t = await getText(url, init);
    try { return JSON.parse(t); } catch (e) { throw new Error("รูปแบบข้อมูลไม่ใช่ JSON"); }
  }
  const tag = (xml, name) => {
    const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i"));
    return m ? m[1].replace(/<!\[CDATA\[|\]\]>/g, "").replace(/<[^>]+>/g, " ").trim() : "";
  };
  const thaiTime = (s) => {
    if (!s) return NaN;
    if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(s) && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(s)) s = s.replace(" ", "T") + "+07:00";
    return Date.parse(s);
  };
  RW.thaiTime = thaiTime;
  /* TMD radar composite (weather.tmd.go.th/composite/data/composite.ascii): an ESRI ASCII grid of rain rate in mm/h,
     header ncols/nrows/xllcorner/yllcorner/cellsize/nodata_value, rows from north to south. A cut-short file keeps
     the whole rows it has. */
  RW.parseAsciiGrid = function (text) {
    const h = {}, re = /^\s*(ncols|nrows|xllcorner|yllcorner|cellsize|nodata_value)\s+(\S+)/i;
    let pos = 0;
    for (let i = 0; i < 6; i++) {
      const end = text.indexOf("\n", pos), line = text.slice(pos, end < 0 ? text.length : end), m = line.match(re);
      if (!m) break;
      h[m[1].toLowerCase()] = +m[2]; pos = end < 0 ? text.length : end + 1;
    }
    if (!(h.ncols > 0 && h.nrows > 0 && h.cellsize > 0) || h.xllcorner == null || h.yllcorner == null) throw new Error("ไม่ใช่ไฟล์ ASCII grid");
    const nod = h.nodata_value != null ? h.nodata_value : -9999, n = h.ncols * h.nrows, vals = new Float32Array(n);
    let k = 0, i = pos, L = text.length;
    while (k < n && i < L) {   // hand-rolled number scan: fast on ~20 MB
      let c = text.charCodeAt(i);
      if (c <= 32) { i++; continue; }
      let j = i; while (j < L && text.charCodeAt(j) > 32) j++;
      const v = +text.slice(i, j); vals[k++] = v === nod || !(v >= 0) ? NaN : v; i = j;
    }
    const rows = Math.floor(k / h.ncols);
    return { ncols: h.ncols, nrows: h.nrows, rows, west: h.xllcorner, south: h.yllcorner, cell: h.cellsize, north: h.yllcorner + h.nrows * h.cellsize, vals };
  };
  /* Rain around a point from the radar grid: the rate at the point (the strongest of the 3×3 cells around it, ~3 km),
     the strongest cell in each compass sector within `km`, and the little matrix of rates (north up) for drawing.
     inside=false when the point (or all cells around it) has no radar data at all: outside the radar range is not "no rain". */
  const DIRS = ["เหนือ", "ตะวันออกเฉียงเหนือ", "ตะวันออก", "ตะวันออกเฉียงใต้", "ใต้", "ตะวันตกเฉียงใต้", "ตะวันตก", "ตะวันตกเฉียงเหนือ"];
  RW.compassTh = (deg) => DIRS[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
  RW.radarProbe = function (g, lat, lng, km) {
    km = km || 20;
    const cx = Math.floor((lng - g.west) / g.cell), cy = Math.floor((g.north - lat) / g.cell), out = (x, y) => x < 0 || x >= g.ncols || y < 0 || y >= g.rows,
      at = (x, y) => { if (out(x, y)) return NaN; const v = g.vals[y * g.ncols + x]; return v >= 0 ? v : 0; };   // TMD stores most dry cells as nodata: inside the grid, no value = no rain
    const kx = Math.cos((lat * Math.PI) / 180) * 111.32 * g.cell, ky = 110.57 * g.cell;   // km per cell, east-west / north-south
    const R = Math.ceil(km / Math.min(kx, ky));
    if (out(cx, cy)) return { inside: false, mm: null, sectors: [], cells: null, R, km, kx, ky };
    let mm = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const v = at(cx + dx, cy + dy); if (v > mm) mm = v; }
    if (!(mm >= 0)) return { inside: false, mm: null, sectors: [], cells: null, R, km, kx, ky };
    const cells = [], sec = new Array(8).fill(null);
    for (let dy = -R; dy <= R; dy++) {
      const row = [];
      for (let dx = -R; dx <= R; dx++) {
        const v = at(cx + dx, cy + dy);
        row.push(v >= 0 ? Math.round(v * 10) / 10 : null);
        if (!(v >= 0.3)) continue;
        const ex = dx * kx, ny = -dy * ky, d = Math.sqrt(ex * ex + ny * ny);
        if (d > km || d < 0.01) continue;
        const brg = ((Math.atan2(ex, ny) * 180) / Math.PI + 360) % 360, k = Math.round(brg / 45) % 8, cur = sec[k];
        if (!cur || v > cur.mm || (v === cur.mm && d < cur.d)) sec[k] = { mm: Math.round(v * 10) / 10, d: Math.round(d * 10) / 10, brg: Math.round(brg), dir: DIRS[k] };
      }
      cells.push(row);
    }
    const sectors = sec.filter(Boolean).sort((a, b) => b.mm - a.mm || a.d - b.d);
    return { inside: true, mm: Math.round(mm * 10) / 10, sectors, cells, R, km, kx, ky };
  };
  /* mm/h → 0..1 (log scale): 0.2 → 0, ~1 → 0.26, 12.5 → 0.66, 52 → 0.9, 100 and more → 1 */
  RW.rainT = (mm) => Math.max(0, Math.min(1, Math.log10(mm / 0.2) / Math.log10(500)));
  /* HDMS photo links: full URLs, attachment/… paths, or bare file names (20261015153125-4970.jpg → attachment/s3/202610/…) */
  RW.HDMS_ORIGIN = "https://hdms.doh.go.th";
  RW.hdmsPhotoUrl = function (it) {
    if (it && typeof it === "object" && it.file_type && it.file_type !== "image") return "";
    const vals = typeof it === "string" ? [it] : Object.values(it || {});
    const s = vals.find((v) => typeof v === "string" && /\.(jpe?g|png|webp|gif)(\?|$)/i.test(v));
    if (!s) return "";
    if (/^https?:\/\//.test(s)) return s;
    let p = s.replace(/^\/+/, "");
    if (p.startsWith("attachment/")) return `${RW.HDMS_ORIGIN}/${p}`;
    if (!p.includes("/")) { const m = p.match(/^(\d{6})\d{8}-/); if (m) p = `s3/${m[1]}/${p}`; }
    return `${RW.HDMS_ORIGIN}/attachment/${p}`;
  };

  /* Province names as they appear in an area list -> official name used in zones.json.
   * Thai has no spaces, so a plain substring test misfires: "น่านน้ำ" (territorial waters) contains "น่าน",
   * "ตากใบ" / "ตากฟ้า" (districts) contain "ตาก". Known look-alikes are removed first, and the short,
   * ambiguous names (เลย, ตาก, น่าน) must stand alone or follow "จ."/"จังหวัด". */
  const LOOKALIKES = /น่านน้ำ|ตากใบ|ตากฟ้า|แม่ตาก|ท่าตาก/g;
  const AMBIGUOUS = new Set(["เลย", "ตาก", "น่าน"]);
  const SEP = "[\\s,;/()|•\\-–.:]";
  RW.provinceMatcher = function (provinces) {
    const extra = {
      "กรุงเทพมหานคร": ["กรุงเทพ", "กทม"], "พระนครศรีอยุธยา": ["อยุธยา"], "ประจวบคีรีขันธ์": ["ประจวบ"],
      "สุราษฎร์ธานี": ["สุราษฎร์"], "นครศรีธรรมราช": ["นครศรี"],
    };
    const pats = provinces.map((p) => [p, [p].concat(extra[p] || [])]);
    const alone = (n) => new RegExp(`(?:^|${SEP}|จ\\.|จังหวัด)${n}(?:$|${SEP})`);
    return (text) => {
      const t = String(text || "").replace(LOOKALIKES, " ");
      return pats.filter(([, names]) => names.some((n) => (AMBIGUOUS.has(n) ? alone(n).test(t) : t.includes(n)))).map(([p]) => p);
    };
  };
  /* Regional wording in an area list ("ภาคใต้", "ประเทศไทยตอนบน"): not a province list, so it never decides
   * which zones are warned; it only tells the panel that the announcement is a regional overview. */
  RW.regionWords = function (text) {
    const t = String(text || "");
    return ["ทั่วประเทศ", "ประเทศไทยตอนบน", "ประเทศไทยตอนล่าง", "ภาคเหนือ", "ภาคตะวันออกเฉียงเหนือ", "ภาคอีสาน", "ภาคกลาง", "ภาคตะวันออก", "ภาคตะวันตก", "ภาคใต้", "ปริมณฑล"].filter((w) => t.includes(w));
  };

  /* 1) Thai Meteorological Department – official CAP warnings (no key) */
  RW.fetchTMD = async function (ctx) {
    const xml = await getText("https://www.tmd.go.th/api/xml/CAP");
    const items = xml.split(/<item[\s>]/i).slice(1);
    const now = Date.now(), out = [];
    let capTried = 0, capFailed = 0;
    for (const it of items.slice(0, 12)) {
      const title = tag(it, "title"), detail = tag(it, "description"), link = tag(it, "link");
      const issued = Date.parse(tag(it, "pubDate"));
      if (!/ฝนตกหนัก|น้ำท่วม|น้ำป่า|น้ำล้น|พายุ|ดีเปรสชัน/.test(title + detail)) continue;
      if (isFinite(issued) && now - issued > 72 * H) continue;
      let expires = NaN, areaText = "", rings = [], web = "", headline = "", instruction = "", capDesc = "";
      if (link) {
        capTried++;
        try {
          const cap = await getText(link);
          expires = Date.parse(tag(cap, "expires"));
          areaText = (cap.match(/<areaDesc>([\s\S]*?)<\/areaDesc>/gi) || []).map((s) => s.replace(/<[^>]+>/g, " ")).join(" ");
          // CAP polygons are "lat,lon lat,lon …" — the official outline of the warned area
          for (const m of cap.matchAll(/<polygon>([\s\S]*?)<\/polygon>/gi)) {
            const ring = m[1].trim().split(/\s+/).map((p) => p.split(",").map(Number)).filter((p) => p.length === 2 && p.every(isFinite)).map(([la, lo]) => [lo, la]);
            if (ring.length >= 3) rings.push(ring);
          }
          web = tag(cap, "web"); headline = tag(cap, "headline"); instruction = tag(cap, "instruction"); capDesc = tag(cap, "description");
        } catch (e) { capFailed++; continue; }   // without the full CAP we can't tell which provinces are warned: skip, never guess
      }
      if (!isFinite(expires)) expires = (isFinite(issued) ? issued : now) + 24 * H;
      if (expires < now) continue;
      // Which places are warned: the CAP outline first, then its area list; free text is a last resort,
      // because the narrative also mentions places that are NOT warned (e.g. "รวมทั้งกรุงเทพฯ" in a regional summary).
      const provinces = ctx.matchProvinces(areaText);
      if (!rings.length && !provinces.length) continue;
      // how this announcement was tied to places (shown in the card, so "why is my zone here?" has an answer)
      const regions = RW.regionWords(areaText), area = areaText.replace(/\s+/g, " ").trim().slice(0, 200);
      out.push({ source: "กรมอุตุนิยมวิทยา", title: headline || title, detail: (capDesc || detail).slice(0, 400), instruction: instruction.slice(0, 300),
        provinces, rings, issued, expires, matchedBy: rings.length ? "polygon" : "provinces", areaText: area, regions,
        link: "https://www.tmd.go.th/warning-and-events/warning-storm" });   // the warnings list, not the general forecast page
    }
    if (capTried && capFailed === capTried) throw new Error("อ่านประกาศฉบับเต็ม (CAP) ไม่ได้");   // keeps the last good result instead
    return { points: [], areas: [], warnings: out };
  };

  /* 2) GISTDA – flood extent from satellite, last 1 day (official, needs API key) */
  RW.fetchGISTDA = async function (ctx) {
    if (!ctx.settings.gistdaKey) throw new Error("ยังไม่ได้ใส่ API key ของ GISTDA");
    const base = "https://api-gateway.gistda.or.th/api/2.0/resources/features/flood/3days";
    const areas = [], limit = 1000;
    for (let page = 0; page < 20; page++) {
      const url = `${base}?limit=${limit}&offset=${page * limit}`;   // the key goes in the API-Key header only (URLs end up in proxy logs)
      let data;
      try { data = await getJSON(url, { headers: { "API-Key": ctx.settings.gistdaKey } }); }
      catch (e) { if (/HTTP 40[13]/.test(e.message)) throw new Error("API key ของ GISTDA ใช้ไม่ได้ (" + e.message + ")"); throw e; }
      const feats = data.features || (data.data && data.data.features) || (Array.isArray(data) ? data : []);
      for (const f of feats) {
        const g = f.geometry || {};
        const polys = g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : [];
        for (const p of polys) {
          if (!p || !p[0] || p[0].length < 3) continue;
          const ring = p[0];
          areas.push({ source: "GISTDA ดาวเทียม", rings: [ring], bbox: RW.ringBBox(ring), time: f.properties && (f.properties.date || f.properties.acq_date || f.properties.flood_date || "") });
        }
      }
      if (feats.length < limit) break;
    }
    return { points: [], areas, warnings: [] };
  };

  /* Longdo road events other than floods: 19 = road closed, 18 / 12 = diversion or lane closure (works), 3 = accident,
     1 = broken-down vehicle. Each has a start and a stop (closures announced for days or years, accidents ~1 h).
     Kept while in force or starting within 2 days. Positions are single points, often on a side street. */
  RW.LONGDO_ROAD = { 19: "closed", 18: "divert", 12: "divert", 3: "accident", 1: "breakdown" };
  RW.parseLongdoRoad = function (list, now) {
    now = now || Date.now();
    const out = [];
    for (const e of list || []) {
      const kind = RW.LONGDO_ROAD[String(e.type)]; if (!kind) continue;
      const lat = parseFloat(e.latitude), lng = parseFloat(e.longitude);
      if (!isFinite(lat) || !isFinite(lng)) continue;
      const start = thaiTime(e.start), stop = thaiTime(e.stop);
      if (!isFinite(start)) continue;
      if (isFinite(stop) ? stop < now : now - start > 3 * H) continue;   // over (no stop: a short event, at most 3 h)
      if (start > now + 48 * H) continue;
      const desc = String(e.description || "").replace(/\s+/g, " ").trim();
      const ag = desc.match(/^(.{2,40}?)\s*แจ้ง/);
      out.push({ source: "Longdo / iTIC", kind, lat: +lat.toFixed(6), lng: +lng.toFixed(6), title: String(e.title || RW.ROAD_KIND[kind]).trim(),
        detail: desc.slice(0, 220), agency: ag ? ag[1].trim() : "", start, stop: isFinite(stop) ? stop : start + 3 * H, approx: true,
        moto: kind === "accident" && /รถจักรยานยนต์/.test(desc) && !/ไม่ใช่รถจักรยานยนต์/.test(desc) });
    }
    return out;
  };

  /* 3) Longdo / iTIC traffic events – type 6 = flood (undocumented feed: opt-in, ask Longdo first); road events too */
  RW.fetchLongdo = async function (ctx) {
    const maxAge = Math.max(1, Number((ctx && ctx.settings.maxAgeDays) || 3)) * 24 * H;
    const data = await getJSON("https://event.longdo.com/feed/json");
    const list = Array.isArray(data) ? data : data.data || data.events || [];
    const now = Date.now(), out = [], roadEvents = RW.parseLongdoRoad(list, now);
    for (const e of list) {
      if (String(e.type) !== "6") continue;
      const lat = parseFloat(e.latitude), lng = parseFloat(e.longitude);
      if (!isFinite(lat) || !isFinite(lng)) continue;
      const start = thaiTime(e.start), stop = thaiTime(e.stop);
      if (isFinite(stop) && stop < now) continue;
      // reports often have no end time and stay in the feed for weeks: keep only recent ones
      if (isFinite(start) && now - start > maxAge) continue;
      if (!isFinite(start)) continue;
      const txt = `${e.title || ""} ${e.description || ""}`;
      const rd = txt.match(/(?:ทางหลวง(?:หมายเลข)?|ทล\.?|ภก\.?|ถนน)\s*(\d{3,4})/), km = txt.match(/กม\.?(?:ที่)?\s*([\d.]+(?:\+\d+)?)/);
      out.push({ source: "Longdo / iTIC", lat, lng, title: e.title || "น้ำท่วม", detail: (e.description || "").slice(0, 200), level: "", time: isFinite(start) ? start : null,
        approx: true, by: String(e.contributor || "").slice(0, 40), roadText: rd ? rd[1] : "", kmText: km ? km[1] : "" });   // the feed gives a point only: shown as an approximate position
    }
    return { points: out, areas: [], warnings: [], roadEvents };
  };

  /* 4) ThaiWater road flood sensors (undocumented endpoint: opt-in, ask สสน. first).
   * Field names are not documented, so the reader looks for lat/lng/level/name keys anywhere in each row. */
  function deepFind(obj, test, depth) {
    if (!obj || typeof obj !== "object" || depth > 3) return undefined;
    for (const [k, v] of Object.entries(obj)) {
      if (v !== null && typeof v !== "object" && test(k, v)) return v;
    }
    for (const v of Object.values(obj)) {
      const r = deepFind(v, test, depth + 1);
      if (r !== undefined) return r;
    }
    return undefined;
  }
  RW.fetchThaiWater = async function (ctx) {
    const data = await getJSON("https://api-v3.thaiwater.net/api/v1/thaiwater30/public/flood_road");
    const list = Array.isArray(data) ? data : Array.isArray(data.data) ? data.data : (data.data && data.data.data) || [];
    if (!Array.isArray(list) || !list.length) throw new Error("ไม่พบรายการเซนเซอร์ในข้อมูล");
    const out = [], min = Number(ctx.settings.thresholdCm || 10);
    let readable = 0;
    for (const r of list) {
      const lat = parseFloat(deepFind(r, (k) => /(^|_)lat/i.test(k), 0));
      const lng = parseFloat(deepFind(r, (k) => /(^|_)(lon|lng|long)/i.test(k), 0));
      const lvl = parseFloat(deepFind(r, (k, v) => /(flood.*value|water.*level|level|value)$/i.test(k) && isFinite(parseFloat(v)), 0));
      if (!isFinite(lat) || !isFinite(lng)) continue;
      readable++;
      if (!isFinite(lvl) || lvl < min) continue;
      const name = deepFind(r, (k, v) => /(^th$|name_th|_name$|^name$)/i.test(k) && typeof v === "string", 0) || "เซนเซอร์น้ำบนถนน";
      const t = thaiTime(deepFind(r, (k) => /(datetime|date|time)/i.test(k), 0));
      out.push({ source: "เซนเซอร์ถนน สสน.", lat, lng, title: name, detail: "", level: `${lvl} ซม.`, time: isFinite(t) ? t : null });
    }
    if (!readable) throw new Error("อ่านพิกัดเซนเซอร์ไม่ได้ (รูปแบบข้อมูลอาจเปลี่ยน)");
    return { points: out, areas: [], warnings: [] };
  };

  /* 5) ONWR (สทนช.) water-risk platform – flood warning / watch per province → amphoe, today (undocumented: opt-in).
   * Field names are not published, so rows are read by shape: a 2/4/6-digit area code plus a status text or risk areas. */
  const ONWR = "https://api.waterrisk.onwr.go.th/api/v1/flood";
  function findRows(obj) {
    if (!obj || typeof obj !== "object") return [];
    for (const k of ["children", "items", "data", "rows", "list", "areas"]) {
      const v = obj[k];
      if (Array.isArray(v) && v.length && typeof v[0] === "object") return v;
      if (v && typeof v === "object" && !Array.isArray(v)) { const r = findRows(v); if (r.length) return r; }
    }
    for (const v of Object.values(obj)) if (Array.isArray(v) && v.length && typeof v[0] === "object" && rowCode(v[0])) return v;
    return [];
  }
  function rowCode(r) {
    for (const [k, v] of Object.entries(r)) if (/(adm_?code|admcode|^code$|_code$|^id$|geocode)/i.test(k) && /^\d{2,6}$/.test(String(v))) return String(v);
    return "";
  }
  function rowName(r) {
    for (const [k, v] of Object.entries(r)) if (/(name_?th|nameth|^name$|_name$)/i.test(k) && typeof v === "string") return v;
    return "";
  }
  function rowRisk(r) {
    const text = Object.entries(r).filter(([k, v]) => /status|level|risk/i.test(k) && typeof v === "string").map(([, v]) => v).join(" ");
    if (/แจ้งเตือน|warning|alert/i.test(text)) return "แจ้งเตือน";
    if (/เฝ้าระวัง|watch/i.test(text)) return "เฝ้าระวัง";
    if (/ปกติ|normal/i.test(text)) return "";
    let area = 0, tb = 0;
    for (const [k, v] of Object.entries(r)) {
      const n = parseFloat(v);
      if (!isFinite(n)) continue;
      if (/(warn|watch|risk)/i.test(k) && /(area|km|rai)/i.test(k)) area += n;
      if (/tambons?_?at_?risk|tambonsatrisk/i.test(k)) tb += n;
    }
    return area > 0 || tb > 0 ? "เฝ้าระวัง" : "";
  }
  RW.onwrRows = (data) => findRows(data).map((r) => ({ code: rowCode(r), name: rowName(r), risk: rowRisk(r) })).filter((r) => r.code);

  RW.fetchONWR = async function (ctx) {
    const get = (code) => getJSON(`${ONWR}?${code ? "adm_code=" + code + "&" : ""}day=0`);
    let provs = [...new Set(ctx.zones.map((z) => z.pcode).filter(Boolean))];
    try {   // one national call first, then only the provinces it flags
      const nat = RW.onwrRows(await get(""));
      const p2 = nat.filter((r) => r.code.length === 2);
      if (p2.length) provs = p2.filter((r) => r.risk).map((r) => r.code);
    } catch (e) { /* fall back to asking every province */ }
    const out = [], now = Date.now();
    let ok = 0, lastErr = null;
    for (const pc of provs) {
      try {
        const rows = RW.onwrRows(await get(pc)).filter((r) => r.code.length === 4 && r.risk);
        ok++;
        for (const r of rows) {
          out.push({ source: "สทนช. (ONWR)", title: `สทนช.: ${r.risk}น้ำท่วม ${r.name ? (pc === "10" ? "เขต" : "อ.") + r.name.replace(/^(เขต|อำเภอ|อ\.)\s*/, "") : r.code} (วันนี้)`,
            detail: "พื้นที่เสี่ยงน้ำท่วมจากแพลตฟอร์มติดตามภัยพิบัติของ สทนช. ระดับอำเภอ", provinces: [], amps: [r.code], issued: now, expires: now + 3 * H,
            link: "https://waterrisk.onwr.go.th/map" });
        }
      } catch (e) { lastErr = e; }
      await new Promise((res) => setTimeout(res, 250));   // be gentle with an undocumented service
    }
    if (!ok && lastErr) throw lastErr;
    return { points: [], areas: [], warnings: out };
  };

  /* 6) Department of Highways – HDMS road incidents (no documented API; off until permission is given).
   * dashboard  → open incidents on national highways: road_code, section_code, km_start/km_end, flood_level,
   *              lane_closure_color (green = passable, red = closed), lat/lng.
   * section-km → the road line for that km range (GeoJSON LineString), drawn on the map.
   * Reporter name and phone number are in the feed; they are never copied. */
  const HDMS = "https://hdms.doh.go.th/internal-api/public";
  const ymd = (t) => new Date(t + 7 * H).toISOString().slice(0, 10);   // Thai calendar date
  /* true = passable, false = closed, null = can't tell (shown as "ไม่ทราบ", never as passable) */
  function hdmsPassable(r) {
    const c = String(r.lane_closure_color || "").replace("#", "");
    if (/^[0-9a-f]{6}$/i.test(c)) {
      const R = parseInt(c.slice(0, 2), 16), G = parseInt(c.slice(2, 4), 16);
      if (R > 150 && G < 120) return false;          // red pin: road closed
      if (G > 150 && R < 120) return true;           // green pin: passable
    }
    if (r.cause_of_roads_closure_id != null && r.cause_of_roads_closure_id !== "") return false;   // a closure cause is recorded
    const t = String(r.road_closure_text || r.section_status || "");
    if (/ผ่านไม่ได้|(?<!เ)ปิด|ขาด|ห้ามผ่าน/.test(t)) return false;   // "ปิด" but not "เปิด"
    if (/ผ่านได้|เปิดการจราจร|เปิดให้สัญจร/.test(t)) return true;
    return null;
  }
  /* HDMS groups reports as: ภัยพิบัติ (อุทกภัย, ดินโคลนถล่ม, วาตภัย, ไฟป่าและหมอกควัน, ภัยแล้ง, ก่อวินาศกรรม, ทุ่นระเบิด),
   * อุบัติเหตุ, and เปิด/ปิดช่องจราจร. The panel shows one short label per incident. */
  RW.hdmsKind = function (text) {
    const t = String(text || "");
    if (/อุทกภัย|น้ำท่วม|น้ำหลาก/.test(t)) return "อุทกภัย";
    if (/ดินโคลน|ดินสไลด์|ดินถล่ม|ตลิ่งพัง|ถนนทรุด/.test(t)) return "ดินโคลนถล่ม";
    if (/วาตภัย|พายุ|ต้นไม้ล้ม/.test(t)) return "วาตภัย";
    if (/ไฟป่า|หมอกควัน/.test(t)) return "ไฟป่า/หมอกควัน";
    if (/ภัยแล้ง/.test(t)) return "ภัยแล้ง";
    if (/อุบัติเหตุ|ชน/.test(t)) return "อุบัติเหตุ";
    if (/ปิด|เปิด.*จราจร|ช่องจราจร|ซ่อม|ก่อสร้าง/.test(t)) return "ปิด/เปิดช่องจราจร";
    return "";
  };
  function lineFrom(geom) {
    // GeoJSON is [lng, lat]; check anyway (Thailand: lng 97–106, lat 5–21 never overlap)
    let c = geom && (geom.type === "MultiLineString" ? [].concat(...geom.coordinates) : geom.coordinates);
    if (!Array.isArray(c) || c.length < 2) return null;
    if (c[0][0] < 30) c = c.map(([a, b]) => [b, a]);
    const step = Math.max(1, Math.ceil(c.length / 300));   // keep at most ~300 points per line
    const out = c.filter((_, i) => i % step === 0 || i === c.length - 1).map(([x, y]) => [+x.toFixed(6), +y.toFixed(6)]);
    return out.length >= 2 ? out : null;
  }
  RW.fetchHDMS = async function (ctx) {
    const now = Date.now();
    // same query as the HDMS dashboard: today + status=open returns every incident still open today,
    // including ones that began weeks ago (e.g. a landslide since 30 Sep)
    const q = new URLSearchParams({ start: ymd(now), end: ymd(now), searchText: "", division: "", district: "", depot: "",
      province: "", amphoe: "", tambon: "", incidentType: "", status: "open", floodLevel: "", passage: "all" });
    const list = await getJSON(`${HDMS}/dashboard?${q}`);
    if (!Array.isArray(list)) throw new Error("รูปแบบข้อมูลไม่ตรงกับที่คาด");
    const roads = [];
    for (const r of list) {
      if (r.publish === false || r.status === false || r.end_date) continue;   // only published, still-open incidents
      const lat = parseFloat(r.latitude), lng = parseFloat(r.longitude);
      if (!isFinite(lat) || !isFinite(lng)) continue;
      const lvl = parseFloat(r.flood_level);
      roads.push({
        source: "กรมทางหลวง (HDMS)", lat, lng,
        road: r.road_code ? `ทล.${String(r.road_code).replace(/^0+/, "")}` : "",
        roadCode: r.road_code || "", sectionCode: r.section_code || "",
        km: r.km_start ? `กม.${r.km_start}${r.km_end && r.km_end !== r.km_start ? `–${r.km_end}` : ""}` : "",
        kmStart: r.km_start || "", kmEnd: r.km_end || r.km_start || "",
        section: r.section_name || "", type: r.incident_type_text || "", kind: RW.hdmsKind(`${r.incident_type_text || ""} ${r.case_name || ""}`), title: r.case_name || r.incident_type_text || "เหตุบนทางหลวง",
        detail: r.cause_of_accident || "", bypass: r.bypass_desc || "",
        bypassLink: /^https?:\/\//.test(r.bypass_link || "") ? r.bypass_link : "",
        since: Date.parse(r.start_date) || null, tambon: r.tambon || "",
        closure: r.road_closure_text || "", lanesClosed: Number(r.unavailable_lane) || 0,   // e.g. "ทางขาด", 2 lanes
        level: isFinite(lvl) && lvl > 0 ? `${lvl} ซม.` : "", passable: hdmsPassable(r),
        province: r.province || "", amphoe: r.amphoe || "",
        time: Date.parse(r.updated_date || r.approved_date || r.report_date || r.start_date) || null, id: r.case_id || r.gid,
      });
    }
    // road lines for each incident (a missing line just means the point is shown without it)
    for (const x of roads) {
      if (!x.roadCode || !x.sectionCode || !x.kmStart) continue;
      try {
        const s = new URLSearchParams({ road_code: x.roadCode, section_code: x.sectionCode, km_start: x.kmStart, km_end: x.kmEnd });
        const g = await getJSON(`${HDMS}/section-km?${s}`);
        x.line = lineFrom(g && (g.geom || g.geometry || g));
      } catch (e) { /* keep the point */ }
      await new Promise((r) => setTimeout(r, 150));
    }
    return { points: [], areas: [], warnings: [], roads };
  };

  /* River water levels (ThaiWater waterlevel_load, ~800 telemetry stations of HII, RID and others, no key).
     Per station: level (m MSL), lowest bank, % of the channel ("storage_percent"), situation 1–5 (5 = over the bank),
     metres below/over the bank, time, previous reading. Only today's readings are kept. */
  RW.parseWaterLevels = function (j, now) {
    const list = (j && j.waterlevel_data && j.waterlevel_data.data) || [], out = [];
    const today = new Date((now || Date.now()) + 7 * 3600e3).toISOString().slice(0, 10);
    for (const r of list) {
      const s = r.station || {}, lat = +s.tele_station_lat, lng = +s.tele_station_long, wl = parseFloat(r.waterlevel_msl);
      if (!isFinite(lat) || !isFinite(lng) || !lat || !isFinite(wl)) continue;
      const at = String(r.waterlevel_datetime || "");
      if (at.slice(0, 10) !== today) continue;   // a station that hasn't reported today says nothing about now
      const prev = parseFloat(r.waterlevel_msl_previous), pct = parseFloat(r.storage_percent), diff = parseFloat(r.diff_wl_bank), g = r.geocode || {};
      out.push({ id: s.id, name: (s.tele_station_name && (s.tele_station_name.th || s.tele_station_name.en)) || "สถานีวัดน้ำ",
        river: r.river_name || "", lat: +lat.toFixed(5), lng: +lng.toFixed(5), wl, bank: isFinite(+s.min_bank) ? +s.min_bank : null,
        pct: isFinite(pct) ? pct : null, level: r.situation_level || null, diff: isFinite(diff) ? diff : null,
        over: /ล้น/.test(r.diff_wl_bank_text || "") || (isFinite(pct) && pct > 100), at, trend: isFinite(prev) ? +(wl - prev).toFixed(2) : null,
        amp: g.amphoe_name && g.amphoe_name.th, prov: g.province_name && g.province_name.th });
    }
    return out;
  };
  RW.fetchRivers = async function () {
    const rivers = RW.parseWaterLevels(await getJSON("https://api-v3.thaiwater.net/api/v1/thaiwater30/public/waterlevel_load"));
    if (!rivers.length) throw new Error("ไม่พบสถานีที่รายงานวันนี้");
    return { points: [], warnings: [], rivers };
  };

  /* The team's flood job (GitHub Actions, every 15 minutes) fetches HDMS, ThaiWater road sensors and Longdo once for
     everybody and publishes flood.json next to bans.json. Each copy of the extension reads that file; only when it is
     missing or older than CENTRAL_MAX_MIN does it fetch the source itself (and then at most once an hour). */
  RW.FLOOD_URL_DEFAULT = "https://sutat9631-ai.github.io/route-watch-bans/flood.json";
  RW.CENTRAL_MAX_MIN = 45;
  RW.floodUrl = (settings) => {
    const b = ((settings && settings.banUrl) || "").trim();
    return /bans\.json(\?.*)?$/.test(b) ? b.replace(/bans\.json(\?.*)?$/, "flood.json") : RW.FLOOD_URL_DEFAULT;
  };
  RW.centralFlood = function (ctx) {
    if (!ctx.central) ctx.central = (async () => {
      const j = await getJSON(RW.floodUrl(ctx.settings) + "?t=" + Math.floor(Date.now() / 60000));
      if (!j || !j.sources || !j.generated) throw new Error("flood.json: รูปแบบไม่ตรง");
      if (Date.now() - j.generated > RW.CENTRAL_MAX_MIN * 60000) throw new Error("flood.json เก่าเกินไป");
      return j;
    })();
    return ctx.central;
  };
  /* a source's result from flood.json, with this user's own filters (the job keeps everything ≥ 1 cm, 7 days) */
  RW.fromCentral = function (id, j, settings) {
    const s = j.sources[id];
    if (!s || !s.ok || !s.result) return null;
    const r = Object.assign({ points: [], areas: [], warnings: [] }, s.result);
    const cm = (v) => { const n = parseFloat(String(v || "").replace(/[^\d.]/g, "")); return isFinite(n) ? n : 0; };
    if (id === "thaiwater") { const min = Number(settings.thresholdCm || 10); r.points = r.points.filter((p) => cm(p.level) >= min); }
    if (id === "longdo") { const maxAge = Math.max(1, Number(settings.maxAgeDays || 3)) * 24 * H, now = Date.now(); r.points = r.points.filter((p) => p.time && now - p.time <= maxAge); r.roadEvents = (r.roadEvents || []).filter((e) => e.stop >= now); }
    return Object.assign(r, { via: "github", sourceAt: s.at || j.generated });
  };
  const viaGitHub = (id, direct) => async function (ctx) {
    let j = null;
    try { j = await RW.centralFlood(ctx); } catch (e) { ctx.centralErr = String(e.message || e); }
    const r = j && RW.fromCentral(id, j, ctx.settings);
    if (r) return r;
    // the team file has no good copy of this source: ask the source directly, but at most once an hour per browser
    const c = ctx.cache && ctx.cache[id];
    if (c && c.result && c.result.via === "direct" && Date.now() - c.at < 60 * 60000) return Object.assign({}, c.result, { reused: true });
    return Object.assign(await direct(ctx), { via: "direct" });
  };

  RW.SOURCES = [
    { id: "tmd", name: "ประกาศเตือนภัย กรมอุตุนิยมวิทยา", official: true, run: RW.fetchTMD, everyMin: 60 },
    { id: "gistda", name: "น้ำท่วมจากดาวเทียม GISTDA (3 วัน)", official: true, run: RW.fetchGISTDA, everyMin: 60 },
    { id: "thaiwater", name: "เซนเซอร์น้ำบนถนน สสน. (ThaiWater)", official: false, run: viaGitHub("thaiwater", RW.fetchThaiWater), direct: RW.fetchThaiWater },
    { id: "longdo", name: "เหตุการณ์น้ำท่วม Longdo / iTIC", official: false, run: viaGitHub("longdo", RW.fetchLongdo), direct: RW.fetchLongdo },
    { id: "onwr", name: "พื้นที่เตือนน้ำท่วม สทนช. (รายอำเภอ)", official: false, run: RW.fetchONWR, everyMin: 60 },
    { id: "hdms", name: "สถานะทางหลวง กรมทางหลวง (HDMS)", official: false, run: viaGitHub("hdms", RW.fetchHDMS), direct: RW.fetchHDMS },
    { id: "rivers", name: "ระดับน้ำในแม่น้ำ สสน. (ThaiWater)", official: false, run: RW.fetchRivers, everyMin: 60 },
  ];
})(typeof self !== "undefined" ? self : globalThis);
