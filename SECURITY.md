# Security Policy

cad-axi reads files that come from other people. A drawing can be damaged or made on purpose to break a reader, its text is shown to an AI agent, and the tool writes files that people open in their CAD software. We take security reports seriously.

## Supported versions

There is no release yet. Once there is, security fixes go to `main` and to the next `0.x` release on npm, and only the latest release is supported.

## Reporting a vulnerability

Do not open a public issue. Report it privately through GitHub:
1. Go to the [Security tab](https://github.com/comisai/cad-axi/security/advisories/new).
2. Choose **Report a vulnerability**.

Include what the problem is and what an attacker could do with it, the commit or version affected, and the steps to reproduce it, ideally with a small made-up file. Never include a real drawing that is not yours to share. The maintainers will acknowledge your report, keep you informed while they work on a fix, and agree on the disclosure with you.

## Scope

**In scope:**
- A file that makes the tool or its engine hang, crash, run out of memory, or run past `COMIS_DEADLINE` without stopping.
- A file that makes the tool read or write any path other than the files named, `--out` and `--save`.
- Any network connection, or any attempt to open an external reference, image, OLE object, data link or network path named in a file.
- A written file that gains an external reference, image, OLE object, field, data link or path that was not asked for.
- An edit that reports success but loses or changes entities it was not asked to change.
- A bypass of the text-safety layer: invisible or bidirectional characters from a file passing through unescaped, or text from a file changing the shape of the output.
- An error message that echoes a path, flag or value it was given.
- `render` writing something other than well-formed SVG, or carrying script or external references from the file into it.

**Out of scope:**
- A wrong length, size or count. That is a bug: open an issue with a made-up file that shows it.
- Vulnerabilities in Comis; report those to the Comis maintainers.
- Vulnerabilities in ACadSharp that cad-axi does not expose; report those to ACadSharp.
