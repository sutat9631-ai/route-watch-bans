"""Turn the text of a traffic-chief regulation into restriction rules Route Watch can check.
Handles the common shapes: highway number + km range, road name with "ตั้งแต่ … ถึง …", date ranges, daily time windows,
vehicle class (๖ / ๑๐ ล้อขึ้นไป, รถพ่วง, วัตถุอันตราย, ทุกชนิด). Anything it cannot place is kept as text for a person."""
import re, json, sys
TH = str.maketrans("๐๑๒๓๔๕๖๗๘๙", "0123456789")
MONTHS = {m: i + 1 for i, m in enumerate("มกราคม กุมภาพันธ์ มีนาคม เมษายน พฤษภาคม มิถุนายน กรกฎาคม สิงหาคม กันยายน ตุลาคม พฤศจิกายน ธันวาคม".split())}
PAGE_HDR = re.compile(r"ห\S?น\S?า\s*\d+\s*\n?\s*เล\S?ม\s*\d+\s*\n?\s*ตอน(?:พิเศษ)?\s*\d+\s*\n?\s*[กขคง]\s*\n?\s*ราชกิจจานุเบกษา\s*\n?\s*\d+\s*\S+\s*\d{4}")
def norm(t): return PAGE_HDR.sub(" ", re.sub(r"[ \t]+", " ", t.translate(TH)))   # page headers fall in the middle of sentences
def date_of(d, m, y): y = int(y); y = y - 543 if y > 2400 else y; return f"{y:04d}-{MONTHS[m]:02d}-{int(d):02d}"
DATE = r"(\d{1,2})\s*(" + "|".join(MONTHS) + r")\s*(?:พ\.ศ\.\s*)?(\d{4})"
def km(s):
    m = re.match(r"(\d+)(?:\+(\d+))?", s.replace(" ", "")); return int(m.group(1)) + (int(m.group(2)) / 1000 if m.group(2) else 0)

