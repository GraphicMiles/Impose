"""Build nova-standalone.html by inlining CSS and JS into index.html.

Reads index.html, replaces the stylesheet link with a style tag and the two
script tags with inline scripts. Output works from disk with no server.
"""
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent

html = (ROOT / "index.html").read_text(encoding="utf-8")
css = (ROOT / "styles.css").read_text(encoding="utf-8")
lucide = (ROOT / "lucide.min.js").read_text(encoding="utf-8")
app = (ROOT / "app.js").read_text(encoding="utf-8")

for name, blob in (("styles.css", css), ("lucide.min.js", lucide), ("app.js", app)):
    if "</script" in blob.lower():
        raise SystemExit("Refusing to inline %s: it contains a closing script tag." % name)

html = html.replace(
    '<link rel="stylesheet" href="./styles.css">',
    "<style>\n" + css + "\n</style>",
    1,
)
html = html.replace(
    '<script src="./lucide.min.js"></script>',
    "<script>\n" + lucide + "\n</script>",
    1,
)
html = html.replace(
    '<script src="./app.js"></script>',
    "<script>\n" + app + "\n</script>",
    1,
)

out = ROOT / "nova-standalone.html"
out.write_text(html, encoding="utf-8")
print("Wrote %s (%d bytes)" % (out.name, out.stat().st_size))
