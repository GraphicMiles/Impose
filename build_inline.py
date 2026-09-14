"""Build impose-standalone.html by inlining CSS and JS into index.html.

Reads index.html, replaces the stylesheet links with style tags and the
script tags with inline scripts. Output works from disk with no server.
"""
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent

html = (ROOT / "index.html").read_text(encoding="utf-8")
css = (ROOT / "styles.css").read_text(encoding="utf-8")
trace_css = (ROOT / "agent" / "trace.css").read_text(encoding="utf-8")
lucide = (ROOT / "lucide.min.js").read_text(encoding="utf-8")
anime = (ROOT / "anime.min.js").read_text(encoding="utf-8")
trace_js = (ROOT / "agent" / "trace.js").read_text(encoding="utf-8")
orchestrator = (ROOT / "agent" / "orchestrator.js").read_text(encoding="utf-8")
harness = (ROOT / "agent" / "harness.js").read_text(encoding="utf-8")
features = (ROOT / "agent" / "features.js").read_text(encoding="utf-8")
browser_agent = (ROOT / "agent" / "browser-agent.js").read_text(encoding="utf-8")
app = (ROOT / "app.js").read_text(encoding="utf-8")

for name, blob in (("styles.css", css), ("agent/trace.css", trace_css),
                   ("lucide.min.js", lucide), ("anime.min.js", anime), ("agent/trace.js", trace_js),
                   ("agent/orchestrator.js", orchestrator), ("agent/harness.js", harness), ("agent/features.js", features),
                   ("agent/browser-agent.js", browser_agent), ("app.js", app)):
    if "</script" in blob.lower():
        raise SystemExit("Refusing to inline %s: it contains a closing script tag." % name)

html = html.replace(
    '<link rel="stylesheet" href="./styles.css">',
    "<style>\n" + css + "\n</style>",
    1,
)
html = html.replace(
    '<link rel="stylesheet" href="./agent/trace.css">',
    "<style>\n" + trace_css + "\n</style>",
    1,
)
html = html.replace(
    '<script src="./lucide.min.js"></script>',
    "<script>\n" + lucide + "\n</script>",
    1,
)
html = html.replace(
    '<script src="./anime.min.js"></script>',
    "<script>\n" + anime + "\n</script>",
    1,
)
html = html.replace(
    '<script src="./agent/trace.js"></script>',
    "<script>\n" + trace_js + "\n</script>",
    1,
)
html = html.replace(
    '<script src="./agent/orchestrator.js"></script>',
    "<script>\n" + orchestrator + "\n</script>",
    1,
)
html = html.replace(
    '<script src="./agent/harness.js"></script>',
    "<script>\n" + harness + "\n</script>",
    1,
)
html = html.replace(
    '<script src="./agent/features.js"></script>',
    "<script>\n" + features + "\n</script>",
    1,
)
html = html.replace(
    '<script src="./agent/browser-agent.js"></script>',
    "<script>\n" + browser_agent + "\n</script>",
    1,
)
html = html.replace(
    '<script src="./app.js"></script>',
    "<script>\n" + app + "\n</script>",
    1,
)

out = ROOT / "impose-standalone.html"
out.write_text(html, encoding="utf-8")
print("Wrote %s (%d bytes)" % (out.name, out.stat().st_size))
