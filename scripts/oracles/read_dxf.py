"""Reads a DXF with ezdxf and prints what the engine proof compares.

ezdxf is an independent reader of the engine's DXF output (design §12).
Usage: python read_dxf.py file.dxf  ->  one JSON object on stdout
"""
import json
import sys
from collections import Counter

import ezdxf
from ezdxf import recover

doc, auditor = recover.readfile(sys.argv[1])
msp = doc.modelspace()
kinds = Counter(e.dxftype() for e in msp)
# Every entity of every block record: model space, layouts and blocks.
all_kinds = Counter(e.dxftype() for block in doc.blocks for e in block)
print(json.dumps({
    "encoding": doc.encoding,
    "codepage": doc.header.get("$DWGCODEPAGE"),
    "kinds": dict(kinds),
    "all_kinds": dict(all_kinds),
    "text": [e.dxf.text for e in msp.query("TEXT")],
    "mtext": [e.text for e in msp.query("MTEXT")],
    "audit_errors": len(auditor.errors),
    "audit_fixes": len(auditor.fixes),
}))
