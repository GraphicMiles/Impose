"""Regenerate fonts.css from the canonical @font-face block in styles.css.

styles.css is the source of truth: the standalone build inlines it, so it can
never use @import. fonts.css is the copy the public and auth pages link. Run
this after changing the face in styles.css, then commit both.
"""
import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parent.parent
css = (ROOT / "styles.css").read_text(encoding="utf-8")
match = re.search(r"@font-face \{.*?\n\}\n", css, re.S)
if not match:
    raise SystemExit("No @font-face block found in styles.css")

HEADER = """/* Shared type face for the public pages (about, privacy, terms, contact,
   acceptable use, data security, 404) and the auth screens.

   The app shell (styles.css) carries its own copy of this @font-face so the
   single-file standalone build stays self-contained with no @import. The two
   copies are kept byte-identical by agent/tests/taste.js, which fails the
   regression gate if they ever drift. Edit styles.css, then run:
     python3 tools/sync_fonts.py
*/
"""
out = ROOT / "fonts.css"
out.write_text(HEADER + match.group(0), encoding="utf-8")
print("Wrote %s (%d bytes)" % (out.name, out.stat().st_size))
