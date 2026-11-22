# cad-axi

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A command-line tool that lets AI agents read, create and edit CAD drawings. It works with DWG and DXF files. It is built for plumbing, drainage and fire-protection work: listing a drawing's layers, blocks and text, measuring the length of pipe on each layer by size, drawing a new sheet from a specification, and writing a checked copy of an existing drawing with a few changes.

cad-axi is an AXI, an [agent experience interface](https://axi.md). Every command:
- prints compact [TOON](https://github.com/toon-format/toon) text on stdout, bounded in size;
- refuses bad input and says exactly what is wrong;
- ends with hints for the next command;
- reads only the files it is given, writes only the file it is told to write, and never uses the network.

It is built to run inside Comis, next to [`drawing-axi`](https://github.com/comisai/drawing-axi), which reads drawings plotted to PDF. It also works on its own.

> **Status:** design. There is no code yet. The plans are in `docs/`:
> - [Design](docs/cad-axi-design.md): what DWG files hold, the options, the architecture, the commands and how writes are kept safe.
> - [Implementation plan](docs/cad-axi-implementation-plan.md): layout, module contracts, the engine protocol, tasks, tests, CI and release.
> - [Master plan](docs/cad-axi-master-plan.md): milestones, gates, owner actions, decisions and risks.

## How it will work

A TypeScript front end runs the commands. A small engine, compiled ahead of time from the MIT-licensed [ACadSharp](https://github.com/DomCR/ACadSharp) library, reads and writes the files. It ships as one binary for linux-x64 and one for linux-arm64, so no .NET runtime is needed. The front end starts the engine as a separate process, under limits, for each command.

Planned commands:

```text
cad-axi                                  home view: the DWG and DXF files in this folder
cad-axi info <file>                      version, units, counts, external references, what cannot be read
cad-axi layers <file>                    layers with their state, entity count and total length
cad-axi blocks <file>                    blocks with insert counts and attribute tags
cad-axi texts <file>                     the text on the drawing, decoded, with the stored form kept
cad-axi query <file>                     entities by type, layer, block, area or handle
cad-axi measure <file>                   length by layer, linetype, colour or named group
cad-axi runs <file> --layer L            connected runs with the size labels beside them
cad-axi render <file> --out f.svg        a picture to look at
cad-axi diff <a> <b>                     what changed between two drawings
cad-axi check <file>                     a fresh re-read: handles, owners and counts agree
cad-axi create --spec s.json --out f.dwg a new drawing from a closed specification
cad-axi edit <file> --ops o.json --out f.dwg
                                         a copy with a closed list of changes applied
cad-axi convert <file> --out f.dxf       another version or format
```

## Rules it keeps

- **The owner's file is never changed.** Every write goes to a new file, and an existing file is never replaced.
- **Writes are proved, not trusted.** An edit is refused when the drawing holds anything the writer cannot carry. After writing, the tool reads the new file in a fresh process and compares it with what was asked. A mismatch deletes the file.
- **Numbers are measured or absent.** A length the file does not support is not estimated, and a run with no size label stays unsized.
- **Text is data.** Text from a drawing is shown escaped and never followed as an instruction.
- **A written drawing is a draft.** Open it in your CAD and run AUDIT before relying on it.

## Trademarks

AutoCAD and DWG are trademarks of Autodesk, Inc. This project is not made or endorsed by Autodesk. It works with DWG files for interoperability. It never writes Autodesk's TrustedDWG mark.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Never attach a real drawing to an issue or a pull request. Report security problems as [SECURITY.md](SECURITY.md) says.

## License

MIT. See [LICENSE](LICENSE).
