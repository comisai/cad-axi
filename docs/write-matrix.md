# Write matrix

What the writer is shown to carry, and how that is checked. It decides the verified lists in `src/write/preflight.ts`: an edit or a conversion goes ahead only when every entity kind, class and object type in the drawing is on them.

## How it is checked

Every write is read again by a fresh engine process and compared before it is reported (`src/write/verify.ts`):
- `create`: every entity the specification asks for is found once, with its kind, layer, geometry and text, and nothing else is there;
- `edit` and `convert`: every entity the operations do not name is unchanged in kind, layer, geometry, style and text bytes; every operation's effect is present; no layer, block, class or object type is lost.

CI adds independent readers (`scripts/oracles/write-matrix.mjs`): the built tool writes the sample at every version it offers, as DWG and DXF, through `create` and `convert`, and LibreDWG 0.14 reads every DWG and ezdxf 1.4.5 every DXF. Each must find every entity kind with the same counts.

## What was measured

On 2026-11-22, each of ACadSharp's eight sample drawings (written by AutoCAD from R14 to 2018, 341 entities each) was converted to 2018 and to 2004 with no refusal, read again and compared entity by entity:

| Result | Kinds |
| --- | --- |
| Came through unchanged, and the engine reads all of their content | LINE, ARC, CIRCLE, ELLIPSE, LWPOLYLINE, POINT, TEXT, ATTDEF, INSERT with attributes, SOLID, 3DFACE, VIEWPORT |
| Came through, but the engine does not read their content, so survival is not proved | 3DSOLID, MESH, REGION, DIMENSION, HATCH, MULTILEADER, MLINE, LEADER, TOLERANCE, IMAGE, PDFUNDERLAY, WIPEOUT, RAY, XLINE, POLYLINE |
| Changed | MTEXT (4 of 576 changed text), SPLINE (2 of 32 changed geometry) |
| Lost | ACAD_TABLE (half), SHAPE (all) |

Classes and object types lost from AutoCAD's files: VISUALSTYLE, XRECORD, CELLSTYLEMAP, the section and detail view styles, the table content and geometry classes, the evaluation graph, the solid history classes and the associative persistent sub-entity managers.

Writing DXF drops materials: a DXF copy of a drawing with MATERIAL objects reads back with none.

Before AC1018, a file does not record how many objects each class has; for those outputs a class need only be present, and the object census counts.

## The verified lists

- **Entity kinds:** LINE, ARC, CIRCLE, ELLIPSE, LWPOLYLINE, POINT, TEXT, MTEXT, ATTDEF, INSERT, SOLID, 3DFACE, VIEWPORT. MTEXT is on the list although four texts changed: the verify step compares every MTEXT's text bytes, so a change is caught and the write refused.
- **Classes and object types:** those the writer puts in every new drawing: dictionaries, layouts, scales, multiline, multileader and table styles, dictionary variables, materials (DWG only) and the default-dictionary and placeholder objects.

So a drawing that `cad-axi create` wrote can be edited. Most drawings from AutoCAD hold visual styles and xrecords, and are refused with `would_lose`; for those the overlay (`create --like`) carries the changes. A kind joins the list only with a test that reads its full content and shows it survive.

## Still to do

- A person opens sample outputs of each release that writes in AutoCAD or DWG TrueView and runs AUDIT (master plan A5).
- The owner opens edited copies of their own drawings without a recovery prompt (L8).
