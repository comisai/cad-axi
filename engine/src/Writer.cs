using System.Diagnostics;
using System.Globalization;
using System.Security.Cryptography;
using System.Text.Json;
using ACadSharp;
using ACadSharp.Entities;
using ACadSharp.IO;
using ACadSharp.Tables;
using ACadSharp.Types.Units;
using CSMath;

namespace CadAxi.Engine;

// The write verb, as far as the engine proof needs it: a new drawing from
// a small specification. The front end validates specifications before the
// engine sees them; the engine still refuses what it does not know.
internal static class Writer
{
    public static int Run(Records rec, Options o)
    {
        if (o.Spec is null || o.Out is null) throw new EngineError("usage");
        var clock = Stopwatch.StartNew();
        using var spec = JsonDocument.Parse(File.ReadAllBytes(o.Spec));
        var root = spec.RootElement;

        var version = Version(Str(root, "version") ?? "AC1032");
        var doc = new CadDocument(version);
        var h = doc.Header;
        if (Str(root, "codepage") is { } cp) h.CodePage = cp;
        h.InsUnits = Units(Str(root, "units") ?? "mm");

        // Fixed header times and identifiers, so the same specification can
        // give the same bytes (implementation plan T7).
        if (root.TryGetProperty("fixed", out var fx))
        {
            var t = DateTime.Parse(Str(fx, "time") ?? "2026-01-01T00:00:00Z", CultureInfo.InvariantCulture,
                DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal);
            h.CreateDateTime = t;
            h.UpdateDateTime = t;
            h.UniversalCreateDateTime = t;
            h.UniversalUpdateDateTime = t;
            h.TotalEditingTime = TimeSpan.Zero;
            h.UserElapsedTimeSpan = TimeSpan.Zero;
            // FingerPrintGuid and VersionGuid are read-only in ACadSharp 3.8.35,
            // so they cannot be fixed here; the proof records what differs.
        }

        if (root.TryGetProperty("layers", out var layers))
            foreach (var l in layers.EnumerateArray())
                doc.Layers.Add(new Layer(Str(l, "name") ?? throw new EngineError("usage"))
                {
                    Color = new Color((short)(l.TryGetProperty("color", out var c) ? c.GetInt32() : 7)),
                });

        if (root.TryGetProperty("entities", out var list))
            foreach (var e in list.EnumerateArray())
                doc.Entities.Add(Build(doc, e));

        // Many simple entities for the time and memory measures (Q8).
        if (root.TryGetProperty("stress", out var stress))
        {
            var n = stress.GetProperty("lines").GetInt32();
            var layer = new Layer("STRESS");
            doc.Layers.Add(layer);
            for (var i = 0; i < n; i++)
            {
                var x = (i % 1000) * 10.0;
                var y = (i / 1000) * 10.0;
                doc.Entities.Add(new Line(new XYZ(x, y, 0), new XYZ(x + 8, y, 0)) { Layer = layer });
                if (i % 10 == 0)
                    doc.Entities.Add(new TextEntity { Value = "Ø110 " + i, InsertPoint = new XYZ(x, y + 2, 0), Height = 2, Layer = layer });
            }
        }

        var dxf = o.Out.EndsWith(".dxf", StringComparison.OrdinalIgnoreCase);
        try
        {
            using (var stream = new FileStream(o.Out, FileMode.CreateNew, FileAccess.Write))
            {
                if (dxf) DxfWriter.Write(stream, doc, false, new DxfWriterConfiguration { CloseStream = false }, null);
                else DwgWriter.Write(stream, doc, new DwgWriterConfiguration { CloseStream = false }, null);
            }
        }
        catch (IOException) when (File.Exists(o.Out) && new FileInfo(o.Out).Length == 0)
        {
            File.Delete(o.Out);
            throw new EngineError("internal_error");
        }
        catch (Exception e) when (e is not EngineError)
        {
            TryDelete(o.Out);
            throw new EngineError(e.GetType().Name == "CadNotSupportedException" ? "unsupported" : "internal_error");
        }

        var bytes = File.ReadAllBytes(o.Out);
        var sha = Convert.ToHexStringLower(SHA256.HashData(bytes));
        var ms = clock.ElapsedMilliseconds;
        var peak = Process.GetCurrentProcess().PeakWorkingSet64;
        rec.Close("end", w =>
        {
            w.WriteString("version", doc.Header.VersionString);
            w.WriteNumber("bytes", bytes.Length);
            w.WriteString("sha256", sha);
            w.WriteNumber("ms", ms);
            w.WriteNumber("peak_rss", peak);
        });
        return 0;
    }

