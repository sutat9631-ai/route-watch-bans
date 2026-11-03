/* Route Watch – flood reports from several sources merged into events on the road, with a status and, per vehicle
 * class, whether it can pass. Shared by the GitHub job (flood/run.js → flood.json) and the side panel (route card).
 *
 * item  { src, official, lat, lng, levelCm|null, passable: true|false|null, time|null, title }
 * event { lat, lng, levelCm, passable, status, sources:[item…], veh:{ pickup:"ok"|"warn"|"stop"|"?", … } }
 * status: "confirmed" = a fresh official report, or 2+ different sources agree
 *         "pending"   = one fresh source that is not official
 *         "conflict"  = fresh water levels more than 20 cm apart
 *         "stale"     = every report is older than its source's life time
 */
(function (root) {
  const RW = root.RW || (root.RW = {});
  const H = 3600e3;

  /* water depth (cm) per class: below [0] passes, [0]–[1] take care, above [1] do not drive through.
     Starting values, to be confirmed by the company's own driving rules. */
  RW.FLOOD_VEH = { pickup: [15, 30], t6: [25, 45], t10: [30, 50], trailer: [30, 50], container: [25, 40] };
  /* how much a source counts and how long one report stays fresh */
  RW.FLOOD_SRC = {
    hdms: { w: 0.9, ttlH: 12, official: true, name: "กรมทางหลวง" },
    thaiwater: { w: 0.8, ttlH: 2, official: false, name: "เซนเซอร์ สสน." },
    longdo: { w: 0.4, ttlH: 12, official: false, name: "Longdo" },
  };
  RW.FLOOD_MERGE_KM = 0.5;
  RW.FLOOD_CONFLICT_CM = 20;

  RW.levelCm = (s) => { const n = parseFloat(String(s == null ? "" : s).replace(/[^\d.]/g, "")); return isFinite(n) && n > 0 ? n : null; };

  /* per class: "stop" | "warn" | "ok" | "?" (depth not known) */
  RW.vehFlood = function (levelCm, passable) {
    const out = {};
    for (const [k, [a, b]] of Object.entries(RW.FLOOD_VEH)) {
      out[k] = passable === false ? "stop" : levelCm == null ? (passable === true ? "ok" : "?") : levelCm > b ? "stop" : levelCm >= a ? "warn" : "ok";
    }
    return out;
  };

  /* the source records (as lib/sources.js returns them) → items */
  RW.floodItems = function (bySrc) {
    const out = [];
    for (const r of (bySrc.hdms && bySrc.hdms.roads) || []) {
      const lvl = RW.levelCm(r.level);
      if (!(r.kind === "อุทกภัย" || lvl != null)) continue;   // landslides, crashes: not water
      out.push({ src: "hdms", official: true, lat: r.lat, lng: r.lng, levelCm: lvl, passable: r.passable == null ? null : r.passable, time: r.time || null, title: [r.road, r.km].filter(Boolean).join(" ") || r.title || "" });
    }
    for (const id of ["thaiwater", "longdo"]) for (const p of (bySrc[id] && bySrc[id].points) || []) {
      out.push({ src: id, official: false, lat: p.lat, lng: p.lng, levelCm: RW.levelCm(p.level), passable: null, time: p.time || null, title: p.title || "", approx: !!p.approx });
    }
    return out;
  };
  /* the source of a point/road already in rw_state (its "source" label) */
  RW.floodSrcOf = (label) => (/HDMS|กรมทางหลวง/.test(label || "") ? "hdms" : /สสน|ThaiWater/i.test(label || "") ? "thaiwater" : /Longdo|iTIC/i.test(label || "") ? "longdo" : "");

  const fresh = (it, now) => { const s = RW.FLOOD_SRC[it.src]; return !!(s && it.time && now - it.time <= s.ttlH * H); };
  const km = (a, b) => RW.distKm ? RW.distKm(a.lat, a.lng, b.lat, b.lng) : Math.hypot((a.lat - b.lat) * 110.57, (a.lng - b.lng) * 111.32 * Math.cos((a.lat * Math.PI) / 180));

  /* one event from items already grouped */
  RW.floodEvent = function (items, now) {
    now = now || Date.now();
    const live = items.filter((i) => fresh(i, now)), use = live.length ? live : items;
    const w = (i) => (RW.FLOOD_SRC[i.src] || { w: 0 }).w;
    const byLvl = use.filter((i) => i.levelCm != null).sort((a, b) => w(b) - w(a) || (b.time || 0) - (a.time || 0));
    const levelCm = byLvl.length ? byLvl[0].levelCm : null;
    const pass = use.filter((i) => i.passable != null).sort((a, b) => (b.time || 0) - (a.time || 0));
    const passable = pass.length ? pass[0].passable : null;
    const lv = live.filter((i) => i.levelCm != null).map((i) => i.levelCm), srcs = new Set(live.map((i) => i.src));
    const status = !live.length ? "stale" : lv.length > 1 && Math.max(...lv) - Math.min(...lv) > RW.FLOOD_CONFLICT_CM ? "conflict"
      : live.some((i) => i.official) || srcs.size >= 2 ? "confirmed" : "pending";
    const at = byLvl[0] || use.find((i) => !i.approx) || use[0];
    const latest = Math.max(0, ...items.map((i) => i.time || 0)) || null;
    return { lat: at.lat, lng: at.lng, levelCm, levels: lv, passable, status, latest, sources: items, veh: RW.vehFlood(levelCm, passable) };
  };

  /* items → events: reports within FLOOD_MERGE_KM of each other (single link) are one place */
  RW.floodEvents = function (items, now) {
    const groups = [];
    for (const it of items) {
      const near = groups.filter((g) => g.some((x) => km(x, it) <= RW.FLOOD_MERGE_KM));
      if (!near.length) { groups.push([it]); continue; }
      const g = near[0]; g.push(it);
      for (const o of near.slice(1)) { g.push(...o); groups.splice(groups.indexOf(o), 1); }
    }
    return groups.map((g) => RW.floodEvent(g, now));
  };

  RW.FLOOD_STATUS = { confirmed: "ยืนยันแล้ว", pending: "รอยืนยัน (แหล่งเดียว)", conflict: "ข้อมูลขัดแย้ง", stale: "ข้อมูลเก่า" };
  /* "ห้ามผ่าน: กระบะ · ระวัง: 6 ล้อ, ตู้ · ผ่านได้: 10 ล้อ, เทรลเลอร์" */
  RW.vehFloodText = function (veh) {
    const names = { pickup: "กระบะ", t6: "6 ล้อ", t10: "10 ล้อ", trailer: "เทรลเลอร์", container: "ตู้" };
    const part = (v, label) => { const ks = Object.keys(names).filter((k) => veh[k] === v); return ks.length ? `${label}: ${ks.map((k) => names[k]).join(", ")}` : ""; };
    if (Object.values(veh).every((v) => v === "?")) return "ไม่ทราบระดับน้ำ";
    return [part("stop", "ห้ามผ่าน"), part("warn", "ระวัง"), part("ok", "ผ่านได้"), part("?", "ไม่ทราบ")].filter(Boolean).join(" · ");
  };
})(typeof self !== "undefined" ? self : globalThis);