def rules(text, meta=None):
    t = norm(text); flat = re.sub(r"\s*\n\s*", " ", t)
    title = flat[:220]
    veh = "10+" if re.search(r"10 ล้อขึ้นไป", flat) else "6+" if re.search(r"6 ล้อขึ้นไป", flat) else "all" if "รถทุกชนิด" in flat else None
    extra = [w for w in ("รถพ่วง", "รถกึ่งพ่วง", "วัตถุอันตราย", "รถบรรทุกน้ำมัน") if w in flat]
    kind = "exempt" if "ยกเว้นการห้าม" in title else "parking" if re.search(r"ห้ามจอด|ห้ามหยุด", title) and "เดิน" not in title else "closure" if "ปิดการจราจร" in title else "ban"
    # validity: "ตั้งแต่วัน… ที่ D เดือน Y ถึงวัน… ที่ D เดือน Y" (may repeat), else "วันถัดจากวันประกาศ"
    body = flat[flat.find("ข้อ 2"):] if "ข้อ 2" in flat else flat   # the preamble talks about holidays; the rules start at ข้อ 2
    periods = [(date_of(g[0], g[1], g[2]), date_of(g[3], g[4], g[5])) for g in re.findall(r"ตั้งแต่(?:วัน\S*)?\s*(?:ที่\s*)?" + DATE + r".{0,40}?ถึง(?:วัน\S*)?\s*(?:ที่\s*)?" + DATE, body)]
    standing = bool(re.search(r"ใช้บังคับตั้งแต่วันถัดจากวันประกาศ", flat)) and not periods
    times = re.findall(r"(\d{1,2})\.(\d{2})\s*(?:นาฬิกา|น\.)?\s*(?:ถึง|-|–)\s*(?:เวลา)?\s*(\d{1,2})\.(\d{2})\s*(?:นาฬิกา|น\.)", flat)
    windows = sorted({f"{int(a):02d}:{b}-{int(c):02d}:{d}" for a, b, c, d in times})
    segs = []
    # national highways: ทางหลวงแผ่นดินหมายเลข N … กิโลเมตรที่ A … ถึงกิโลเมตรที่ B
    for m in re.finditer(r"ถนน(\S+(?:\s*\d+)?(?:\s*-\s*\S+)?)\s*\(?ทางหลวง(?:แผ่นดิน|ชนบท)?หมายเลข\s*([A-Za-zก-ฮ]*\s*\d+)\)?\s*ตั้งแต่\s*กิโลเมตรที่\s*([\d+]+)(.{0,120}?)ถึง\s*กิโลเมตรที่\s*([\d+]+)(.{0,140}?)(?:ระยะทาง\s*(\d+)\s*กิโลเมตร|$)", flat):
        place_a = re.findall(r"ตำบล(\S+)\s*อำเภอ(\S+)\s*จังหวัด(\S+)", m.group(4)); place_b = re.findall(r"ตำบล(\S+)\s*อำเภอ(\S+)\s*จังหวัด(\S+)", m.group(6))
        segs.append({"road": m.group(1), "ref": m.group(2).replace(" ", ""), "km_from": km(m.group(3)), "km_to": km(m.group(5)),
                     "from_place": place_a[0] if place_a else None, "to_place": (place_b or place_a or [None])[0], "length_km": int(m.group(7)) if m.group(7) else None})
    # other rules: the clause that bans ("ข้อ N … ห้ามรถ …" up to the next ข้อ), split into items ("3.1", "1)") or taken whole
    if not segs:
        clause = ""
        for m in re.finditer(r"ข้อ\s*\d+\s+(.*?)(?=\sข้อ\s*\d+\s|$)", flat):
            c = m.group(1)
            if re.search(r"ห้ามรถ|ห้ามเดินรถ|ห้าม.{0,30}เดิน", c) and not c.startswith(("ให้ยกเลิก", "ข้อบังคับนี้", "นับ")): clause = c; break
        ROADW = r"(?=(?:ขาเข้า|ขาออก)?\s*(?:ถนน|ซอย|ทางหลวง|สะพาน|ทางพิเศษ|บริเวณ))"
        items = [x for x in re.split(r"(?<![\d+.,])(?:\d{1,2}\.\d{1,2}|\(?\d{1,2}\))\s+" + ROADW + r"|\s+และ" + ROADW, clause) if x and x.strip()]
        body_items = items[1:] if len(items) > 1 and not re.search(r"(?:ถนน|ซอย|ทางหลวง|สะพาน|ทางพิเศษ)\S", items[0]) else items
        for it in body_items:
            it = it.strip()
            m = re.search(r"((?:ขาเข้า|ขาออก)?\s*(?:ถนน|ซอย|ทางหลวง|สะพาน|ทางพิเศษ)[^,]{1,90}?)(?:\s+(?:ตั้งแต่|จาก)(?!เวลา)\s*(.+?)\s*(?:จน)?ถึง\s*(.+?))?(?:\s+(?:ตั้งแต่)?เวลา|\s+ระหว่างเวลา|\s+ทั้ง|\s+ตลอด|\s+ช่วงเวลา|$)", it)
            if not m: continue
            road = re.sub(r"\s+(ตลอดสาย|ทั้งสองฝั่ง|ฝั่ง\S+|ดังนี้)$", "", m.group(1).strip())
            road = re.sub(r"\s+ตำบล.*$", "", road)
            if re.search(r"ต่อไปนี้|ดังนี้$|สายต่าง", road) or len(road) < 5: continue

            seg = {"road": road[:90], "item": it[:240]}
            if m.group(2): seg["from_text"] = m.group(2).strip()[:80]
            if m.group(3): seg["to_text"] = m.group(3).strip()[:80]
            hw = re.search(r"ทางหลวง(?:แผ่นดิน|ชนบท)?\s*(?:หมายเลข)?\s*([A-Za-zก-ฮ]{0,3}\s*\d{1,5})", it)
            if hw: seg["ref"] = hw.group(1).replace(" ", "")
            k2 = re.search(r"กิโลเมตรที่\s*([\d]+(?:\s*\+\s*\d+)?).{0,60}?ถึง\s*(?:กิโลเมตรที่)?\s*([\d]+(?:\s*\+\s*\d+)?)", it)
            if k2: seg["km_from"] = km(k2.group(1).replace(" ", "")); seg["km_to"] = km(k2.group(2).replace(" ", ""))
            else:
                ka = re.search(r"(?:กม\.?|กิโลเมตร(?:ที่)?)\s*(\d+\s*\+\s*\d+|\d+)", seg.get("from_text", "")); kb = re.search(r"(?:กม\.?|กิโลเมตร(?:ที่)?)\s*(\d+\s*\+\s*\d+|\d+)", seg.get("to_text", ""))
                if ka and kb: seg["km_from"] = km(ka.group(1).replace(" ", "")); seg["km_to"] = km(kb.group(1).replace(" ", ""))
            iw = re.findall(r"(\d{1,2})[.:](\d{2})\s*(?:นาฬิกา|น\.)?\s*(?:จน|-|–)?\s*ถึง?(?:เวลา)?\s*(\d{1,2})[.:](\d{2})", it)
            if iw: seg["windows"] = sorted({f"{int(a):02d}:{b}-{int(c):02d}:{d}" for a, b, c, d in iw})
            segs.append(seg)
    named = {x["road"] for x in segs if x.get("from_text") or x.get("km_from") is not None}
    segs = [x for x in segs if x.get("from_text") or x.get("km_from") is not None or x["road"] not in named]
    return {"kind": kind, "vehicles": veh, "also": extra, "periods": periods, "standing": standing, "windows": windows, "segments": segs,
            "needs_review": not segs or any("km_from" not in s for s in segs), **(meta or {})}

if __name__ == "__main__":
    for p in sys.argv[1:]:
        print(p, json.dumps(rules(open(p, encoding="utf8").read()), ensure_ascii=False, indent=1))
