from pathlib import Path
from PIL import Image, ImageOps, ImageDraw, ImageFont
import base64, io, zipfile

ROOT = Path(__file__).resolve().parent
BOARDS = [
    ("board-01-agent-forms.png", "Agent forms"),
    ("board-02-orchestration.png", "Orchestration"),
    ("board-03-intent.png", "Intent to action"),
    ("board-04-impose-monograms.png", "Abstract monograms"),
    ("board-05-verification.png", "Verification and recovery"),
]
OUT = ROOT / "individual"
OUT.mkdir(exist_ok=True)
records = []

for board_index, (filename, theme) in enumerate(BOARDS):
    source = Image.open(ROOT / filename).convert("RGB")
    width, height = source.size
    cell_w, cell_h = width / 5, height / 2
    crop_size = int(min(cell_w, cell_h) * 0.94)
    for row in range(2):
        for col in range(5):
            number = board_index * 10 + row * 5 + col + 1
            cx, cy = (col + 0.5) * cell_w, (row + 0.5) * cell_h
            box = (round(cx - crop_size / 2), round(cy - crop_size / 2),
                   round(cx + crop_size / 2), round(cy + crop_size / 2))
            crop = source.crop(box).resize((448, 448), Image.Resampling.LANCZOS)
            gray = ImageOps.grayscale(crop)
            # Convert dark ink to smooth opacity and discard warm paper texture.
            alpha = gray.point(lambda p: 0 if p >= 205 else (255 if p <= 45 else round((205 - p) * 255 / 160)))
            # Some exploration boards may contain faint cell guides despite
            # the prompt. Remove only near-full-height/width straight guides;
            # real marks retain ample crop margins and never span the canvas.
            px = alpha.load()
            if filename == "board-04-impose-monograms.png":
                guide_cols = [x for x in range(448) if sum(px[x, y] > 28 for y in range(448)) > 370]
                guide_rows = [y for y in range(448) if sum(px[x, y] > 28 for x in range(448)) > 370]
                for x in guide_cols:
                    for xx in range(max(0, x - 3), min(448, x + 4)):
                        for y in range(448): px[xx, y] = 0
                for y in guide_rows:
                    for yy in range(max(0, y - 3), min(448, y + 4)):
                        for x in range(448): px[x, yy] = 0
            mark = Image.new("RGBA", (512, 512), (0, 0, 0, 0))
            ink = Image.new("RGBA", (448, 448), (0, 0, 0, 255))
            ink.putalpha(alpha)
            mark.alpha_composite(ink, (32, 32))
            path = OUT / f"impose-{number:02d}.png"
            mark.save(path, optimize=True)
            records.append((number, theme, path))

# A clean numbered overview image.
card, cols, rows = 260, 5, 10
sheet = Image.new("RGB", (card * cols, card * rows), "#f6f4ef")
draw = ImageDraw.Draw(sheet)
font = ImageFont.load_default(size=18)
for i, (number, theme, path) in enumerate(records):
    col, row = i % cols, i // cols
    x, y = col * card, row * card
    icon = Image.open(path).convert("RGBA").resize((205, 205), Image.Resampling.LANCZOS)
    sheet.paste(icon, (x + 28, y + 28), icon)
    draw.text((x + 14, y + 12), f"{number:02d}", fill="#77736b", font=font)
    if col:
        draw.line((x, y + 20, x, y + card - 20), fill="#e4e0d8", width=1)
    if row:
        draw.line((x + 20, y, x + card - 20, y), fill="#e4e0d8", width=1)
sheet_path = ROOT / "impose-50-concepts.png"
sheet.save(sheet_path, optimize=True)

# Offline, self-contained gallery with direct PNG downloads.
cards = []
for number, theme, path in records:
    data = base64.b64encode(path.read_bytes()).decode("ascii")
    cards.append(f'''<article class="card"><span class="num">{number:02d}</span>
      <div class="mark"><img src="data:image/png;base64,{data}" alt="Impose logo concept {number:02d}"></div>
      <div class="meta"><strong>{theme}</strong><a download="impose-{number:02d}.png" href="data:image/png;base64,{data}">Download PNG</a></div>
    </article>''')
html = '''<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Impose — 50 negative-space logo concepts</title><style>
:root{color-scheme:dark;--bg:#0c0d10;--panel:#15171c;--line:#282b33;--muted:#979ca8;--accent:#c9c2ff}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:#f5f5f7;font:14px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}header{max-width:1320px;margin:auto;padding:56px 28px 26px}h1{font-size:clamp(32px,5vw,64px);letter-spacing:-.055em;margin:0 0 12px}header p{max-width:720px;color:var(--muted);font-size:16px}main{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:14px;max-width:1320px;margin:auto;padding:18px 28px 72px}.card{position:relative;overflow:hidden;border:1px solid var(--line);border-radius:18px;background:var(--panel)}.num{position:absolute;z-index:2;top:12px;left:14px;color:#6e7380;font:600 12px ui-monospace,monospace}.mark{aspect-ratio:1;display:grid;place-items:center;background:#f6f4ef;margin:8px;border-radius:12px}.mark img{width:88%;height:88%;object-fit:contain}.meta{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:7px 13px 14px;color:var(--muted);font-size:11px}.meta a{color:var(--accent);text-decoration:none;white-space:nowrap}.meta strong{font-weight:500}.note{max-width:1320px;margin:0 auto;padding:0 28px 56px;color:var(--muted)}@media(max-width:900px){main{grid-template-columns:repeat(3,1fr)}}@media(max-width:560px){main{grid-template-columns:repeat(2,1fr);padding-inline:12px;gap:8px}header{padding-inline:16px}.meta{display:block}.meta a{display:block;margin-top:3px}}
</style></head><body><header><h1>50 directions for Impose</h1><p>Original monochrome, negative-space explorations shaped around intelligent agency, intent, orchestration, momentum, verification, and recovery. Each mark is supplied as a 512×512 transparent PNG.</p></header><main>''' + "".join(cards) + '''</main><p class="note">Concept artwork for selection and refinement. Before commercial adoption, redraw the selected mark as a production vector and run a trademark/similarity review.</p></body></html>'''
gallery_path = ROOT / "logo-gallery.html"
gallery_path.write_text(html, encoding="utf-8")

readme = ROOT / "README.md"
readme.write_text("""# Impose logo concept pack\n\n- 50 original negative-space directions\n- `individual/`: transparent 512×512 PNG marks\n- `impose-50-concepts.png`: numbered overview\n- `logo-gallery.html`: self-contained browser gallery and downloads\n- `board-*.png`: five source exploration boards\n\nThese are concept-stage AI-generated marks. Select a shortlist, redraw the finalists as precise SVG vectors, test at 16–32 px, and perform a trademark/similarity review before commercial use.\n""", encoding="utf-8")

zip_path = ROOT / "impose-logo-concepts.zip"
with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
    for _, _, path in records:
        z.write(path, path.relative_to(ROOT))
    for path in [sheet_path, gallery_path, readme] + [ROOT / item[0] for item in BOARDS]:
        z.write(path, path.relative_to(ROOT))
print(f"Created {len(records)} individual logos, gallery, overview, and {zip_path.name}")
