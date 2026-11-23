using System.Diagnostics;
using System.Text;
using ACadSharp;
using ACadSharp.Blocks;
using ACadSharp.Entities;
using ACadSharp.IO;
using ACadSharp.Objects;
using ACadSharp.Tables;

namespace CadAxi.Engine;

// The read verb. Records, in order: header; linetypes, styles, layers and
// blocks with their entity counts; external references and images as
// metadata; with --entities, one record per entity, or with --unit-evidence,
// just the dimensions, viewports and references in layouts; then entity kinds, the
// class census, non-graphical objects, and an end record with counts.
internal static class Reader
{
    public const long MaxEntities = 2_000_000;

    public static CadDocument Open(Options o, out string kind, out int errors, out int warnings)
    {
        if (o.File is null) throw new EngineError("usage");
        var info = new FileInfo(o.File);
        if (!info.Exists) throw new EngineError("not_found");
        if (info.Length > o.MaxBytes) throw new EngineError("too_large");
        var (k, code) = Sniff(o.File);
        if (k is null) throw new EngineError("not_cad");
        // R13 and older DWG are not read (design §4.2).
        if (k == "dwg" && string.CompareOrdinal(code, "AC1014") < 0) throw new EngineError("unsupported");
        kind = k;

        var e = 0;
        var w = 0;
        void Note(object? sender, NotificationEventArgs n)
        {
            if (n.NotificationType == NotificationType.Error) e++;
            else if (n.NotificationType == NotificationType.Warning) w++;
        }

        CadDocument doc;
        try
        {
            doc = k == "dwg"
                ? DwgReader.Read(o.File, new DwgReaderConfiguration
                {
                    KeepUnknownEntities = true,
                    KeepUnknownNonGraphicalObjects = true,
                }, Note)
                : DxfReader.Read(o.File, new DxfReaderConfiguration
                {
                    KeepUnknownEntities = true,
                    KeepUnknownNonGraphicalObjects = true,
                }, Note);
        }
        catch (OutOfMemoryException) { throw new EngineError("too_large"); }
        catch (EngineError) { throw; }
        catch (Exception x) when (x.GetType().Name == "CadNotSupportedException") { throw new EngineError("unsupported"); }
        catch (Exception x) { throw new EngineError("damaged", x.GetType().Name); }
        errors = e;
        warnings = w;
        return doc;
    }

    public static int Run(Records rec, Options o)
    {
        var clock = Stopwatch.StartNew();
        var doc = Open(o, out var kind, out var errors, out var warnings);
        Census census;
        // A model that cannot be walked is a damaged file, not an engine fault.
        try { census = Emit(rec, doc, kind, o.Entities, o.UnitEvidence); }
        catch (EngineError) { throw; }
        catch (OutOfMemoryException) { throw new EngineError("too_large"); }
        catch (Exception x) { throw new EngineError("damaged", x.GetType().Name); }
        Finish(rec, census, errors, warnings, clock);
        return 0;
    }

    public sealed class Census
    {
        public long Entities;
        public long Unknown;
        public long Proxies;
        public long UnknownObjects;
    }

