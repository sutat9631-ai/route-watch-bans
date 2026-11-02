"""Thai tambon names → centroid, bbox and a simplified outline.
GADM 4.1 level 3 (aeff60/thailand-tambon-geojson) has outlines with English names only; thailand-geography-json has the
Thai names with the same English spelling (mostly). Joined on province + district + tambon English names, loosely compared."""
import json, re, sys, difflib
gadm, geo, out = sys.argv[1], sys.argv[2], sys.argv[3]
def k(s): return re.sub(r"[^a-z]", "", (s or "").lower().replace("amphoe", "").replace("mueang", "muang").replace("kh", "k").replace("ph", "p").replace("th", "t").replace("ch", "c"))
G = json.load(open(gadm))["features"]; T = json.load(open(geo))
prov = {}
for f in G:
    p = f["properties"]; prov.setdefault(k(p["NAME_1"]), []).append(f)
def ring_simplify(r, tol=0.002):
    if len(r) < 8: return r
    out = [r[0]]
    for x in r[1:]:
        if abs(x[0] - out[-1][0]) + abs(x[1] - out[-1][1]) > tol: out.append(x)
    return out
def outline(g):
    polys = g["coordinates"] if g["type"] == "MultiPolygon" else [g["coordinates"]]
    big = max(polys, key=lambda p: len(p[0]))
    return [[round(x, 4), round(y, 4)] for x, y in ring_simplify(big[0])]
res, miss = {}, 0
for t in T:
    cands = prov.get(k(t["provinceNameEn"])) or []
    if not cands:
        best = difflib.get_close_matches(k(t["provinceNameEn"]), prov.keys(), 1, 0.7); cands = prov.get(best[0], []) if best else []
    dist = [f for f in cands if k(f["properties"]["NAME_2"]) == k(t["districtNameEn"])] or \
           [f for f in cands if difflib.SequenceMatcher(None, k(f["properties"]["NAME_2"]), k(t["districtNameEn"])).ratio() > 0.8]
    pool = dist or cands
    names = {k(f["properties"]["NAME_3"]): f for f in pool}
    m = names.get(k(t["subdistrictNameEn"]))
    if not m:
        b = difflib.get_close_matches(k(t["subdistrictNameEn"]), names.keys(), 1, 0.82 if dist else 0.92); m = names[b[0]] if b else None
    if not m: miss += 1; continue
    ring = outline(m["geometry"]); xs = [p[0] for p in ring]; ys = [p[1] for p in ring]
    key = f'{t["provinceNameTh"]}|{t["districtNameTh"]}|{t["subdistrictNameTh"]}'
    res[key] = {"c": [round(sum(xs) / len(xs), 4), round(sum(ys) / len(ys), 4)], "bb": [min(xs), min(ys), max(xs), max(ys)], "ring": ring}
json.dump(res, open(out, "w"), ensure_ascii=False, separators=(",", ":"))
print("tambon", len(T), "matched", len(res), "missing", miss)
