"""Place the stretches named in a traffic regulation on the map.

highway + two tambons  → Valhalla route between the tambons, kept only where it runs on that highway (ref / road name)
highway + one tambon   → the highway's OpenStreetMap ways inside that tambon (Nominatim, bounded search)
street name (provincial rules) → that street's ways inside the province / district; trimmed between the two named
                                 junctions when Nominatim can find both, otherwise the whole street ("approx")
Everything asked is cached in data/geocache.json so a daily run only asks about new notices (Nominatim: 1 request/s)."""
import json, os, re, time, math, difflib, urllib.request, urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))
UA = os.environ.get("RW_UA", "RouteWatch-gazette/0.1 (truck-ban map for Route Watch)")
CACHE_F = os.path.join(HERE, "data", "geocache.json")
_cache = json.load(open(CACHE_F, encoding="utf8")) if os.path.exists(CACHE_F) else {}
_tambon = None
_last = [0.0]

def save_cache():
    json.dump(_cache, open(CACHE_F, "w", encoding="utf8"), ensure_ascii=False, separators=(",", ":"))

def _get(url, key):
    if key in _cache: return _cache[key]
    wait = 1.1 - (time.time() - _last[0])
    if "nominatim" in url and wait > 0: time.sleep(wait)
    for n in range(3):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": UA}), timeout=90) as r:
                v = json.load(r); break
        except Exception as e:
            v = {"error": str(e)}; time.sleep(3 * (n + 1))
    _last[0] = time.time()
    if not (isinstance(v, dict) and "error" in v and "trip" not in v): _cache[key] = v
    return v

def nominatim(params):
    p = dict(params, format="jsonv2", countrycodes="th")
    q = urllib.parse.urlencode(sorted(p.items()))
    return _get("https://nominatim.openstreetmap.org/search?" + q, "N|" + q)

def tambons():
    global _tambon
    if _tambon is None: _tambon = json.load(open(os.path.join(HERE, "data", "tambon.json"), encoding="utf8"))
    return _tambon

def clean(s): return re.sub(r"^(ตำบล|อำเภอ|จังหวัด|แขวง|เขต)", "", (s or "").strip())

def tambon_info(t, a, p):
    """(tambon, amphoe, province) → {"c":[lng,lat], "bb":[w,s,e,n], "ring":[...]|None}"""
    t, a, p = clean(t), clean(a), clean(p)
    T = tambons(); k = f"{p}|{a}|{t}"
    if k in T: return T[k]
    for kk, v in T.items():   # district renamed / moved: same tambon name in the same province
        if kk.startswith(p + "|") and kk.endswith("|" + t): return v
    r = nominatim({"q": f"{t}, {a}, {p}", "limit": "1"})
    if isinstance(r, list) and r:
        x = r[0]; bb = [float(x["boundingbox"][2]), float(x["boundingbox"][0]), float(x["boundingbox"][3]), float(x["boundingbox"][1])]
        return {"c": [float(x["lon"]), float(x["lat"])], "bb": bb, "ring": None}
    return None

def area_bbox(province, amphoe=None):
    """[w,s,e,n] of a district (or province) — OpenStreetMap boundary via Nominatim, GADM tambons as a fallback"""
    p = clean(province); a = clean(amphoe) if amphoe else None
    if p in ("กรุงเทพ", "กรุงเทพฯ"): p = "กรุงเทพมหานคร"
    qs = ([{"q": f"อำเภอ{a} จังหวัด{p}" if p != "กรุงเทพมหานคร" else f"เขต{a} กรุงเทพมหานคร", "limit": "3"}] if a else []) + [{"q": f"จังหวัด{p}" if p != "กรุงเทพมหานคร" else p, "limit": "3"}]
    for q in qs:
        r = nominatim(q)
        for x in r if isinstance(r, list) else []:
            if x.get("category") == "boundary" or x.get("type") == "administrative" or x.get("addresstype") in ("province", "city", "county", "district", "state"):
                b = x["boundingbox"]; return [float(b[2]), float(b[0]), float(b[3]), float(b[1])]
    T = tambons(); xs = [v["bb"] for k, v in T.items() if k.split("|")[0] == p and (not a or k.split("|")[1] == a)]
    if not xs: return None
    return [min(b[0] for b in xs), min(b[1] for b in xs), max(b[2] for b in xs), max(b[3] for b in xs)]

