/* Route Watch – geometry helpers shared by the service worker, content script and side panel.
 * Zone format (data/zones.json): { id, name, province, region, bbox:[minLng,minLat,maxLng,maxLat],
 *   center:[lng,lat], area, polys:[ [outerRing, holeRing...], ... ] }, ring = [[lng,lat], ...]
 */
(function (root) {
  const RW = root.RW || (root.RW = {});

  function inRing(lng, lat, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
      if ((yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  function inBBox(lng, lat, b) {
    return lng >= b[0] && lng <= b[2] && lat >= b[1] && lat <= b[3];
  }

  RW.zoneContains = function (zone, lng, lat) {
    if (!inBBox(lng, lat, zone.bbox)) return false;
    for (const poly of zone.polys) {
      if (inRing(lng, lat, poly[0]) && !poly.slice(1).some((h) => inRing(lng, lat, h))) return true;
    }
    return false;
  };


  /* The sub-district / district of a point, from data/places.json ([name, "ต"|"อ", amphoe, province, [zone ids], bbox]).
     distPolys (optional): that province's district outlines (data/areas/<pcode>.json, {amphoe: multipolygon}) — with them
     the district is exact; the sub-district is the smallest one whose box holds the point (close, not exact). */
  RW.placeAt = function (places, lng, lat, distPolys) {
    if (!places || !places.length) return null;
    const area = (b) => (b[2] - b[0]) * (b[3] - b[1]);
    let amps = places.filter((p) => p[1] === "อ" && inBBox(lng, lat, p[5]));
    if (distPolys) {
      const exact = amps.filter((p) => { const mp = distPolys[p[0]]; return mp && mp.some((poly) => inRing(lng, lat, poly[0]) && !poly.slice(1).some((h) => inRing(lng, lat, h))); });
      if (exact.length) amps = exact;
    }
    amps.sort((a, b) => area(a[5]) - area(b[5]));
    const amp = amps[0] || null;
    const tams = places.filter((p) => p[1] === "ต" && inBBox(lng, lat, p[5]) && (!amp || (p[2] === amp[0] && p[3] === amp[3]))).sort((a, b) => area(a[5]) - area(b[5]));
    const tam = tams[0] || null;
    if (!amp && !tam) return null;
    const prov = (amp || tam)[3];
    return { tambon: tam ? tam[0] : null, amphoe: amp ? amp[0] : tam[2], province: prov, zone: ((amp || tam)[4] || [])[0], bkk: prov === "กรุงเทพมหานคร" };
  };
  RW.placeLabel = function (p) {
    if (!p) return "";
    if (p.bkk) return `${p.tambon ? "แขวง" + p.tambon + " " : ""}เขต${p.amphoe}`;
    return `${p.tambon ? "ต." + p.tambon + " " : ""}อ.${p.amphoe} จ.${p.province}`;
  };
  /** Zones containing a point, most specific (smallest) first. */
  RW.zonesAt = function (zones, lng, lat) {
    return zones.filter((z) => RW.zoneContains(z, lng, lat)).sort((a, b) => a.area - b.area);
  };

  function ringBBox(ring) {
    let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
    for (const [x, y] of ring) { if (x < a) a = x; if (y < b) b = y; if (x > c) c = x; if (y > d) d = y; }
    return [a, b, c, d];
  }
  RW.ringBBox = ringBBox;

  function bboxOverlap(p, q) {
    return p[0] <= q[2] && p[2] >= q[0] && p[1] <= q[3] && p[3] >= q[1];
  }
  RW.bboxOverlap = bboxOverlap;

  /** Approximate overlap test between a flood polygon (outer ring) and a zone:
   *  any flood vertex (or its centre) inside the zone, or any zone vertex inside the flood polygon. */
  RW.ringTouchesZone = function (ring, zone, bb) {
    bb = bb || ringBBox(ring);
    if (!bboxOverlap(bb, zone.bbox)) return false;
    const step = Math.max(1, Math.floor(ring.length / 60));
    for (let i = 0; i < ring.length; i += step) if (RW.zoneContains(zone, ring[i][0], ring[i][1])) return true;
    if (RW.zoneContains(zone, (bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2)) return true;
    for (const poly of zone.polys) {
      const outer = poly[0], st = Math.max(1, Math.floor(outer.length / 200));
      for (let i = 0; i < outer.length; i += st) if (inBBox(outer[i][0], outer[i][1], bb) && inRing(outer[i][0], outer[i][1], ring)) return true;
    }
    return false;
  };

  /* Web Mercator (same maths as the tile calculator): lng/lat -> world pixels at a zoom level */
  RW.project = function (lng, lat, zoom) {
    const size = 256 * Math.pow(2, zoom);
    const s = Math.sin((Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI) / 180);
    return [((lng + 180) / 360) * size, (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * size];
  };
  RW.unproject = function (x, y, zoom) {
    const size = 256 * Math.pow(2, zoom);
    const lng = (x / size) * 360 - 180;
    const n = Math.PI - (2 * Math.PI * y) / size;
    return [lng, (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)))];
  };

  /** Zoom level that fits a bbox into a viewport (used for "go to zone"). */
  RW.fitZoom = function (bbox, w, h) {
    for (let z = 16; z >= 5; z -= 0.5) {
      const a = RW.project(bbox[0], bbox[3], z), b = RW.project(bbox[2], bbox[1], z);
      if (b[0] - a[0] <= w * 0.85 && b[1] - a[1] <= h * 0.85) return z;
    }
    return 5;
  };

  RW.ROAD_KIND = { closed: "ถนนปิด", divert: "เบี่ยงจราจร", accident: "อุบัติเหตุ", breakdown: "รถเสีย" };   // Longdo road events (lib/sources.js)
  RW.STATUS = {
    flood: { label: "มีน้ำท่วม", fill: "rgba(211,58,44,0.30)", stroke: "#C0302B" },
    closed: { label: "ทางปิด", fill: "rgba(124,58,237,0.26)", stroke: "#6D28D9" },
    warn: { label: "มีประกาศเตือน", fill: "rgba(217,169,58,0.30)", stroke: "#B9861A" },
    none: { label: "ไม่พบรายงาน", fill: "rgba(61,138,98,0.10)", stroke: "#3D8A62" },
  };
})(typeof self !== "undefined" ? self : globalThis);
