# Releasing cad-axi

`.github/workflows/release.yml` publishes to npm when an admin pushes a `v*` tag. Only admins can create, move or delete `v*` tags (the "release tags" ruleset), and the `npm` environment deploys only from those tags.

The workflow:
1. builds the engine with NativeAOT on a native x64 runner and a native arm64 runner, checks its C library floor, and runs every test on each;
2. puts both engines into one package, checks its files and modes, and tests the package as built;
3. publishes with `npm publish --provenance`, using the `NPM_TOKEN` secret of the `npm` environment. The job's OIDC token signs the provenance, which names this repository. Comis installs an AXI only when its provenance names its source repository.

## Each release

1. In a pull request, set `version` in `package.json`, `package-lock.json` and `src/version.ts` (`npm version <x.y.z> --no-git-tag-version`, then the file), and say what changed.
2. Before merging a release that changes reading, run the live test against the built CLI on real drawings (`npm run live -- --plan <private plan>`). Before a release that changes writing, have a person open the sample outputs in AutoCAD or DWG TrueView and run AUDIT; note the result in the pull request.
3. After the merge, an admin tags the merge commit and pushes the tag:

   ```sh
   git switch main && git pull
   git tag v<x.y.z> && git push origin v<x.y.z>
   ```

4. Check the result: `npm view cad-axi@<x.y.z> dist.attestations` names the provenance, and `npm audit signatures` in a project that installs it verifies the signatures. A new package may first show a staged placeholder version; wait for the tarball before installing.

Comis pins one version with its attestations and a release-age rule. Moving Comis to a new version is a separate Comis pull request.

## Later: trusted publishing

npm can trust the workflow through OIDC, so the job holds no npm token. The package owner sets it up, signed in with two-step verification: on the package's access page, under **Trusted Publisher**, choose GitHub Actions with organization `comisai`, repository `cad-axi`, workflow `release.yml` and environment `npm`. Then remove `NODE_AUTH_TOKEN` from the publish step, release once through OIDC, delete the `NPM_TOKEN` secret and revoke that token.