    private static Census Emit(Records rec, CadDocument doc, string kind, bool entities, bool unitEvidence)
    {
        // First pass: counts by layer and by block, and the kinds.
        var byLayer = new Dictionary<string, long>(StringComparer.Ordinal);
        var kinds = new SortedDictionary<string, long>(StringComparer.Ordinal);
        var unknownByClass = new Dictionary<string, long>(StringComparer.Ordinal);
        var census = new Census();
        foreach (var block in doc.BlockRecords)
        {
            foreach (var e in block.Entities)
            {
                census.Entities++;
                if (census.Entities > MaxEntities) throw new EngineError("too_large");
                var layer = e.Layer?.Name ?? "";
                byLayer[layer] = byLayer.GetValueOrDefault(layer) + 1;
                var name = KindOf(e);
                kinds[name] = kinds.GetValueOrDefault(name) + 1;
                if (e is UnknownEntity)
                {
                    census.Unknown++;
                    unknownByClass[name] = unknownByClass.GetValueOrDefault(name) + 1;
                }
                if (e is ProxyEntity) census.Proxies++;
            }
        }

        var h = doc.Header;
        rec.Write("header", w =>
        {
            w.WriteString("format", kind);
            w.WriteString("version", h.VersionString);
            w.WriteString("codepage", h.CodePage);
            w.WriteNumber("insunits", (int)h.InsUnits);
            w.WriteNumber("measurement", (int)h.MeasurementUnits);
            Json.Point(w, "extmin", h.ModelSpaceExtMin, lenient: true);
            Json.Point(w, "extmax", h.ModelSpaceExtMax, lenient: true);
            w.WriteNumber("ltscale", Json.Safe(h.LineTypeScale));
            w.WriteStartArray("layouts");
            foreach (var l in doc.Layouts.OrderBy(l => l.TabOrder))
            {
                w.WriteStartObject();
                w.WriteString("name", l.Name);
                w.WriteString("block", l.AssociatedBlock?.Name ?? "");
                w.WriteNumber("tab", l.TabOrder);
                w.WriteEndObject();
            }
            w.WriteEndArray();
        });

        foreach (var lt in doc.LineTypes)
        {
            rec.Write("linetype", w =>
            {
                w.WriteString("name", lt.Name);
                w.WriteString("description", lt.Description ?? "");
                w.WriteStartArray("pattern");
                foreach (var s in lt.Segments) w.WriteNumberValue(Json.Safe(s.Length));
                w.WriteEndArray();
                w.WriteBoolean("complex", lt.IsComplex);
            });
        }

        foreach (var s in doc.TextStyles)
        {
            rec.Write("style", w =>
            {
                var font = s.Filename ?? "";
                w.WriteString("name", s.Name);
                w.WriteString("font", font);
                w.WriteString("bigfont", s.BigFontFilename ?? "");
                w.WriteString("kind", FontKind(s));
                w.WriteBoolean("backwards", s.MirrorFlag.HasFlag(TextMirrorFlag.Backward));
                w.WriteBoolean("upside", s.MirrorFlag.HasFlag(TextMirrorFlag.UpsideDown));
                w.WriteNumber("height", Json.Safe(s.Height));
                w.WriteNumber("width", Json.Safe(s.Width));
            });
        }

        foreach (var layer in doc.Layers)
        {
            rec.Write("layer", w =>
            {
                w.WriteString("name", layer.Name);
                w.WriteBoolean("on", layer.IsOn);
                w.WriteBoolean("frozen", layer.Flags.HasFlag(LayerFlags.Frozen));
                w.WriteBoolean("locked", layer.Flags.HasFlag(LayerFlags.Locked));
                w.WriteBoolean("plot", layer.PlotFlag);
                Json.Color(w, layer.Color);
                w.WriteString("linetype", layer.LineType?.Name ?? "");
                w.WriteNumber("entities", byLayer.GetValueOrDefault(layer.Name));
            });
        }

        foreach (var b in doc.BlockRecords)
        {
            rec.Write("block", w =>
            {
                var flags = b.Flags;
                w.WriteString("name", b.Name);
                Json.Point(w, "base", b.BlockEntity?.BasePoint ?? CSMath.XYZ.Zero);
                w.WriteBoolean("layout", b.Layout is not null);
                w.WriteBoolean("anonymous", b.IsAnonymous);
                w.WriteBoolean("external", IsExternal(b));
                w.WriteBoolean("overlay", flags.HasFlag(BlockTypeFlags.XRefOverlay));
                w.WriteBoolean("dependent", flags.HasFlag(BlockTypeFlags.XRefDependent));
                // An external reference's path is never printed (protocol rules).
                w.WriteBoolean("path_present", !string.IsNullOrEmpty(b.BlockEntity?.XRefPath));
                w.WriteNumber("units", (int)b.Units);
                w.WriteStartArray("attributes");
                foreach (var a in b.AttributeDefinitions) w.WriteStringValue(a.Tag);
                w.WriteEndArray();
                w.WriteNumber("entities", b.Entities.Count);
            });
        }

        foreach (var image in doc.ImageDefinitions)
        {
            rec.Write("external", w =>
            {
                w.WriteString("kind", "image");
                w.WriteString("name", image.Name ?? "");
                w.WriteBoolean("path_present", !string.IsNullOrEmpty(image.FileName));
            });
        }
        foreach (var pdf in doc.PdfDefinitions)
        {
            rec.Write("external", w =>
            {
                w.WriteString("kind", "pdf");
                w.WriteString("name", pdf.Name ?? "");
                w.WriteBoolean("path_present", !string.IsNullOrEmpty(pdf.File));
            });
        }

        if (entities || unitEvidence)
        {
            foreach (var block in doc.BlockRecords)
            {
                if (!entities && block.Layout is null) continue;
                foreach (var e in block.Entities)
                    if (entities || e is Dimension or Viewport ||
                        (e is Insert i && i.Block is { } reference && IsExternal(reference)))
                        Entities.Write(rec, e, block.Name, unitEvidenceOnly: !entities);
            }
        }

        foreach (var (name, count) in kinds)
            rec.Write("kind", w => { w.WriteString("name", name); w.WriteNumber("count", count); });

        foreach (var c in doc.Classes)
        {
            rec.Write("class", w =>
            {
                w.WriteString("name", c.DxfName ?? "");
                w.WriteString("cpp", c.CppClassName ?? "");
                w.WriteString("app", c.ApplicationName ?? "");
                w.WriteNumber("instances", c.InstanceCount);
                w.WriteBoolean("entity", c.IsAnEntity);
                w.WriteNumber("unknown", unknownByClass.GetValueOrDefault(c.DxfName ?? ""));
            });
        }

        var objects = new SortedDictionary<string, (long Count, bool Unknown)>(StringComparer.Ordinal);
        var seen = new HashSet<ulong>();
        Walk(doc.RootDictionary, objects, seen, 0);
        foreach (var (name, (count, unknown)) in objects)
        {
            if (unknown) census.UnknownObjects += count;
            rec.Write("object", w =>
            {
                w.WriteString("name", name);
                w.WriteNumber("count", count);
                w.WriteBoolean("unknown", unknown);
            });
        }
        return census;
    }

