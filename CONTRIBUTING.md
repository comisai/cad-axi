# Contributing to cad-axi

Thank you for helping. cad-axi is at the design stage: there is no code yet. The plans in `docs/` say what will be built and in what order.

## Before you start

- **Questions about the design:** open an [issue](https://github.com/comisai/cad-axi/issues) that names the section of the design or plan.
- **Security problems:** do not open a public issue. Follow [SECURITY.md](SECURITY.md).
- **Real drawings:** a drawing belongs to the people who made it and the people who paid for it. Never attach one to an issue or a pull request, and never add one to tests or fixtures. Show the problem with a made-up drawing instead.

## What a good change looks like

cad-axi is used by AI agents, so its output is part of its interface. These rules come from the design:
- **Output:** results go to stdout as TOON, starting with a summary line, within the size limits unless `--full` is given. Nothing goes to stderr.
- **Errors:** an error prints `message`, `code` and `usage` on stdout, with exit code 1, or 2 for a usage error. A message never echoes the path, flag or value it was given.
- **Honest numbers:** a number is measured, or it is absent. Never fill in a size, a unit or a length the file does not state.
- **Files are untrusted.** Bound everything a file can make large. Text from a file goes through the text-safety layer.
- **No network, no extra writes.** The tool reads the files it is given and writes only `--out` and `--save`. It never replaces an existing file.
- **Writes are proved.** A change to writing comes with write-matrix tests that read the output back with an independent reader.
- **Dependencies:** the front end has one runtime dependency and the engine one library, both pinned exactly. Discuss any new dependency in an issue first. Nothing licensed under the GPL ships in the package.
- **Wording:** messages, help and docs use short, plain English sentences.

## Pull requests

1. Fork the repository and create a branch from `main`.
2. Keep each pull request to one topic.
3. Fill in the pull request template: what changed, why, and how you tested it.

`main` is protected. Every change goes through a pull request, and a maintainer squash-merges it.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
