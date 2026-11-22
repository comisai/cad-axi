# cad-axi: implementation plan

| | |
| --- | --- |
| Status | T1 done: the repository and these plans (comisai/cad-axi#1, 2026-11-22). T2 is next. |
| Date | 2026-11-22 |
| Design | [`cad-axi-design.md`](cad-axi-design.md) |
| Master plan | [`cad-axi-master-plan.md`](cad-axi-master-plan.md) (milestones, gates, owner actions) |

## 1. Summary

`cad-axi` is a Node command-line tool, published to npm, that reads, creates and edits CAD drawings in DWG and DXF files. It has two parts in one package.

- **The front end** is TypeScript run directly by Node. It copies `drawing-axi`'s runtime: one command table, strict flags, TOON output from the official encoder, a closed error set, text safety and `COMIS_DEADLINE`.
- **The engine** is a small C# program on ACadSharp, compiled with NativeAOT into one binary for linux-x64 and one for linux-arm64. Both binaries ship inside the npm package.

The front end starts the engine once per command under limits, reads its newline-delimited JSON, and does all filtering, measuring and formatting. Writes go through a refuse-and-prove loop (design §8.8 and §8.9).

Work runs in the order of the design's phases: the engine proof, reading, creating, then editing. No task depends on a real drawing being in the repository.

## 2. Build order

1. Repository settings, CI skeleton and these plans.
2. The engine proof: NativeAOT on both platforms, the `read` verb at its smallest, limits, packaging. Settle the design's open questions Q1, Q2, Q5, Q6 and Q8.
3. The front end runtime, copied from `drawing-axi`, and the engine bridge.
4. Reading: the full `read` verb, then `info`, `layers`, `blocks`, `texts`, `query`.
5. Geometry and measuring, runs and sizes, pictures, `diff` and `check`.
6. Tests on independent files, hostile files and fuzzing.
7. The live test, the release workflow and release 0.1.0.
8. The Comis pack.
9. Creating, with the write matrix and the independent readers.
10. Editing and converting, with the verified class list and the verify loop.

## 3. Repository layout

```text
src/
  bin/cad-axi.ts            entry: stdout only, exit code from main()
  cli/                      table.ts (command table), parse.ts (strict flags), run.ts (dispatch, help)
  commands/                 home, info, layers, blocks, texts, query, measure, runs, render,
                            diff, check, create, edit, convert, version
  engine/                   platform.ts (which binary), spawn.ts (limits, deadline, kill),
                            protocol.ts (record types, validation, version check)
  model/                    types.ts, reduce.ts (records to views), units.ts,
                            geometry.ts (bulges, arcs, ellipses, splines, extrusion, insert transforms),
                            text.ts (MTEXT codes, %% codes, \U+ escapes), shx.ts (from drawing-axi)
  takeoff/                  runs.ts, sizes.ts (ported from drawing-axi), groups.ts
  picture/                  svg.ts
  write/                    schema.ts (specification and operations), preflight.ts (verified classes),
                            verify.ts (re-read and compare), output.ts (temporary file, move without replace)
  output/                   toon.ts (bounds), text.ts (safety), views.ts (list, record); from drawing-axi
  errors.ts, version.ts
engine/
  CadAxi.Engine.csproj      net10.0, PublishAot, TrimmerRootAssembly ACadSharp, InvariantGlobalization
  global.json               the pinned .NET SDK
  packages.lock.json        the pinned ACadSharp, restored in locked mode
  src/Program.cs            verbs: probe, read, write, edit
  src/Read/                 ModelWriter.cs (NDJSON records), Census.cs (classes), Geometry.cs
  src/Write/                SpecBuilder.cs, OpsApplier.cs
test/
  fixtures/dxf.ts           a small DXF writer for tests (R12 and AC1015 ASCII)
  fixtures/sample.ts        the sample drawing and its known answers
  fixtures/third-party/     ACadSharp's MIT sample drawings, with their licence
  unit/                     geometry, units, text, runs, sizes, diff, schema, protocol
  contract/                 every command as a separate process
  axi/                      the ten AXI principles
  write/                    the write matrix
  hostile/                  damaged and hostile files, made from the fixtures with fixed seeds
  live/                     cad-live.mjs, plan.example.json; reports/ is gitignored
scripts/                    clean, build-engine, check-package, check-engine
docs/                       design, this plan, master plan, recipes, releasing
```

The front end is expected at about 6,000 lines, the engine at about 1,500, and tests and fixtures at about 4,000.

## 4. Module contracts

| Module | Takes | Gives | Never |
| --- | --- | --- | --- |
| `engine/platform` | `process.platform`, `process.arch` | The engine's path, or `unsupported_platform` | Downloads anything |
| `engine/spawn` | a verb, arguments, limits | Records as they arrive, an exit status | Lets the engine outlive `COMIS_DEADLINE`; passes the environment through unfiltered |
| `engine/protocol` | engine output lines | Typed records | Accepts an unknown protocol version, an unknown record type or a line over 1 MiB |
| `model/reduce` | records, a view | Rows for that view | Holds the whole model when the view does not need it |
| `model/geometry` | an entity record | Length, bounding box, points in world coordinates | Guesses a missing value |
| `model/units` | the header, `--units` | A factor to metres, or `units_unknown` | Assumes millimetres |
| `model/text` | a stored string, its style, the code page | `text` beside `raw`, and how it was decoded | Changes `raw`; reverses text |
| `takeoff/runs`, `sizes` | entities on chosen layers, size labels, a reach | Runs with ends, length, size and basis | Sizes a run from a label of another group; joins across a corner |
| `picture/svg` | entities, texts, a box | SVG text | Copies anything but escaped text and numbers from the file |
| `write/schema` | a JSON file | A validated specification or list of operations, or `invalid_spec` naming the field | Accepts external references, images, OLE objects, fields, data links or paths |
| `write/preflight` | a class census | `editable`, or `would_lose` with classes and counts | Passes a class that is not on the verified list |
| `write/verify` | a source model, an output model, the operations | A match, or `verify_failed` with counts | Reports success on a partial match |
| `write/output` | a verified temporary file, `--out` | The file at `--out` | Replaces an existing file |
| `commands/*` | parsed flags, `Io` | One TOON string | Writes to stderr; reads any file but those named |
| `output/*` | a document or rows | Bounded, safe TOON | Lets file text change the document's shape |

`Io` is `{ stdout, env, now, cwd }`. Tests run the real binary, so only the clock needs injecting.

## 5. The engine protocol in detail

The engine prints one JSON object a line. Every object has `"p": 1` (the protocol version) and a `"type"`.

```text
{"p":1,"type":"header","version":"AC1032","codepage":"ANSI_1252","insunits":4,"extmin":[0,0,0],"extmax":[42000,18000,0],"layouts":["Model","A1"],"encrypted":false}
{"p":1,"type":"layer","name":"SAN","on":true,"frozen":false,"locked":false,"color":3,"linetype":"Continuous"}
{"p":1,"type":"style","name":"HEB","font":"hebrew.shx","kind":"shx","backwards":false,"height":0}
{"p":1,"type":"block","name":"HEAD","base":[0,0,0],"attributes":["SIZE"],"external":false}
{"p":1,"type":"entity","h":"1A2","kind":"LWPOLYLINE","layer":"SAN","space":"Model","owner":null,"color":256,"linetype":"ByLayer","pts":[[0,0],[1000,0],[1000,500]],"bulges":[0,0.4142,0],"closed":false,"normal":[0,0,1]}
{"p":1,"type":"entity","h":"1B0","kind":"INSERT","layer":"F","space":"Model","block":"HEAD","at":[2500,800,0],"scale":[1,1,1],"rotation":0,"normal":[0,0,1],"attribs":[{"tag":"SIZE","raw":"1/2\""}]}
{"p":1,"type":"entity","h":"1C4","kind":"MTEXT","layer":"NOTES","space":"Model","style":"HEB","raw":"\\fArial|b0;...","at":[100,200,0],"height":250,"rotation":0}
{"p":1,"type":"external","kind":"xref","name":"BASE","path_present":true}
{"p":1,"type":"class","name":"AcDbZombieEntity","count":12,"modelled":false}
{"p":1,"type":"end","entities":18234,"skipped":12,"ms":840}
{"p":1,"type":"error","code":"damaged"}
```

Rules:
- Handles are hexadecimal strings, as AutoCAD writes them.
- Coordinates are numbers in drawing units. Non-finite values are an engine error, never printed.
- An external reference's path is never printed; `path_present` says only that one exists.
- Text is printed as stored, in JSON string escapes. The front end applies text safety.
- `write` and `edit` read their input from the JSON file the front end wrote, and print the same records for the new file after writing it, so `verify` can compare without a second parse in the same process. `verify` still re-reads the file in a fresh process (design §8.9).

## 6. Work breakdown

### M1: repository and plans

| Task | What | Done when |
| --- | --- | --- |
| T1 | Repository, licence, README, NOTICE, security policy, contributing guide, code of conduct, pull request template, design, this plan, master plan | Merged to `main`: **done** (#1) |
| T2 | Repository settings, with the first CI workflow: `main` needs a pull request and green checks; `v*` tags admin-only; an `npm` environment that deploys only from tags; Dependabot for npm, NuGet and GitHub Actions; issue templates; `CODEOWNERS` | A pull request without checks cannot merge; a non-admin cannot push a `v*` tag |

### M2: engine proof (design phase 0)

| Task | What | Done when |
| --- | --- | --- |
| T3 | Engine project: `global.json`, locked restore of a pinned ACadSharp, the `probe` verb | `dotnet publish` works offline after restore; `probe` prints versions |
| T4 | NativeAOT builds in CI on `ubuntu-24.04` and `ubuntu-24.04-arm`, with ACadSharp rooted | Both binaries run `probe`; size, start time and the newest C library symbol are recorded; the symbol is no newer than Debian trixie's |
| T5 | The smallest `read`: header, layers, entity counts, class census | Every ACadSharp sample drawing reads on both platforms with the expected counts |
| T6 | Limits: input cap, heap limit through the runtime's environment setting, time limit, kill | A drawing built to exhaust memory ends in `too_large` or `timed_out`, never an out-of-memory kill of the parent; settles Q6 |
| T7 | Header fields for repeatable writes | Two writes of the same specification give the same bytes, or the reason they cannot is recorded; settles Q5 |
| T8 | Hebrew in code page 1255 in an AC1015 DWG, made by ACadSharp and by LibreDWG `dxf2dwg` | The text reads back correctly from both; settles Q2 |
| T9 | Packaging probe: `npm pack` with both engines, installed in a clean folder on each platform | The engine is mode 0755 after install and runs; the tarball is under 30 MB |
| T10 | Private pass over the owner's DWGs (needs A2) | A private report: files that open, versions, units, opaque classes, time and memory per file; settles Q7 and Q8 |

### M3: reading

| Task | What | Done when |
| --- | --- | --- |
| T11 | Front end runtime from `drawing-axi`: command table, strict parsing, TOON bounds, text safety, errors, deadline | The AXI principle tests pass on a stub command |
| T12 | Engine bridge: platform selection, spawn under limits, protocol validation | A garbage line, an unknown version, a crash and a hang each map to their codes |
| T13 | The full `read` verb: entities with geometry, blocks, inserts with attributes, texts with styles, external references and images as metadata | The sample drawing's records equal its known answers |
| T14 | Home view, `info`, `version` | Exact output on the sample; `editable` with its reason |
| T15 | `layers`, `blocks` | Exact counts and lengths on the sample |
| T16 | `texts` and text decoding: MTEXT codes, `%%` codes, `\U+` escapes, code pages, Hebrew SHX on Latin keys | Every rule in design §8.3 has a test, and the Latin texts that must not change |
| T17 | `query` | Each filter alone and combined; handles match `info` |

### M4: measuring, pictures, comparing

| Task | What | Done when |
| --- | --- | --- |
| T18 | Geometry: bulges, arcs, ellipses, splines with a stated tolerance, extrusion, insert transforms through nested blocks | Unit tests with exact answers; a rotated, scaled, mirrored insert measures right |
| T19 | `measure`: by layer, linetype, colour or named groups; `--region`; frozen and off layers; units | Exact lengths on the sample; `units_unknown` when the sample's units are removed |
| T20 | `runs` and sizes, ported from `drawing-axi`, with the reach as a multiple of text height | The sample's runs and sizes exact; no size on an unlabelled run; a shared label sizes neither |
| T21 | `render` | Well-formed SVG; file text escaped; no links, scripts, images or fonts |
| T22 | `diff` and `check` | A known change is reported exactly; an unchanged copy reports none |
| T23 | Contract tests for every command and error, on source and on the built package, on both platforms | All pass in CI |
| T24 | Hostile set: truncated, byte-flipped, oversized and malformed files from fixed seeds | Each ends in a closed error within the limits |
| T25 | Independent producers in CI: DXF from ezdxf; DWG from LibreDWG `dxf2dwg`, built from a pinned source tarball | Read tests pass on both |
| T26 | Fuzzing: the engine's read path under a .NET fuzzer, seeded from the fixtures, on a schedule | Runs weekly; any crash becomes a hostile fixture and a fix |

### M5 and M6: qualification and release 0.1.0

| Task | What | Done when |
| --- | --- | --- |
| T27 | The live test (`test/live/cad-live.mjs`) and its example plan | It runs the built CLI on files a private plan names and writes a private report |
| T28 | Live gate on the owner's DWGs (needs A2) | L1 to L6 and L9 pass (design §12) |
| T29 | Skill dry run: a fresh worker with a draft of the Comis skill, the tool and the sample drawing | Every length right; an instruction planted in the drawing ignored; its notes become fixes |
| T30 | `release.yml`: engines built and tested on native runners, package assembled, tests on the built package, `npm publish --provenance` | A dry run publishes nothing and passes |
| T31 | README, `docs/recipes.md`, `docs/releasing.md` | Every recipe runs in a test |
| T32 | Release 0.1.0 (needs A1) | `npm view cad-axi dist.attestations` names this repository; the live gate passes on the installed package |

### M7 and M8: the Comis pack and live test

These tasks change the Comis repository (design §11).

| Task | What | Done when |
| --- | --- | --- |
| T33 | Decision record (C1) | Accepted by the owner (A3) |
| T34 | Pack entry: pin, wrapper, doctor, inventory, publisher record, release-age, NOTICE, case table, golden, skill index, prompt cases (C2 to C6, C9) | The pack builds on x64 and arm64; its doctor finds the exact version; the engine runs from the installed pack |
| T35 | `drawing-takeoff` routing (C7) | Its tests pass; a DWG question reaches `cad-axi info` first |
| T36 | Installed-pack proof and evidence recaptures (C8, C11) | The Comis merge gate passes |
| T37 | Scripted stage and keyed scenario on a made-up DWG (C10; needs A6) | A real model answers the sample drawing's questions with every length right |

### M9: creating, release 0.2.0

| Task | What | Done when |
| --- | --- | --- |
| T38 | Specification schema and validation | Every field's bounds tested; forbidden content refused by name |
| T39 | The engine's `write` verb | Each entity kind written at AC1032 DWG and as DXF |
| T40 | `create`, `create --like` | The sample rebuilt from a specification equals the sample; an overlay lies in the source's coordinates |
| T41 | The verify loop for `create` | A deliberately wrong engine output is caught as `verify_failed` |
| T42 | The write matrix and the independent readers in CI (LibreDWG `dwgread`, ezdxf) | Zero lost entities for every kind and version the release claims |
| T43 | The Comis `drawing-edit` skill and its tests | Merged in Comis |
| T44 | Human check (needs A5) and release 0.2.0 | Sample outputs open in AutoCAD or DWG TrueView; AUDIT reports no errors |

### M10: editing and converting, release 0.3.0

| Task | What | Done when |
| --- | --- | --- |
| T45 | Operations schema and validation | Every operation's bounds tested; unknown handles refused |
| T46 | The engine's `edit` verb | Each operation applied at AC1032 |
| T47 | The verified class list, measured | Each class on it survives the write matrix and the human check; everything else refuses with `would_lose` |
| T48 | The verify loop for `edit`: untouched entities unchanged, every operation present, census unchanged | A deliberately dropped entity is caught |
| T49 | `convert` | Each supported version and format, under the same refusal and checks |
| T50 | Live L7 and L8 (needs A2 and A5) and release 0.3.0 | Zero lost entities; the owner opens edited copies without a recovery prompt |

## 7. Test plan

| Tier | Command | Runs |
| --- | --- | --- |
| Unit | `npm test` | Every push, Node 22 and 24 |
| Engine and contract | `npm run test:contract` | Every push, x64 and arm64 |
| AXI principles | `npm run test:axi` | Every push, x64 and arm64 |
| Built package | `npm run test:dist` | Every push, x64 and arm64 |
| Hostile | `npm run test:hostile` | Every push |
| Independent readers and producers | `npm run test:oracles` | Every push, x64 |
| Write matrix | `npm run test:write` | Every push, from M9 |
| Fuzzing | `fuzz.yml` | Weekly |
| Live | `npm run live -- --plan <plan>` | By hand, never in CI |

### 7.1 The sample drawing

`test/fixtures/sample.ts` writes the sample with the test DXF writer, and the engine converts it to each DWG version. Its answers are chosen, not measured:
- units millimetres;
- a sewer layer with runs labelled `Ø110` and `Ø160`, including an arc segment and a run inside a rotated, scaled block insert;
- a rain layer with a dashed linetype;
- a fire layer with coded labels such as `F-Ø3"`, one written in a break of its line and one between two layers' runs;
- a cold-water layer with an unlabelled run;
- a sprinkler head block with a size attribute, inserted twelve times;
- a legend box with sample lines on the pipe layers, and a title block in paper space;
- a Hebrew MTEXT note, Hebrew written on Latin keys in an SHX style, and a text with a bidirectional override;
- a frozen layer, an external reference record and an image record, never opened;
- a planted instruction in a text, which the skill dry run must ignore.

### 7.2 Independent checks

- **Producers:** ezdxf writes DXF fixtures; LibreDWG's `dxf2dwg` converts them to DWG. The tool must read both.
- **Readers:** every file the tool writes is read back by ACadSharp in a fresh process, by LibreDWG's `dwgread`, and, for DXF, by ezdxf's audit. Each must agree on entity counts by kind and layer.
- LibreDWG and ezdxf run only in CI, pinned by version and hash. Nothing from them ships.
- ODA File Converter is not used unless the owner decides otherwise (A4).

### 7.3 The live test

The live test runs the built CLI on real drawings named in a private plan file. Neither the drawings nor the plan enter the repository.

```text
{ "files": [ { "path": "/private/plans/level-1.dwg",
               "layers": ["SAN", "RAIN", "F", "CW"],
               "texts": ["…a text expected on the sheet…"],
               "groups": [ { "name": "sewer", "layers": ["SAN"], "reference_m": 412.0 } ],
               "edits": [ { "ops": "/private/plans/level-1-ops.json" } ] } ] }
```

It prints a TOON summary of stages L1 to L9 (design §12) and writes a report to `test/live/reports/`, gitignored and mode 0600, that names files by position and holds layer names and numbers, not drawings. A pull request carries only the summary line, and only if the drawings' owner allows it.

### 7.4 The human check

Before each release that writes, a person opens the release's sample outputs, all versions it claims, in AutoCAD or DWG TrueView, and runs AUDIT. The result goes in the release notes. AutoCAD's headless console repairs files silently, so it does not count.

## 8. CI and release

**`ci.yml`**, on every push and pull request:
- `front`: Node 22 and 24 on `ubuntu-24.04`: install with `npm ci --ignore-scripts`, type-check, lint, unit tests.
- `engine`: `ubuntu-24.04` and `ubuntu-24.04-arm`: restore in locked mode, publish NativeAOT, check the newest C library symbol, upload the binary.
- `contract`: on each platform with its engine: contract, AXI, hostile and built-package tests.
- `oracles`: on `ubuntu-24.04`: build LibreDWG from a pinned source tarball checked by hash, cached; install ezdxf pinned with hashes; run the independent checks.
- `package`: assemble the package with both engines, `check-package` (files, modes, size, no extra files), install the tarball in a clean folder and run it.

**`release.yml`**, on a `v*` tag, in the `npm` environment, with `id-token: write`:
- Refuse a private repository, because npm provenance needs a public one.
- Check that the tag equals `package.json`.
- Build and test both engines on their native runners.
- Assemble, run every test on the built package, then `npm publish --provenance --access public --ignore-scripts`.

**Rules for both:** actions pinned by commit, permissions read-only unless a job needs more, no secrets outside the `npm` environment, no network in tests, and the live test never runs.

**`fuzz.yml`** runs weekly and on demand.

## 9. What is not in this plan

- Reading vertical-product objects (MEP pipes, Civil 3D surfaces). The tool reports them as opaque.
- Resolving external references or images.
- 3D solids, rendering fidelity, plotting to PDF.
- Opening password-protected files.
- macOS and Windows binaries; they can follow for standalone use.
- An MCP server. Comis calls tools from bash.
- Writing AutoCAD's TrustedDWG mark, ever.
