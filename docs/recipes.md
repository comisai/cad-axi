# Recipes

Questions a worker asks about a drawing, and the commands that answer them. Each recipe runs in a test (`test/contract/recipes.test.ts`) on the sample drawing, `plan.dwg`, which the tests draw themselves.

## What is this drawing?

```sh
cad-axi info plan.dwg
```

Read `units` first: with `not stated`, every length needs `--units`. Read `vertical_products` and `opaque`: objects from AutoCAD MEP or Architecture are present but unreadable, and the owner should send a copy saved with "Export to AutoCAD".

## Which layers hold pipe, and how much?

```sh
cad-axi layers plan.dwg
cad-axi measure plan.dwg --layer SAN --layer RAIN
```

`in_blocks` is the part drawn inside block inserts, such as fittings. Layers that are off or frozen are left out and counted in `left_out`; `--all` includes them.

## Leave the legend out

The legend often holds sample lines on pipe layers. Measure only the plan's area:

```sh
cad-axi measure plan.dwg --region -1000,-8000,45000,45000
```

## Length by pipe size

```sh
cad-axi measure plan.dwg --by size --layer SAN --layer RAIN --layer F --layer CW
cad-axi runs plan.dwg --layer F --layer CW
```

A label with a system code, such as `F-Ø3"`, sizes only runs of the group with that code. A label as close to two groups' runs sizes neither. An unlabelled run stays unsized: read it on the drawing; never guess.

## Systems that span several layers

```sh
cad-axi measure plan.dwg --group drainage=SAN+RAIN --group fire=F
```

## Find a label, a block or an entity

```sh
cad-axi texts plan.dwg --match "%%c|Ø"
cad-axi blocks plan.dwg
cad-axi query plan.dwg --block HEAD --limit 3
```

Text is shown decoded, with MTEXT codes removed. Hebrew typed on Latin keys for a Hebrew stroke font is decoded and marked; `--full` shows each text as stored.

## Look at it

```sh
cad-axi render plan.dwg --out plan.svg --layer SAN --layer RAIN
```

## Mark up a drawing without touching it: the overlay

Write the markup as a new drawing in the source's units, layers and coordinates. The owner inserts it over their own drawing.

```sh
cad-axi create --spec markup.json --like plan.dwg --out markup.dwg
```

with `markup.json`:

```json
{ "entities": [
  { "kind": "polyline", "layer": "SAN", "pts": [[0, 0], [6000, 0]] },
  { "kind": "text", "layer": "NOTES", "at": [0, 300], "height": 250, "value": "check this run" }
] }
```

## Change a copy

Take handles from `query`, write the operations, and give a new file:

```sh
cad-axi query plan.dwg --layer CW
cad-axi edit plan.dwg --ops ops.json --out plan-edited.dwg
cad-axi diff plan.dwg plan-edited.dwg --each
```

with `ops.json`, naming the handle `query` printed:

```json
{ "ops": [
  { "op": "add_layer", "name": "MARK", "color": 1 },
  { "op": "add_text", "layer": "MARK", "at": [0, 25000], "height": 250, "value": "moved 100 mm" },
  { "op": "move", "h": "<handle from query>", "by": [0, 100] }
] }
```

An edit is refused with `would_lose` when the drawing holds anything the writer is not verified to keep; then use the overlay. Every written drawing is a draft: open it in your CAD program and run AUDIT before relying on it.

## Another version or format

```sh
cad-axi convert plan.dwg --out plan-2013.dwg --as 2013
```