def km(a, b):
    R = 6371.0; la1, la2 = math.radians(a[1]), math.radians(b[1]); dl = math.radians(b[0] - a[0]); dp = la2 - la1
    h = math.sin(dp / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(h))

def line_km(l): return sum(km(l[i - 1], l[i]) for i in range(1, len(l)))

def decode6(s):
    out, i, lat, lng = [], 0, 0, 0
    while i < len(s):
        vals = []
        for _ in range(2):
            sh = r = 0
            while True:
                b = ord(s[i]) - 63; i += 1; r |= (b & 0x1f) << sh; sh += 5
                if b < 0x20: break
            vals.append(~(r >> 1) if r & 1 else r >> 1)
        lat += vals[0]; lng += vals[1]; out.append([round(lng / 1e6, 5), round(lat / 1e6, 5)])
    return out

def valhalla(a, b):
    q = {"locations": [{"lat": a[1], "lon": a[0]}, {"lat": b[1], "lon": b[0]}], "costing": "auto", "units": "kilometers", "language": "th-TH"}
    s = json.dumps(q, sort_keys=True)
    return _get("https://valhalla1.openstreetmap.de/route?json=" + urllib.parse.quote(s), "V|" + s)

def in_ring(pt, ring):
    x, y = pt; inside = False
    for i in range(len(ring)):
        x1, y1 = ring[i - 1]; x2, y2 = ring[i]
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1 + 1e-12) + x1: inside = not inside
    return inside

def name_match(names, ref, road):
    ns = [n.replace(" ", "") for n in (names or [])]
    r = (ref or "").replace(" ", ""); rd = re.sub(r"^ถนน", "", (road or "").replace(" ", ""))
    return any(n == r or n.endswith(rd) or (rd and rd in n) for n in ns if n)

def highway_between(seg, A, B):
    j = valhalla(A["c"], B["c"])
    if not isinstance(j, dict) or "trip" not in j: return None
    leg = j["trip"]["legs"][0]; shape = decode6(leg["shape"]); lines = []; cur = None
    for m in leg["maneuvers"]:
        ok = name_match(m.get("street_names"), seg.get("ref"), seg.get("road"))
        part = shape[m["begin_shape_index"]: m["end_shape_index"] + 1]
        if ok:
            if cur is not None and cur[-1] == part[0]: cur.extend(part[1:])
            else: cur = list(part); lines.append(cur)
        else: cur = None
    lines = [l for l in lines if line_km(l) > 0.3]
    return lines or None

def _n(s): return re.sub(r"^(ถนน|ซอย)", "", re.sub(r"[\s\-–()]", "", s or ""))

def road_ways(name, bbox, ring=None, ref=None):
    """OSM ways of a named road inside bbox [w,s,e,n] (clipped to ring if given). Only ways whose name (or ref) is that road."""
    if not bbox: return None
    want = _n(name)
    vb = f"{bbox[0]:.4f},{bbox[3]:.4f},{bbox[2]:.4f},{bbox[1]:.4f}"
    found = []
    for q in [name] + ([f"ทางหลวงแผ่นดินหมายเลข {ref}", ref] if ref else []):
        r = nominatim({"q": q, "viewbox": vb, "bounded": "1", "polygon_geojson": "1", "limit": "50"}) if q else []
        for x in r if isinstance(r, list) else []:
            g = x.get("geojson") or {}
            if x.get("category") != "highway": continue
            nm = _n(x.get("name") or x.get("display_name", "").split(",")[0])
            close = want and len(want) >= 4 and (nm.startswith(want) or (want.startswith(nm) and len(nm) >= 4) or difflib.SequenceMatcher(None, nm, want).ratio() >= 0.8)
            if not (nm == want or (ref and nm == _n(ref)) or close): continue
            segs = [g["coordinates"]] if g.get("type") == "LineString" else g.get("coordinates", []) if g.get("type") == "MultiLineString" else []
            for s in segs:
                pts = [[round(p[0], 5), round(p[1], 5)] for p in s]
                if ring: pts = [p for p in pts if in_ring(p, ring)]
                if len(pts) > 1: found.append(pts)
        if found: break
    return found or None

