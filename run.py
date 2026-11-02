"""Daily job: Royal Gazette → truck bans for Route Watch (bans.json).

1. titles of every notice (HuggingFace dataset open-law-data-thailand/soc-ratchakitcha, meta/<year>/<month>.jsonl, updated daily)
2. keep traffic-chief regulations that ban / close roads (ข้อบังคับหัวหน้าเจ้าพนักงานจราจร…)
3. new ones: PDF from ratchakitcha.soc.go.th → text (decode_pdf) → rules (extract_rules) → map lines (geocode)
4. write out/bans.json: what is in force now or later, plus standing rules; expired ones drop off after 30 days
Usage: python run.py [--months 36] [--out out/bans.json]"""
import json, os, re, sys, datetime, urllib.request, argparse, traceback
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import decode_pdf, extract_rules, geocode

HF = "https://huggingface.co/datasets/open-law-data-thailand/soc-ratchakitcha/resolve/main/"
UA = {"User-Agent": geocode.UA}
D = os.path.join(HERE, "data"); os.makedirs(os.path.join(D, "meta"), exist_ok=True); os.makedirs(os.path.join(D, "notices"), exist_ok=True); os.makedirs(os.path.join(D, "pdf"), exist_ok=True)

TITLE = re.compile(r"เจ้าพนักงานจราจร")
SKIP = re.compile(r"สาดน้ำ|เล่นน้ำ|การปลูกสร้าง|แผงลอย|ป้ายจราจร")
def category(title):
    """truck = a ban on trucks; closure = a road closed to all (events, works); exempt = lifting a truck ban; None = not for us"""
    t = title.split("ว่าด้วย", 1)[-1] if "ว่าด้วย" in title else title.split("เรื่อง", 1)[-1]
    if SKIP.search(t): return None
    if "ยกเว้นการห้าม" in t: return "exempt"
    if re.search(r"ห้ามรถบรรทุก|รถพ่วง", t): return "truck"
    if re.search(r"ห้ามรถทุกชนิด|ปิดการจราจร|ปิดเส้นทาง|ปิดถนน|ห้ามเดินรถ", t): return "closure"
    return None

def fetch(url, path, force=False):
    if os.path.exists(path) and not force: return path
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=120) as r: data = r.read()
    open(path, "wb").write(data); return path

def months(n, today):
    y, m = today.year, today.month; out = []
    for _ in range(n):
        out.append(f"{y:04d}-{m:02d}"); m -= 1
        if m == 0: y, m = y - 1, 12
    return out[::-1]

def vehicles_of(r, title):
    t = title + " " + " ".join(s.get("road", "") for s in r["segments"])
    v = {"pickup": False, "t6": False, "t10": False, "trailer": False, "container": False}
    if r["vehicles"] == "all" or "รถทุกชนิด" in title: v = dict.fromkeys(v, True)
    elif r["vehicles"] == "6+" : v.update(t6=True, t10=True, trailer=True, container=True)
    elif r["vehicles"] == "10+": v.update(t10=True, trailer=True, container=True)
    if any(w in r["also"] for w in ("รถพ่วง", "รถกึ่งพ่วง")): v.update(trailer=True, container=True)
    if not any(v.values()) and "รถบรรทุก" in title: v.update(t6=True, t10=True, trailer=True, container=True)   # "รถบรรทุก" without a size
    return v

def area_of(title):
    if "ทั่วราชอาณาจักร" in title: return {"scope": "ทั่วประเทศ", "province": None}
    if "ในทางพิเศษ" in title: return {"scope": "ทางพิเศษ", "province": None}
    if "กรุงเทพมหานคร" in title.split("ว่าด้วย")[0]: return {"scope": "จังหวัด", "province": "กรุงเทพมหานคร"}
    m = re.search(r"จังหวัด\s*(\S+?)(?:\s|\(|ว่าด้วย|$)", title.split("ว่าด้วย")[0])
    return {"scope": "จังหวัด", "province": m.group(1) if m else None}

def process(meta):
    did = meta["source_url"].rsplit("/", 1)[1].split(".")[0]
    f = os.path.join(D, "notices", did + ".json")
    if os.path.exists(f): return json.load(open(f, encoding="utf8"))
    pdf = os.path.join(D, "pdf", did + ".pdf")
    try: fetch(meta["source_url"], pdf)
    except Exception:
        fetch(HF + "pdf/" + meta["publishDate"][:4] + "/" + meta["publishDate"][:7] + "/" + meta["pdf_file"], pdf)
    text = decode_pdf.pdf_text(pdf)
    r = extract_rules.rules(text)
    title = re.sub(r"\s+", " ", meta["doctitle"]).strip()
    area = area_of(title)
    amphoe = (re.search(r"อำเภอ(\S+)", text) or [None, None])[1]
    within = (re.search(r"(เทศบาล(?:เมือง|ตำบล|นคร)\S+)", title) or [None, None])[1]
    cat = category(title)
    if cat == "closure" and not r["periods"]:   # event closures: the days named anywhere in the text
        ds = sorted({extract_rules.date_of(*g) for g in re.findall(extract_rules.DATE, extract_rules.norm(text).replace("\n", " ")) if int(g[2]) > 2560 or int(g[2]) > 2020})
        ds = [d for d in ds if d >= meta["publishDate"][:4] + "-01-01"]
        if ds: r["periods"] = [[ds[0], ds[-1]]]
        else: r["periods"] = [[meta["publishDate"], (datetime.date.fromisoformat(meta["publishDate"]) + datetime.timedelta(days=30)).isoformat()]]
    old = r["periods"] and max(p[1] for p in r["periods"]) < (datetime.date.today() - datetime.timedelta(days=30)).isoformat()
    for s in r["segments"]:
        if old: s["geo"] = None; continue   # long over: not worth asking the map services
        try: s["geo"] = geocode.place_segment(s, area["province"], amphoe, within)
        except Exception as e: s["geo"] = None; s["geo_err"] = str(e)[:120]
    if cat == "closure": r["vehicles"] = "all"
    n = {"id": did, "title": title, "published": meta["publishDate"], "url": meta["source_url"], **area, "kind": cat,
         "vehicles": vehicles_of(r, title), "hazmat": "วัตถุอันตราย" in title or "วัตถุอันตราย" in r["also"], "oil": "น้ำมัน" in title,
         "periods": r["periods"], "standing": r["standing"], "windows": r["windows"], "segments": r["segments"],
         "placed": sum(1 for s in r["segments"] if s.get("geo")), "text": text[:6000],
         "bbox": (geocode.place_bbox(f"{within} {area['province']}") if within else None) or (geocode.area_bbox(area["province"], amphoe) if area["province"] else None)}
    json.dump(n, open(f, "w", encoding="utf8"), ensure_ascii=False, indent=0)
    geocode.save_cache()
    return n