    private static Entity Build(CadDocument doc, JsonElement e)
    {
        var layer = Str(e, "layer") is { } name
            ? (doc.Layers.TryGetValue(name, out var found) ? found : throw new EngineError("unknown_layer"))
            : null;
        Entity entity = Str(e, "kind") switch
        {
            "LINE" => new Line(Xyz(e, "from"), Xyz(e, "to")),
            "CIRCLE" => new Circle { Center = Xyz(e, "center"), Radius = e.GetProperty("radius").GetDouble() },
            "TEXT" => new TextEntity { Value = Str(e, "value") ?? "", InsertPoint = Xyz(e, "at"), Height = e.GetProperty("height").GetDouble() },
            "MTEXT" => new MText { Value = Str(e, "value") ?? "", InsertPoint = Xyz(e, "at"), Height = e.GetProperty("height").GetDouble() },
            "LWPOLYLINE" => Polyline(e),
            _ => throw new EngineError("usage"),
        };
        if (layer is not null) entity.Layer = layer;
        return entity;
    }

    private static LwPolyline Polyline(JsonElement e)
    {
        var p = new LwPolyline { IsClosed = e.TryGetProperty("closed", out var c) && c.GetBoolean() };
        var pts = e.GetProperty("pts").EnumerateArray().ToArray();
        var bulges = e.TryGetProperty("bulges", out var b) ? b.EnumerateArray().Select(x => x.GetDouble()).ToArray() : [];
        for (var i = 0; i < pts.Length; i++)
        {
            var v = new LwPolyline.Vertex(new XY(pts[i][0].GetDouble(), pts[i][1].GetDouble()));
            if (i < bulges.Length) v.Bulge = bulges[i];
            p.Vertices.Add(v);
        }
        return p;
    }

    private static XYZ Xyz(JsonElement e, string name)
    {
        var a = e.GetProperty(name);
        var z = a.GetArrayLength() > 2 ? a[2].GetDouble() : 0;
        var p = new XYZ(a[0].GetDouble(), a[1].GetDouble(), z);
        if (!double.IsFinite(p.X) || !double.IsFinite(p.Y) || !double.IsFinite(p.Z)) throw new EngineError("usage");
        return p;
    }

    private static string? Str(JsonElement e, string name) =>
        e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    private static ACadVersion Version(string code) => code switch
    {
        "AC1014" => ACadVersion.AC1014,
        "AC1015" => ACadVersion.AC1015,
        "AC1018" => ACadVersion.AC1018,
        "AC1021" => ACadVersion.AC1021,
        "AC1024" => ACadVersion.AC1024,
        "AC1027" => ACadVersion.AC1027,
        "AC1032" => ACadVersion.AC1032,
        _ => throw new EngineError("unsupported"),
    };

    private static UnitsType Units(string u) => u switch
    {
        "mm" => UnitsType.Millimeters,
        "cm" => UnitsType.Centimeters,
        "m" => UnitsType.Meters,
        "in" => UnitsType.Inches,
        "ft" => UnitsType.Feet,
        "none" => UnitsType.Unitless,
        _ => throw new EngineError("usage"),
    };

    private static void TryDelete(string path)
    {
        try { if (File.Exists(path)) File.Delete(path); } catch (IOException) { }
    }
}
