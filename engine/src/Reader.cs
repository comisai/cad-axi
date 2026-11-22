using System.Diagnostics;
using System.Text;
using System.Text.Json;
using ACadSharp;
using ACadSharp.Entities;
using ACadSharp.IO;
using ACadSharp.Tables;
using CSMath;

namespace CadAxi.Engine;

// The read verb: a header record, layer records, optional entity records,
// a class census and an end record with counts.
internal static class Reader
{
    public static int Run(Records rec, Options o)
    {
        if (o.File is null) throw new EngineError("usage");
        var info = new FileInfo(o.File);
        if (!info.Exists) throw new EngineError("not_found");
        if (info.Length > o.MaxBytes) throw new EngineError("too_large");
        var (kind, code) = Sniff(o.File);
        if (kind is null) throw new EngineError("not_cad");
        // R13 and older DWG are not read (design §4.2).
        if (kind == "dwg" && string.CompareOrdinal(code, "AC1014") < 0) throw new EngineError("unsupported");

        var clock = Stopwatch.StartNew();
        var errors = 0;
        var warnings = 0;
        void Note(object? sender, NotificationEventArgs e)
        {
            if (e.NotificationType == NotificationType.Error) errors++;
            else if (e.NotificationType == NotificationType.Warning) warnings++;
        }

        CadDocument doc;
        try
        {
            doc = kind == "dwg"
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
        catch (Exception e) when (e.GetType().Name == "CadNotSupportedException") { throw new EngineError("unsupported"); }
        catch (Exception e) { throw new EngineError("damaged", e.GetType().Name); }

        var header = doc.Header;
        rec.Write("header", w =>
        {
            w.WriteString("format", kind);
            w.WriteString("version", header.VersionString);
            w.WriteString("codepage", header.CodePage);
            w.WriteNumber("insunits", (int)header.InsUnits);
            Point(w, "extmin", header.ModelSpaceExtMin);
            Point(w, "extmax", header.ModelSpaceExtMax);
            w.WriteStartArray("layouts");
            foreach (var l in doc.Layouts) w.WriteStringValue(l.Name);
            w.WriteEndArray();
        });

        foreach (var layer in doc.Layers)
        {
            rec.Write("layer", w =>
            {
                w.WriteString("name", layer.Name);
                w.WriteBoolean("on", layer.IsOn);
                w.WriteBoolean("frozen", layer.Flags.HasFlag(LayerFlags.Frozen));
                w.WriteBoolean("locked", layer.Flags.HasFlag(LayerFlags.Locked));
                w.WriteNumber("color", layer.Color.Index);
            });
        }

        // Entities by space: model space, each layout's paper space, and
        // the entities inside block definitions.
        var kinds = new SortedDictionary<string, int>(StringComparer.Ordinal);
        var unknown = new SortedDictionary<string, int>(StringComparer.Ordinal);
        long entities = 0;
        foreach (var block in doc.BlockRecords)
        {
            var space = block.Name;
            foreach (var e in block.Entities)
            {
                entities++;
                var name = e.ObjectName;
                kinds[name] = kinds.GetValueOrDefault(name) + 1;
                if (e is UnknownEntity u)
                {
                    var cls = u.DxfClass?.DxfName ?? name;
                    unknown[cls] = unknown.GetValueOrDefault(cls) + 1;
                }
                if (o.Entities) Entity(rec, e, space);
            }
        }

        foreach (var (name, count) in kinds)
            rec.Write("kind", w => { w.WriteString("name", name); w.WriteNumber("count", count); });

        foreach (var c in doc.Classes)
        {
            rec.Write("class", w =>
            {
                w.WriteString("name", c.DxfName);
                w.WriteString("cpp", c.CppClassName);
                w.WriteNumber("instances", c.InstanceCount);
                w.WriteBoolean("entity", c.IsAnEntity);
                w.WriteNumber("unknown", unknown.GetValueOrDefault(c.DxfName));
            });
        }

        var ms = clock.ElapsedMilliseconds;
        var peak = Process.GetCurrentProcess().PeakWorkingSet64;
        rec.Close("end", w =>
        {
            w.WriteNumber("entities", entities);
            w.WriteNumber("unknown", unknown.Values.Sum());
            w.WriteNumber("errors", errors);
            w.WriteNumber("warnings", warnings);
            w.WriteNumber("ms", ms);
            w.WriteNumber("peak_rss", peak);
        });
        return 0;
    }

    private static void Entity(Records rec, Entity e, string space)
    {
        rec.Write("entity", w =>
        {
            w.WriteString("h", e.Handle.ToString("X"));
            w.WriteString("kind", e.ObjectName);
            w.WriteString("layer", e.Layer?.Name ?? "");
            w.WriteString("space", space);
            switch (e)
            {
                case Line l:
                    Point(w, "from", l.StartPoint);
                    Point(w, "to", l.EndPoint);
                    break;
                case Circle c:
                    Point(w, "center", c.Center);
                    w.WriteNumber("radius", c.Radius);
                    break;
                case LwPolyline p:
                    w.WriteStartArray("pts");
                    foreach (var v in p.Vertices)
                    {
                        w.WriteStartArray();
                        w.WriteNumberValue(v.Location.X);
                        w.WriteNumberValue(v.Location.Y);
                        w.WriteEndArray();
                    }
                    w.WriteEndArray();
                    w.WriteStartArray("bulges");
                    foreach (var v in p.Vertices) w.WriteNumberValue(v.Bulge);
                    w.WriteEndArray();
                    w.WriteBoolean("closed", p.IsClosed);
                    break;
                case TextEntity t:
                    w.WriteString("raw", t.Value);
                    Point(w, "at", t.InsertPoint);
                    w.WriteNumber("height", t.Height);
                    w.WriteString("style", t.Style?.Name ?? "");
                    break;
                case MText m:
                    w.WriteString("raw", m.Value);
                    Point(w, "at", m.InsertPoint);
                    w.WriteNumber("height", m.Height);
                    w.WriteString("style", m.Style?.Name ?? "");
                    break;
            }
        });
    }

    private static void Point(Utf8JsonWriter w, string name, XYZ p)
    {
        w.WriteStartArray(name);
        Finite(w, p.X);
        Finite(w, p.Y);
        Finite(w, p.Z);
        w.WriteEndArray();
    }

    // A non-finite coordinate is never printed (design: protocol rules).
    private static void Finite(Utf8JsonWriter w, double v)
    {
        if (!double.IsFinite(v)) throw new EngineError("damaged");
        w.WriteNumberValue(v);
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
        var lines = text.Split('\n', 6);
        if (lines.Length >= 2)
        {
            var group = lines[0].Trim();
            var value = lines[1].Trim();
            if ((group == "0" && value == "SECTION") || group == "999") return ("dxf", null);
        }
        return (null, null);
    }
}