def trim_between(lines, a, b, pad=0.05):
    """keep the parts of lines whose projection on a→b falls between a and b"""
    ax, ay = a; bx, by = b; dx, dy = bx - ax, by - ay; L = dx * dx + dy * dy
    if L == 0: return lines
    out = []
    for l in lines:
        cur = []
        for p in l:
            t = ((p[0] - ax) * dx + (p[1] - ay) * dy) / L
            if -pad <= t <= 1 + pad: cur.append(p)
            elif cur:
                if len(cur) > 1: out.append(cur)
                cur = []
        if len(cur) > 1: out.append(cur)
    return out or None

def place_bbox(name):
    r = nominatim({"q": name, "limit": "1"})
    if isinstance(r, list) and r:
        b = r[0]["boundingbox"]; return [float(b[2]), float(b[0]), float(b[3]), float(b[1])]
    return None

def place_segment(seg, province=None, amphoe=None, within=None):
    """→ {"lines": [[[lng,lat],…],…], "how": str, "approx": bool} or None"""
    fp, tp = seg.get("from_place"), seg.get("to_place")
    if seg.get("ref") and (fp or tp):
        A = tambon_info(*fp) if fp else None; B = tambon_info(*tp) if tp else None
        if A and B and (fp != tp):
            ls = highway_between(seg, A, B)
            if ls:
                got = sum(line_km(l) for l in ls); want = seg.get("length_km") or (abs((seg.get("km_to") or 0) - (seg.get("km_from") or 0)) or None)
                return {"lines": ls, "how": "ทางหลวงระหว่างตำบลต้นทาง–ปลายทาง", "approx": bool(want and not 0.6 <= got / want <= 1.5), "km": round(got, 1)}
        T = A or B
        if T:
            ls = road_ways(seg.get("road"), T["bb"], T.get("ring"), seg.get("ref"))
            if ls: return {"lines": ls, "how": "ทางหลวงช่วงที่อยู่ในตำบล", "approx": True, "km": round(sum(line_km(l) for l in ls), 1)}
        return None
    road = re.sub(r"^(ขาเข้า|ขาออก)\s*", "", seg.get("road") or "")
    names = [n.strip() for n in re.split(r"\s+-\s+(?=ถนน|ซอย)", road) if n.strip()]
    bb = (place_bbox(f"{within} {province}") if within else None) or area_bbox(province, amphoe) or area_bbox(province)
    if not bb or not names: return None
    ls = []
    for n in names:
        n2 = n if n.startswith("ถนน") or n.startswith("ซอย") else "ถนน" + n
        ls += road_ways(n2, bb) or []
    if not ls: return None
    a = seg.get("from_text"); b = seg.get("to_text")
    ends = []
    for t in (a, b):
        t = re.split(r"\s*\(|\s+ตัด|\s+กม\.", t or "")[0].strip()
        r = nominatim({"q": t, "viewbox": f"{bb[0]:.4f},{bb[3]:.4f},{bb[2]:.4f},{bb[1]:.4f}", "bounded": "1", "limit": "1"}) if t else []
        ends.append([float(r[0]["lon"]), float(r[0]["lat"])] if isinstance(r, list) and r else None)
    if all(ends):
        tr = trim_between(ls, ends[0], ends[1])
        if tr: return {"lines": tr, "how": "ถนนช่วงระหว่างจุดที่ประกาศระบุ", "approx": True, "km": round(sum(line_km(l) for l in tr), 1)}
    return {"lines": ls, "how": "ทั้งสาย (หาจุดเริ่ม–สิ้นสุดไม่ได้)", "approx": True, "km": round(sum(line_km(l) for l in ls), 1)}
