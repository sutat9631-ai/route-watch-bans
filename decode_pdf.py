"""Read the text of a Royal Gazette (ราชกิจจานุเบกษา) PDF.
The body is a Ghostscript-made form whose Thai font (TH Sarabun PSK, Identity-H) has a broken ToUnicode map, so pdftotext gives
garbage and OCR misreads Thai digits. The CIDs are glyph ids of the embedded subset; each glyph's outline is matched against the
real TH Sarabun PSK fonts, whose cmap gives the true character. Unknown glyphs come out as '?'."""
import sys, io, re, hashlib, glob, os
from pypdf import PdfReader
from pypdf.generic import ContentStream, ByteStringObject
import pypdf.generic._utils as _pu, pypdf.generic._data_structures as _pds
_orig_cso = _pu.create_string_object
def _safe_cso(string, forced_encoding=None):   # a few documents have strings pypdf cannot decode as text: keep the bytes
    try: return _orig_cso(string, forced_encoding)
    except Exception: return ByteStringObject(string if isinstance(string, bytes) else str(string).encode("latin-1", "replace"))
_pu.create_string_object = _safe_cso
for _m in (_pds,):
    if hasattr(_m, "create_string_object"): _m.create_string_object = _safe_cso
from fontTools.ttLib import TTFont

REF_DIR = os.environ.get("SARABUN_DIR", os.path.join(os.path.dirname(__file__), "fonts"))

def outline_key(glyf, name):
    try:
        g = glyf[name]
        coords, ends, flags = g.getCoordinates(glyf)
    except Exception:
        return None
    if not len(coords):
        return None
    pts = [(int(x), int(y)) for x, y in coords]
    return hashlib.md5(repr((pts, list(ends))).encode()).hexdigest()

_ref = None
def ref_map():
    global _ref
    if _ref is not None: return _ref
    _ref = {}
    for f in sorted(glob.glob(os.path.join(REF_DIR, "*.ttf"))):
        t = TTFont(f); gs = t["glyf"]; rev = {}
        for cp, name in t.getBestCmap().items():
            rev.setdefault(name, chr(cp))
        # alternates without a cmap entry (shifted tone marks, ญ/ฐ without descender…): uniXXXX.xxx names
        for name in t.getGlyphOrder():
            if name not in rev:
                m = re.match(r"uni([0-9A-F]{4})", name)
                if m: rev[name] = chr(int(m.group(1), 16))
        for name, ch in rev.items():
            k = outline_key(gs, name)
            if k: _ref.setdefault(k, ch)
    return _ref

PUA = {chr(0xF700 + i): c for i, c in enumerate("ฐ\u0e34\u0e35\u0e36\u0e37\u0e48\u0e49\u0e4a\u0e4b\u0e4c\u0e48\u0e49\u0e4a\u0e4b\u0e4cญ\u0e31\u0e47\u0e48\u0e49\u0e4a\u0e4b\u0e4c\u0e38\u0e39\u0e3a")}   # Microsoft Thai positional forms
_names = None
def ref_names():
    """PUA char → glyph name, and the glyph order, of the regular reference font"""
    global _names
    if _names is None:
        t = TTFont(os.path.join(REF_DIR, "THSarabunPSK Regular.ttf"))
        _names = {chr(cp): n for cp, n in t.getBestCmap().items() if 0xF700 <= cp <= 0xF71F}; _names["_order"] = t.getGlyphOrder()
    return _names

