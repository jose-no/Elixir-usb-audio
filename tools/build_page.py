#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
"""Rebuild index.html: tools/page.html with Elixir's web/fm1pkg.js and web/fm1ota.js and tools/custom.js inlined at
the /*LIB*/ mark (lines marked (STRIP), the Node-only imports, are dropped).

  ELIXIR=/path/to/elixir python3 tools/build_page.py      # default ELIXIR: /tmp/elixir
"""
import os
from pathlib import Path

here = Path(__file__).resolve().parent
elixir = Path(os.environ.get("ELIXIR", "/tmp/elixir"))
lib = ""
for f in [elixir / "web/fm1pkg.js", elixir / "web/fm1ota.js", here / "custom.js"]:
    src = "\n".join(l for l in f.read_text().split("\n") if "(STRIP)" not in l)
    lib += f"// ---- {f.name} ----\n{src}\n"
page = (here / "page.html").read_text()
assert page.count("/*LIB*/") == 1
(here.parent / "index.html").write_text(page.replace("/*LIB*/", lib))
print("wrote index.html")
