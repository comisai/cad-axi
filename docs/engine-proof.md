# cad-axi: engine proof

| | |
| --- | --- |
| Status | M2 passed on made-up drawings and ACadSharp's sample drawings, on both platforms (2026-11-22). T10, the private pass over the owner's DWG files, waits for A2. |
| Date | 2026-11-22 |
| Run | CI run 45010814181 on comisai/cad-axi#3 |
| Engine | 0.0.0 on ACadSharp 3.8.35, .NET SDK 10.0.404, NativeAOT |
| Plans | [Design](cad-axi-design.md), [implementation plan](cad-axi-implementation-plan.md) (M2, T3 to T10), [master plan](cad-axi-master-plan.md) |

## 1. Result

The chosen stack holds. ACadSharp compiled with NativeAOT builds and runs on native linux-x64 and linux-arm64 runners. It reads every version it claims, writes and reads back Hebrew in code page 1255, stops at its limits with a closed error, and packs into a 9.2 MiB npm tarball whose engines stay executable after install.

| Gate | linux-x64 | linux-arm64 |
| --- | --- | --- |
| Engine proof (`scripts/engine-proof.mjs`) | 47 of 47 | 47 of 47 |
| Independent checks (`scripts/oracles/cross-check.mjs`, x64) | 15 of 15 | — |
| Package check and install | pass | pass |

How to run it: `.github/workflows/ci.yml` runs everything on every pull request. Locally, `scripts/engine-dev.Dockerfile` builds an image with the SDK and the native toolchain; the proof then runs with Node in any Debian trixie container.

## 2. The open questions it settles

| ID | Question | Answer |
| --- | --- | --- |
| Q1 | Does NativeAOT work on linux-x64? | **Yes.** 10.1 MB on x64 and 10.5 MB on arm64. Rooting the ACadSharp assembly (`TrimmerRootAssembly`) is required; the build prints ACadSharp's trim and AOT warnings. The newest C library symbol is `GLIBC_2.38` on both, below Debian trixie's 2.41. `probe` starts in 5.5 ms (x64) and 5.2 ms (arm64), median of 20. |
| Q2 | Does Hebrew in code page 1255 read correctly from an R2000 DWG? | **Yes for ACadSharp's own output, confirmed by two independent readers.** An R2000 DWG and DXF written with `ANSI_1255` read back with the Hebrew unchanged. LibreDWG's `dwgread` reads the same Hebrew from every DWG the engine wrote, R2000 to 2018. ezdxf reads it from the engine's R2000 and 2018 DXF, with no audit errors. The engine reads Hebrew from an R2000 DXF that ezdxf wrote in code page 1255. **Not yet shown:** an R2000 DWG in code page 1255 written by AutoCAD. That needs the owner's files (A2). |
| Q5 | Can writes be repeatable? | **DXF yes; DWG all but two fields.** Two writes of one specification give identical DXF. DWG differs only in `$FINGERPRINTGUID` and `$VERSIONGUID`, which ACadSharp 3.8.35 makes read-only and generates for each write, and in the header CRC that covers them: 61 to 63 bytes in R2000, 259 to 267 in 2018, where compression spreads the change. The verify loop compares content, not bytes (design §8.9), so nothing depends on this. A setter is a small upstream change to propose. |
| Q6 | Does the heap limit work in a NativeAOT binary? | **Yes, written as hex without `0x`.** `DOTNET_GCHeapHardLimit=3000000` gives a 48 MiB limit, and a 220,000-entity read then ends in `too_large` with exit 1, not a kill. With a `0x` prefix the setting is ignored. Under a container memory limit and no setting, the limit is 75% of the container's (384 MiB under 512 MiB). |
| Q8 | How long and how much memory do large drawings take? | **About 13 µs and 2.5 KB per entity to read.** See §3. A 20.6 MB DWG of 1.1 million simple entities reads in 14 to 15 s with a 2.6 to 2.8 GiB peak. That is near the Comis file limit and over the design's starting 1 GiB heap (§5). |

## 3. Measures

**Large drawings** (lines and texts, written by the engine at AC1032; times from the engine, peak resident memory from the process):

| Entities | DWG | Write | Write peak | Read | Read peak |
| --- | --- | --- | --- | --- | --- |
| 110,001 | 2.0 MiB | 0.7 s | 156 to 209 MiB | 1.2 to 1.3 s | 309 to 372 MiB |
| 330,001 | 5.9 MiB | 2.3 to 2.5 s | 403 to 423 MiB | 3.9 to 4.1 s | 902 to 968 MiB |
| 1,100,001 | 19.6 MiB | 7.2 to 8.0 s | 1.1 to 1.2 GiB | 14.1 to 15.0 s | 2.6 to 2.8 GiB |

