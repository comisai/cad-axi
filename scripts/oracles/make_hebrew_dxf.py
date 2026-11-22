"""Writes an R2000 DXF in code page 1255 with Hebrew text, using ezdxf.

ezdxf is an independent producer for the engine proof (design §12): the
engine must read what another implementation wrote. Usage:
    python make_hebrew_dxf.py out.dxf
"""
import sys

import ezdxf

TEXT = "שלום %%c110"
MTEXT = "צנרת ביוב"

doc = ezdxf.new("R2000")
# ezdxf writes $DWGCODEPAGE from the document's encoding when it saves.
doc.encoding = "cp1255"
doc.header["$INSUNITS"] = 4
doc.layers.add("NOTES", color=7)
msp = doc.modelspace()
msp.add_line((0, 0), (1000, 0), dxfattribs={"layer": "NOTES"})
msp.add_text(TEXT, dxfattribs={"layer": "NOTES", "height": 100})
msp.add_mtext(MTEXT, dxfattribs={"layer": "NOTES", "char_height": 100})
doc.saveas(sys.argv[1])