    private static bool IsExternal(BlockRecord block) =>
        (block.Flags & (BlockTypeFlags.XRef | BlockTypeFlags.XRefOverlay)) != 0;

    public static void Finish(Records rec, Census census, int errors, int warnings, Stopwatch clock)
    {
        var ms = clock.ElapsedMilliseconds;
        var peak = Process.GetCurrentProcess().PeakWorkingSet64;
        rec.Close("end", w =>
        {
            w.WriteNumber("entities", census.Entities);
            w.WriteNumber("unknown", census.Unknown);
            w.WriteNumber("proxies", census.Proxies);
            w.WriteNumber("unknown_objects", census.UnknownObjects);
            w.WriteNumber("errors", errors);
            w.WriteNumber("warnings", warnings);
            w.WriteNumber("ms", ms);
            w.WriteNumber("peak_rss", peak);
        });
    }

    // Non-graphical objects by type, found from the root dictionary down.
    // Bounded in depth and by handle, so a cycle in a damaged file ends.
    private static void Walk(CadDictionary? dict, SortedDictionary<string, (long, bool)> into, HashSet<ulong> seen, int depth)
    {
        if (dict is null || depth > 32 || !seen.Add(dict.Handle)) return;
        foreach (var o in dict)
        {
            if (o is null) continue;
            var unknown = o.GetType().Name.StartsWith("Unknown", StringComparison.Ordinal);
            var name = o.ObjectName ?? o.GetType().Name;
            var (count, _) = into.GetValueOrDefault(name);
            into[name] = (count + 1, unknown);
            if (o is CadDictionary child) Walk(child, into, seen, depth + 1);
            else if (o.XDictionary is { } x) Walk(x, into, seen, depth + 1);
        }
    }

    public static string KindOf(Entity e) => e switch
    {
        UnknownEntity u => u.DxfClass?.DxfName ?? "UNKNOWN",
        _ => e.ObjectName ?? e.GetType().Name,
    };

    private static string FontKind(TextStyle s)
    {
        var f = (s.Filename ?? "").ToLowerInvariant();
        if (s.IsShapeFile || f.EndsWith(".shx", StringComparison.Ordinal)) return "shx";
        if (f.EndsWith(".ttf", StringComparison.Ordinal) || f.EndsWith(".otf", StringComparison.Ordinal)
            || f.EndsWith(".ttc", StringComparison.Ordinal)) return "ttf";
        // A bare name with no extension is an SHX font, as AutoCAD reads it.
        if (f.Length > 0 && !f.Contains('.')) return "shx";
        return "unknown";
    }

    // Which format a file is, by its first bytes. A DWG starts with its
    // version code; a DXF is text whose first group is a comment or a
    // section, or the binary DXF sentinel.
    public static (string? Kind, string? Code) Sniff(string path)
    {
        Span<byte> head = stackalloc byte[512];
        int n;
        using (var f = File.OpenRead(path)) n = f.Read(head);
        var bytes = head[..n];
        if (n >= 6 && bytes[0] == (byte)'A' && bytes[1] == (byte)'C'
            && char.IsAsciiDigit((char)bytes[2]) && char.IsAsciiDigit((char)bytes[3])
            && char.IsAsciiDigit((char)bytes[4]) && char.IsAsciiDigit((char)bytes[5]))
            return ("dwg", Encoding.ASCII.GetString(bytes[..6]));
        var text = Encoding.ASCII.GetString(bytes);
        if (text.StartsWith("AutoCAD Binary DXF", StringComparison.Ordinal)) return ("dxf", null);
        var lines = text.TrimStart('﻿').Split('\n', 6);
        if (lines.Length >= 2)
        {
            var group = lines[0].Trim();
            var value = lines[1].Trim();
            if ((group == "0" && value == "SECTION") || group == "999") return ("dxf", null);
        }
        return (null, null);
    }
}
