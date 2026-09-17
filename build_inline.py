"""Build impose-standalone.html by inlining CSS and JS into index.html.

Reads index.html, replaces the stylesheet links with style tags and the
script tags with inline scripts. Output works from disk with no server.
"""
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent
CHECK = "--check" in sys.argv[1:]

html = (ROOT / "index.html").read_text(encoding="utf-8")
css = (ROOT / "styles.css").read_text(encoding="utf-8")
community_css = (ROOT / "community.css").read_text(encoding="utf-8")
trace_css = (ROOT / "agent" / "trace.css").read_text(encoding="utf-8")
lucide = (ROOT / "lucide.min.js").read_text(encoding="utf-8")
anime = (ROOT / "anime.min.js").read_text(encoding="utf-8")
trace_js = (ROOT / "agent" / "trace.js").read_text(encoding="utf-8")
orchestrator = (ROOT / "agent" / "orchestrator.js").read_text(encoding="utf-8")
harness = (ROOT / "agent" / "harness.js").read_text(encoding="utf-8")
features = (ROOT / "agent" / "features.js").read_text(encoding="utf-8")
app = (ROOT / "app.js").read_text(encoding="utf-8")
community_js = (ROOT / "community.js").read_text(encoding="utf-8")
community_data_js = (ROOT / "community-data.js").read_text(encoding="utf-8")
# The Supabase SDK. Missed until now, so the single-file build carried a
# bare <script src> that cannot resolve when the file is opened from disk:
# Community would load and then fail every server call.
supabase_js = (ROOT / "supabase.min.js").read_text(encoding="utf-8")
config_js = (ROOT / "config.js").read_text(encoding="utf-8")
debug_bus_js = (ROOT / "debug-bus.js").read_text(encoding="utf-8")
avatars_js = (ROOT / "avatars.js").read_text(encoding="utf-8")
ui_core_js = (ROOT / "ui-core.js").read_text(encoding="utf-8")
access_js = (ROOT / "access.js").read_text(encoding="utf-8")

for name, blob in (("styles.css", css), ("community.css", community_css), ("agent/trace.css", trace_css),
                   ("lucide.min.js", lucide), ("anime.min.js", anime), ("agent/trace.js", trace_js),
                   ("agent/orchestrator.js", orchestrator), ("agent/harness.js", harness), ("agent/features.js", features),
                   ("app.js", app), ("community.js", community_js)):
    if "</script" in blob.lower():
        raise SystemExit("Refusing to inline %s: it contains a closing script tag." % name)

html = html.replace(
    '<link rel="stylesheet" href="./styles.css">',
    "<style>\n" + css + "\n</style>",
    1,
)
html = html.replace(
    '<link rel="stylesheet" href="./community.css">',
    "<style>\n" + community_css + "\n</style>",
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
    '<script src="./debug-bus.js"></script>',
    "<script>\n" + debug_bus_js + "\n</script>",
    1,
)
html = html.replace(
    '<script src="./config.js"></script>',
    "<script>\n" + config_js + "\n</script>",
    1,
)
html = html.replace(
    '<script src="./avatars.js"></script>',
    "<script>\n" + avatars_js + "\n</script>",
    1,
)
html = html.replace(
    '<script src="./ui-core.js"></script>',
    "<script>\n" + ui_core_js + "\n</script>",
    1,
)
html = html.replace(
    '<script src="./access.js"></script>',
    "<script>\n" + access_js + "\n</script>",
    1,
)
html = html.replace(
    '<script src="./app.js"></script>',
    "<script>\n" + app + "\n</script>",
    1,
)
html = html.replace(
    '<script src="./supabase.min.js"></script>',
    "<script>\n" + supabase_js + "\n</script>",
    1,
)
html = html.replace(
    '<script src="./community-data.js"></script>',
    "<script>\n" + community_data_js + "\n</script>",
    1,
)
html = html.replace(
    '<script src="./community.js"></script>',
    "<script>\n" + community_js + "\n</script>",
    1,
)

out = ROOT / "impose-standalone.html"
if CHECK:
    current = out.read_text(encoding="utf-8") if out.exists() else ""
    if current != html:
        raise SystemExit(
            "impose-standalone.html is stale against its sources.\n"
            "Run: python3 build_inline.py   then commit the rebuilt file."
        )
    print("impose-standalone.html is current (%d bytes)" % len(current))
    raise SystemExit(0)
out.write_text(html, encoding="utf-8")
print("Wrote %s (%d bytes)" % (out.name, out.stat().st_size))