def summary(n):
    """the rule in a few lines, from the text: the banning clause, shortened"""
    t = re.sub(r"\s+", " ", extract_rules.norm(n.get("text", "")))
    for m in re.finditer(r"ข้อ\s*\d+\s+(.*?)(?=\sข้อ\s*\d+\s|$)", t):
        c = m.group(1)
        if re.search(r"ห้ามรถ|ห้ามเดินรถ|ห้าม.{0,30}เดิน|ปิดการจราจร", c) and not c.startswith(("ให้ยกเลิก", "ข้อบังคับนี้", "นับ")):
            c = re.sub(r"หนา\s*\d+\s*เลม\s*\d+.*?ราชกิจจานุเบกษา\s*\d+\s*\S+\s*\d{4}", " ", c)
            return c[:700]
    return ""

def status(n, today):
    if n["periods"]:
        start = min(p[0] for p in n["periods"]); end = max(p[1] for p in n["periods"])
        if end < today: return "expired"
        return "active" if start <= today else "upcoming"
    return "standing"

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--months", type=int, default=36); ap.add_argument("--out", default=os.path.join(HERE, "out", "bans.json"))
    a = ap.parse_args(); today = datetime.date.today(); ts = today.isoformat()
    hits, errors = [], []
    ms = months(a.months, today)
    for i, m in enumerate(ms):
        p = os.path.join(D, "meta", m + ".jsonl")
        try: fetch(HF + "meta/" + m[:4] + "/" + m + ".jsonl", p, force=i >= len(ms) - 2)   # the last two months still grow
        except Exception as e:
            if not (i == len(ms) - 1 and "404" in str(e)): errors.append(f"meta {m}: {e}")   # a new month has no file for a day or two
            if not os.path.exists(p): continue
        for line in open(p, encoding="utf8"):
            try: d = json.loads(line)
            except Exception: continue
            t = d.get("doctitle") or ""
            if TITLE.search(t) and category(t) and not d.get("is_test"): hits.append(d)
    seen, notices = set(), []
    for d in sorted(hits, key=lambda x: x["publishDate"]):
        if d["source_url"] in seen: continue
        seen.add(d["source_url"])
        try: notices.append(process(d))
        except Exception as e: errors.append(f"{d['source_url']}: {e}"); traceback.print_exc()
    # a newer regulation on the same subject replaces the older one ("ให้ยกเลิก… ที่ขัดหรือแย้ง"): keep the latest per subject
    def subject(n):
        t = re.sub(r"\(ชั่วคราว\)|ที่\s*\d+/\d+|พ\.ศ\.?\s*\d+|ประจำปี\s*\d+|\(ฉบับที่\s*\d+\)|[\d๐-๙]+|\s+", "", n["title"])
        return (n.get("province") or n.get("scope"), t)
    latest = {}
    for n in notices:
        if n["periods"]: continue
        k = subject(n)
        if k not in latest or n["published"] > latest[k]["published"]: latest[k] = n
    keep_ids = {n["id"] for n in latest.values()}
    out = []
    for n in notices:
        if not n["periods"] and n["id"] not in keep_ids: continue
        st = status(n, ts)
        if st == "expired" and max(p[1] for p in n["periods"]) < (today - datetime.timedelta(days=30)).isoformat(): continue
        if not n["kind"]: continue
        o = {k: v for k, v in n.items() if k != "text"}; o["status"] = st
        o["summary"] = summary(n)
        for s in o["segments"]: s.pop("geo_err", None)
        out.append(o)
    os.makedirs(os.path.dirname(a.out), exist_ok=True)
    res = {"updated": datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=7))).isoformat(timespec="minutes"), "source": "ราชกิจจานุเบกษา (open-law-data-thailand/soc-ratchakitcha)",
           "months": a.months, "checked": len(hits), "notices": out, "errors": errors[:20]}
    json.dump(res, open(a.out, "w", encoding="utf8"), ensure_ascii=False, separators=(",", ":"))
    print(f"titles kept {len(hits)}, notices out {len(out)}, errors {len(errors)}")
    for e in errors[:10]: print("  !", e)
    return 0 if not errors or len(out) else 1

if __name__ == "__main__": sys.exit(main())
