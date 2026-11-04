# Route Watch — ประกาศห้ามรถบรรทุกจากราชกิจจาฯ

ระบบดึงประกาศอัตโนมัติ ทำงานบน GitHub Actions วันละ 2 รอบ (07:30 และ 19:30 น.) แล้วเผยแพร่ไฟล์ `bans.json` บน GitHub Pages ให้ Route Watch ทุกเครื่องดึงไปใช้

## ระบบทำอะไรบ้าง
1. อ่านรายชื่อประกาศทั้งหมดของราชกิจจาฯ จากชุดข้อมูล `open-law-data-thailand/soc-ratchakitcha` บน HuggingFace (อัปเดตทุกวัน) ย้อนหลัง 36 เดือน
2. เก็บเฉพาะ "ข้อบังคับหัวหน้าเจ้าพนักงานจราจร" ที่ห้ามรถบรรทุก ปิดถนน หรือยกเว้นการห้าม
3. ถอดข้อความจาก PDF (`decode_pdf.py`) ใช้วิธีเทียบรูปตัวอักษรกับฟอนต์ TH Sarabun PSK เพราะข้อความในไฟล์ PDF เพี้ยน และ OCR อ่านเลขไทยผิด
4. ดึงสายทาง กม. วันที่ เวลาห้าม และชนิดรถ (`extract_rules.py`)
5. ปักตำแหน่งบนแผนที่ (`geocode.py`) ด้วย Valhalla, Nominatim และขอบเขตตำบล (GADM) ช่วงที่ปักไม่ได้จะส่งไปโดยไม่มีเส้น เพื่อให้คนอ่านประกาศเอง
6. ฉบับใหม่ที่เรื่องเดียวกันจะแทนฉบับเก่า ส่วนประกาศที่หมดอายุเกิน 30 วันจะตัดออก

## ตั้งค่าครั้งแรก
1. สร้าง repo ใหม่บน GitHub (แบบ public ใช้ Actions และ Pages ได้ฟรี) แล้วอัปโหลดไฟล์ทั้งหมดในโฟลเดอร์นี้
2. เข้า Settings → Pages → Source แล้วเลือก **GitHub Actions**
3. เข้า Actions → update-bans แล้วกด **Run workflow** รอบแรกใช้เวลาราว 10–20 นาที
4. ลิงก์ข้อมูลคือ `https://<ชื่อผู้ใช้>.github.io/<ชื่อ repo>/bans.json` เอาไปใส่ใน Route Watch → ตั้งค่า → "ลิงก์ข้อมูลประกาศห้ามวิ่ง"

ถ้ารอบไหนล้มเหลว GitHub จะส่งอีเมลแจ้งเจ้าของ repo เอง ส่วนในแท็บห้ามวิ่งจะขึ้น "ข้อมูลเก่า" ถ้าไม่ได้อัปเดตเกิน 2 วัน

## ข้อจำกัด
- ประกาศที่ไม่ลงราชกิจจาฯ (เช่น โพสต์ Facebook ของ สภ.) ไม่มีในระบบ
- ตำแหน่งบนแผนที่ที่ระบบหาเองอาจคลาดเคลื่อน ช่วงที่ปักแบบประมาณจะเตือนเป็นสีส้ม "อาจห้าม"
- ข้อมูลที่ใช้: HuggingFace soc-ratchakitcha, ราชกิจจานุเบกษา, © OpenStreetMap (Nominatim/Valhalla), GADM 4.1, ฟอนต์ TH Sarabun PSK (SIPA)

## Flood file (flood.json)

`.github/workflows/flood.yml` runs every 15 minutes: `flood/run.js` fetches highway incidents from HDMS (กรมทางหลวง),
ThaiWater road-flood sensors and Longdo flood reports, merges reports of the same place (within 500 m) into events
with a status (ยืนยันแล้ว / รอยืนยัน / ขัดแย้ง / ข้อมูลเก่า) and a pass / take care / do not pass result per vehicle
class, and publishes `flood.json` on GitHub Pages next to `bans.json`.

- Route Watch reads `flood.json` while it is under 45 minutes old; otherwise each browser asks the source itself
  (at most once an hour).
- Longdo's road events ride along in `sources.longdo.result.roadEvents`: announced road closures, diversions / works,
  accidents and broken-down vehicles still in force (or starting within 2 days), with their start and stop times.
- A source that fails one round keeps its last good copy in the file for up to 12 hours (`lastError` says why).
- `flood/lib/` holds copies of the extension's `lib/sources.js`, `lib/flood.js` and `lib/geo.js`: copy them again
  when the extension's readers change.
- Both workflows publish the whole site: the bans run keeps the current `flood.json`, the flood run publishes the
  bans run's last copy (`published/bans.json`).
- Water depths per vehicle class (`RW.FLOOD_VEH` in `flood/lib/flood.js`) are starting values, to be confirmed by
  the company's driving rules.