The first figure of each pair is x64, the second arm64. Real drawings hold heavier entities than lines, so these are lower bounds per entity.

**ACadSharp's sample drawings** (MIT, pinned at tag v3.8.35 and checked by SHA-256): all eight read on both platforms with 341 entities each, R14 to 2018 and the R2000 DXF, in 16 to 33 ms per DWG and under 31 MiB. LibreDWG agrees with the engine on every simple entity kind (LINE, CIRCLE, ARC, LWPOLYLINE, TEXT, MTEXT, INSERT, POINT, ELLIPSE, SPLINE) in all seven DWG samples. The other differences are naming: LibreDWG splits dimensions and polylines into subtypes and lists vertices, block and end-of-block records; ACadSharp reads tables, multileaders, meshes, images, PDF underlays and wipeouts that LibreDWG 0.14 leaves out.

**Hostile files:** 21 made-up damaged files each ended in a closed error, on both platforms, in 5 to 21 ms. The files were cut short at four lengths, bit-flipped at two rates (12 files), a version code with nothing after it, a version code before random bytes, an R13 code, an empty file and a DXF with garbage. Eighteen reported `damaged`, one `too_large` (a flipped count asked for more memory than its 512 MiB limit), one `unsupported` and one `not_cad`. No file crashed the engine or ran to its time limit.

**Limits:** the input cap refuses a file over `--max-bytes`; `--time-limit-ms 20` stops a two-second read with `timed_out` at once; the heap limit is above.

**Package:** 9.2 MiB packed, 19.6 MiB unpacked, seven files: the two engines, a stub CLI, `package.json`, README, LICENSE and NOTICE. Installed from the tarball into a clean folder on each platform, the engine is mode 755 and `npx cad-axi` runs its probe.

## 4. Findings

1. **Characters outside the code page are lost in pre-2007 files.** `Ø110 ש` written to an R2000 DWG in code page 1255 reads back as `?110 ש`, because 1255 has no `Ø`. This is the loss design §8.3 warns about. Real drawings write the diameter sign as `%%c`, which survives. The tool must warn whenever an older output version would lose characters.
2. **ACadSharp's reader loses most of its own R14 output.** In the R14 file the engine wrote, ACadSharp reads back only the LINE; LibreDWG reads all five entities and the Hebrew. ACadSharp reads AutoCAD's R14 sample in full. cad-axi offers no R14 output (design §7), so this does not block anything. It is an upstream issue to report.
3. **ACadSharp cannot read LibreDWG 0.14's DWG output.** From the same ezdxf DXF, LibreDWG writes an R2000 and an R2004 DWG that it reads back itself. ACadSharp fails on them with `EndOfStreamException` and `ArgumentException`. AutoCAD is also reported to ask to recover LibreDWG-written files, so these are not a fair test of the reader. LibreDWG stays an independent reader, where it agrees with the engine, and ezdxf is the independent producer for DXF.
4. **AC1021 writing is refused cleanly.** ACadSharp 3.8.35 has no AC1021 writer; the engine reports `unsupported` and leaves no file.
5. **Header extents are not set on write.** A written drawing's `$EXTMIN` and `$EXTMAX` are zero. `info` must compute extents from the entities, not trust the header.
6. **`DOTNET_GCHeapHardLimit` takes hex digits without `0x`.** A value with the prefix is silently ignored. The front end must write it that way and check the limit the engine reports.

## 5. What changes in the plans

- **Engine heap.** The design's starting heap of 1 GiB refuses drawings over about 350,000 simple entities. The front end will set the heap from the workbench's own memory limit, leaving room for Node, and report `too_large` with the limit it used. The default is to be chosen in T12 with real drawings.
- **Repeatable writes** stop at the two GUIDs. Record the byte differences in the write record. Propose setters upstream.
- **Upstream reports to ACadSharp:** the R14 self-read loss, the read-only GUIDs, and the failure to read LibreDWG's output, each with a made-up file.
- **Independent producers:** ezdxf for DXF; for DWG, AutoCAD's own files (the ACadSharp samples, and the owner's files at A2). Not LibreDWG 0.14.
- **The protocol** gains an `exception` field on `damaged`, holding the exception's type name and nothing from the file.

## 6. Not done here

- **T10, the private pass over the owner's DWG files,** waits for A2. The owner's earlier drawing folder held PDFs and spreadsheets, no DWG.
- **The rest of T2's settings** (branch protection, the tag rule, the npm environment) are applied after this pull request's checks exist.
- **Fuzzing** (T26) and the front end (M3) come next.