def font_decoder(fobj):
    """CID (=GID) → text for one embedded Type0 font."""
    d = fobj["/DescendantFonts"][0].get_object(); fd = d["/FontDescriptor"].get_object()
    t = TTFont(io.BytesIO(fd["/FontFile2"].get_object().get_data())); gs = t["glyf"]; order = t.getGlyphOrder()
    ref = ref_map(); hm = t["hmtx"].metrics
    names = ref_names()
    def by_name(n):   # uni0E49.alt2 → ้ (Ghostscript keeps the original glyph ids, so the reference font's name at that id works too)
        m = re.match(r"uni([0-9A-F]{4})", n or "")
        if m: return chr(int(m.group(1), 16))
        return {"space": " "}.get(n)
    def dec(gid):
        if gid >= len(order): return "?"
        name = order[gid]; k = outline_key(gs, name)
        if k is None: return " " if hm.get(name, (0,))[0] > 0 else ""
        ch = ref.get(k)
        if ch is None or 0xF700 <= ord(ch) <= 0xF71F: ch = by_name(names.get(ch) if ch else None) or by_name(names_gid(gid)) or ch
        return ch if ch and not (0xF700 <= ord(ch) <= 0xF71F) else (PUA.get(ch, "?") if ch else "?")
    def names_gid(gid): return names["_order"][gid] if gid < len(names["_order"]) else None
    c2g = d.get("/CIDToGIDMap")
    c2g = c2g.get_object().get_data() if c2g is not None and hasattr(c2g.get_object(), "get_data") else None
    def gid_of(cid):   # a CIDToGIDMap stream renumbers glyphs in some documents
        return (c2g[2 * cid] << 8 | c2g[2 * cid + 1]) if c2g and 2 * cid + 1 < len(c2g) else cid
    cache = {}
    return lambda cid: cache.setdefault(cid, dec(gid_of(cid)))

def page_text(pg, reader):
    """Text of one page, one line per text line (a new line when the pen moves down)."""
    out = []
    def walk(res, stream_obj):
        res = res.get_object() if hasattr(res, "get_object") else res
        fonts = {}
        fd_ = res.get("/Font") or {}
        for k, v in (fd_.get_object() if hasattr(fd_, "get_object") else fd_).items():
            f = v.get_object()
            if f.get("/Subtype") != "/Type0":   # simple fonts carry the ASCII bits (. + / digits) as plain bytes
                fonts[k] = ("simple", None); continue
            try: fonts[k] = font_decoder(f)
            except Exception: fonts[k] = lambda cid: PUA.get(chr(cid), chr(cid)) if cid >= 32 else ""   # TCPDF header font: CID = Unicode
        cur = None; line = []
        def flush():
            if line: out.append("".join(line)); line.clear()
        def show(sb):
            dec = fonts.get(cur)
            b = getattr(sb, "original_bytes", None) or (sb if isinstance(sb, bytes) else str(sb).encode("latin-1", "replace"))
            if isinstance(dec, tuple): line.append("".join(chr(c) for c in b if 32 <= c < 127))
            elif dec: line.append("".join(dec((b[i] << 8) | b[i + 1]) for i in range(0, len(b) - 1, 2)))
            elif b.strip() == b"": line.append(" ")
        for ops, op in ContentStream(stream_obj, reader).operations:
            if op == b"Tf": cur = ops[0]
            elif op in (b"Td", b"TD"):
                if abs(float(ops[1])) >= 1: flush()
            elif op in (b"Tm", b"T*", b"'", b'"'): flush()
            elif op == b"Tj": show(ops[0])
            elif op == b"TJ":
                for x in ops[0]:
                    if isinstance(x, (bytes, str)) or hasattr(x, "original_bytes"): show(x)
                    elif float(x) < -250: line.append(" ")   # a wide gap inside the line is a space
            elif op == b"Do":
                xd = res.get("/XObject") or {}; xo = (xd.get_object() if hasattr(xd, "get_object") else xd).get(ops[0])
                if xo is not None and xo.get_object().get("/Subtype") == "/Form":
                    flush(); xo = xo.get_object(); walk(xo.get("/Resources", {}), xo)
        flush()
    walk(pg["/Resources"], pg.get_contents())
    return "\n".join(l for l in out if l.strip())

def pdf_text(path):
    r = PdfReader(path); t = "\n".join(page_text(p, r) for p in r.pages)
    return t.replace("\u0e4d\u0e32", "\u0e33")   # ํ + า → ำ

if __name__ == "__main__":
    for p in sys.argv[1:]: print("=====", p); print(pdf_text(p))
