using System.Diagnostics;
using System.Globalization;
using System.Security.Cryptography;
using System.Text.Json;
using ACadSharp;
using ACadSharp.Blocks;
using ACadSharp.Entities;
using ACadSharp.IO;
using ACadSharp.Tables;
using ACadSharp.Types.Units;
using CSMath;

namespace CadAxi.Engine;

// The write and edit verbs. The front end validates every specification and
// every list of operations before the engine sees it; the engine still
// refuses what it does not know, with `usage`, and never adds an external
// reference, image, OLE object, field or data link.
internal static class Writer
{
    // write --spec <json> --out <path>: a new drawing.
    public static int Run(Records rec, Options o)
    {
        if (o.Spec is null || o.Out is null) throw new EngineError("usage");
        var clock = Stopwatch.StartNew();
        using var spec = Parse(o.Spec);
        var root = spec.RootElement;

        var version = Version(Str(root, "version") ?? "AC1032");
        var doc = new CadDocument(version);
        var h = doc.Header;
        if (Str(root, "codepage") is { } cp) h.CodePage = cp;
        h.InsUnits = Units(Str(root, "units") ?? "mm");
        SetTime(doc, root);

        if (root.TryGetProperty("linetypes", out var lts))
            foreach (var l in lts.EnumerateArray()) AddLinetype(doc, l);
        if (root.TryGetProperty("styles", out var styles))
            foreach (var s in styles.EnumerateArray()) AddStyle(doc, s);
        if (root.TryGetProperty("layers", out var layers))
            foreach (var l in layers.EnumerateArray()) AddLayer(doc, l);
        if (root.TryGetProperty("blocks", out var blocks))
            foreach (var b in blocks.EnumerateArray())
            {
                var record = new BlockRecord(Str(b, "name") ?? throw new EngineError("usage"));
                if (b.TryGetProperty("base", out _)) record.BlockEntity.BasePoint = Xyz(b, "base");
                doc.BlockRecords.Add(record);
                foreach (var e in b.GetProperty("entities").EnumerateArray()) record.Entities.Add(Build(doc, e));
            }
        if (root.TryGetProperty("entities", out var list))
            foreach (var e in list.EnumerateArray())
                Space(doc, Str(e, "space")).Entities.Add(Build(doc, e));

        // Many simple entities, for the engine proof's time and memory measures.
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

        Save(rec, doc, o.Out, clock, []);
        return 0;
    }

    // edit <file> --ops <json> --out <path>: a copy with operations applied.
    // With no operations it is a conversion: --as names the output version.
    public static int Edit(Records rec, Options o)
    {
        if (o.Ops is null || o.Out is null) throw new EngineError("usage");
        var clock = Stopwatch.StartNew();
        var doc = Reader.Open(o, out _, out _, out _);
        using var ops = Parse(o.Ops);
        var added = new List<(int Index, string Handle)>();
        var index = 0;
        foreach (var op in ops.RootElement.GetProperty("ops").EnumerateArray())
        {
            var h = Apply(doc, op);
            if (h is not null) added.Add((index, h));
            index++;
        }
        if (o.As is not null) doc.Header.Version = Version(o.As);
        // A file from another program may lack default objects a writer
        // needs, such as the Standard multiline style; they are added.
        doc.UpdateCollections(true, true);
        Save(rec, doc, o.Out, clock, added);
        return 0;
    }

    private static string? Apply(CadDocument doc, JsonElement op)
    {
        var name = Str(op, "op") ?? throw new EngineError("usage");
        switch (name)
        {
            case "add_layer":
                AddLayer(doc, op);
                return null;
            case "set_text":
                switch (Find(doc, op))
                {
                    case MText m: m.Value = Str(op, "value") ?? ""; break;
                    case TextEntity t: t.Value = Str(op, "value") ?? ""; break;
                    default: throw new EngineError("invalid_spec");
                }
                return null;
            case "set_attribute":
            {
                if (Find(doc, op) is not Insert insert) throw new EngineError("invalid_spec");
                var tag = Str(op, "tag") ?? throw new EngineError("usage");
                var attribute = insert.Attributes.FirstOrDefault(a => a.Tag == tag) ?? throw new EngineError("invalid_spec");
                attribute.Value = Str(op, "value") ?? "";
                return null;
            }
            case "move":
                Find(doc, op).ApplyTranslation(Xyz(op, "by"));
                return null;
            case "delete":
            {
                var e = Find(doc, op);
                if (e.Owner is BlockRecord owner) owner.Entities.Remove(e);
                else throw new EngineError("invalid_spec");
                return null;
            }
            case "set_layer":
            {
                var e = Find(doc, op);
                var layer = Str(op, "layer") ?? throw new EngineError("usage");
                e.Layer = doc.Layers.TryGetValue(layer, out var found) ? found : throw new EngineError("unknown_layer");
                return null;
            }
            default:
                if (!name.StartsWith("add_", StringComparison.Ordinal)) throw new EngineError("usage");
                var entity = Build(doc, op, name[4..]);
                Space(doc, Str(op, "space")).Entities.Add(entity);
                return entity.Handle.ToString("X");
        }
    }

    private static Entity Find(CadDocument doc, JsonElement op)
    {
        var text = Str(op, "h") ?? throw new EngineError("usage");
        if (!ulong.TryParse(text, NumberStyles.HexNumber, CultureInfo.InvariantCulture, out var handle))
            throw new EngineError("unknown_handle");
        return doc.TryGetCadObject<Entity>(handle, out var e) && e is not null ? e : throw new EngineError("unknown_handle");
    }

    private static BlockRecord Space(CadDocument doc, string? layout)
    {
        if (layout is null || layout == "Model") return doc.ModelSpace;
        var found = doc.Layouts.FirstOrDefault(l => l.Name == layout)?.AssociatedBlock;
        return found ?? throw new EngineError("invalid_spec");
    }

    private static void Save(Records rec, CadDocument doc, string path, Stopwatch clock, List<(int Index, string Handle)> added)
    {
        var dxf = path.EndsWith(".dxf", StringComparison.OrdinalIgnoreCase);
        FileStream stream;
        // CreateNew refuses a file that is already there; it is left alone.
        try { stream = new FileStream(path, FileMode.CreateNew, FileAccess.Write); }
        catch (IOException) { throw new EngineError(File.Exists(path) ? "exists" : "internal_error"); }
        catch (UnauthorizedAccessException) { throw new EngineError("internal_error"); }
        try
        {
            using (stream)
            {
                if (dxf) DxfWriter.Write(stream, doc, false, new DxfWriterConfiguration { CloseStream = false }, null);
                else DwgWriter.Write(stream, doc, new DwgWriterConfiguration { CloseStream = false }, null);
            }
        }
        catch (Exception e)
        {
            TryDelete(path);
            if (Environment.GetEnvironmentVariable("CAD_AXI_ENGINE_TRACE") == "1") Console.Error.WriteLine(e);
            if (e is EngineError) throw;
            throw new EngineError(e.GetType().Name == "CadNotSupportedException" ? "unsupported" : "internal_error", e.GetType().Name);
        }

        var bytes = File.ReadAllBytes(path);
        var sha = Convert.ToHexStringLower(SHA256.HashData(bytes));
        var ms = clock.ElapsedMilliseconds;
        var peak = Process.GetCurrentProcess().PeakWorkingSet64;
        rec.Close("end", w =>
        {
            w.WriteString("version", doc.Header.VersionString);
            w.WriteString("format", dxf ? "dxf" : "dwg");
            w.WriteNumber("bytes", bytes.Length);
            w.WriteString("sha256", sha);
            w.WriteStartArray("added");
            foreach (var (i, h) in added)
            {
                w.WriteStartObject();
                w.WriteNumber("op", i);
                w.WriteString("h", h);
                w.WriteEndObject();
            }
            w.WriteEndArray();
            w.WriteNumber("ms", ms);
            w.WriteNumber("peak_rss", peak);
        });
    }

    private static void SetTime(CadDocument doc, JsonElement root)
    {
        // Fixed header times, so the same specification gives the same
        // content. FingerPrintGuid and VersionGuid are read-only in ACadSharp
        // 3.8.35, so DWG bytes still differ in those two fields.
        if (Str(root, "time") is not { } text) return;
        var t = DateTime.Parse(text, CultureInfo.InvariantCulture,
            DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal);
        var h = doc.Header;
        h.CreateDateTime = t;
        h.UpdateDateTime = t;
        h.UniversalCreateDateTime = t;
        h.UniversalUpdateDateTime = t;
        h.TotalEditingTime = TimeSpan.Zero;
        h.UserElapsedTimeSpan = TimeSpan.Zero;
    }

    private static void AddLinetype(CadDocument doc, JsonElement l)
    {
        var name = Str(l, "name") ?? throw new EngineError("usage");
        if (doc.LineTypes.Contains(name)) return;
        var lt = new LineType(name) { Description = Str(l, "description") ?? "" };
        if (l.TryGetProperty("pattern", out var pattern))
            foreach (var len in pattern.EnumerateArray())
                lt.AddSegment(new LineType.Segment { Length = Finite(len.GetDouble()) });
        doc.LineTypes.Add(lt);
    }

    private static void AddStyle(CadDocument doc, JsonElement s)
    {
        var name = Str(s, "name") ?? throw new EngineError("usage");
        if (doc.TextStyles.Contains(name)) return;
        var style = new TextStyle(name) { Filename = Str(s, "font") ?? "arial.ttf" };
        if (Str(s, "bigfont") is { } big) style.BigFontFilename = big;
        if (s.TryGetProperty("height", out var hgt)) style.Height = Finite(hgt.GetDouble());
        if (s.TryGetProperty("width", out var wid)) style.Width = Finite(wid.GetDouble());
        doc.TextStyles.Add(style);
    }

    private static void AddLayer(CadDocument doc, JsonElement l)
    {
        var name = Str(l, "name") ?? throw new EngineError("usage");
        if (doc.Layers.Contains(name)) throw new EngineError("invalid_spec");
        var layer = new Layer(name)
        {
            Color = new Color((short)(l.TryGetProperty("color", out var c) ? c.GetInt32() : 7)),
        };
        if (Str(l, "linetype") is { } lt)
            layer.LineType = doc.LineTypes.TryGetValue(lt, out var found) ? found : throw new EngineError("invalid_spec");
        if (l.TryGetProperty("off", out var off) && off.GetBoolean()) layer.IsOn = false;
        if (l.TryGetProperty("frozen", out var fr) && fr.GetBoolean()) layer.Flags |= LayerFlags.Frozen;
        if (l.TryGetProperty("locked", out var lk) && lk.GetBoolean()) layer.Flags |= LayerFlags.Locked;
        doc.Layers.Add(layer);
    }

    // An entity of the closed grammar: line, polyline, circle, arc, text,
    // mtext, point and insert. Angles in the grammar are degrees.
    private static Entity Build(CadDocument doc, JsonElement e, string? kind = null)
    {
        kind ??= Str(e, "kind");
        Entity entity = kind switch
        {
            "line" => new Line(Xyz(e, "from"), Xyz(e, "to")),
            "polyline" => Polyline(e),
            "circle" => new Circle { Center = Xyz(e, "center"), Radius = Num(e, "radius") },
            "arc" => new Arc
            {
                Center = Xyz(e, "center"),
                Radius = Num(e, "radius"),
                StartAngle = Rad(Num(e, "start")),
                EndAngle = Rad(Num(e, "end")),
            },
            "point" => new Point(Xyz(e, "at")),
            "text" => new TextEntity
            {
                Value = Str(e, "value") ?? "",
                InsertPoint = Xyz(e, "at"),
                Height = Num(e, "height"),
                Rotation = Rad(Opt(e, "rotation", 0)),
            },
            "mtext" => new MText
            {
                Value = Str(e, "value") ?? "",
                InsertPoint = Xyz(e, "at"),
                Height = Num(e, "height"),
                RectangleWidth = Opt(e, "width", 0),
            },
            "insert" => Insert(doc, e),
            "attdef" => new AttributeDefinition
            {
                Tag = Str(e, "tag") ?? throw new EngineError("usage"),
                Prompt = Str(e, "prompt") ?? "",
                Value = Str(e, "value") ?? "",
                InsertPoint = Xyz(e, "at"),
                Height = Num(e, "height"),
            },
            _ => throw new EngineError("usage"),
        };
        if (Str(e, "layer") is { } layer)
            entity.Layer = doc.Layers.TryGetValue(layer, out var found) ? found : throw new EngineError("unknown_layer");
        if (Str(e, "linetype") is { } lt)
            entity.LineType = doc.LineTypes.TryGetValue(lt, out var found) ? found : throw new EngineError("invalid_spec");
        if (e.TryGetProperty("color", out var color)) entity.Color = new Color((short)color.GetInt32());
        if (Str(e, "style") is { } style)
        {
            var s = doc.TextStyles.TryGetValue(style, out var found) ? found : throw new EngineError("invalid_spec");
            if (entity is TextEntity t) t.Style = s;
            else if (entity is MText m) m.Style = s;
        }
        return entity;
    }

    private static Insert Insert(CadDocument doc, JsonElement e)
    {
        var name = Str(e, "block") ?? throw new EngineError("usage");
        if (!doc.BlockRecords.TryGetValue(name, out var block) || block.Layout is not null
            || block.Flags.HasFlag(BlockTypeFlags.XRef) || block.Flags.HasFlag(BlockTypeFlags.XRefOverlay))
            throw new EngineError("unknown_block");
        var insert = new Insert(block)
        {
            InsertPoint = Xyz(e, "at"),
            Rotation = Rad(Opt(e, "rotation", 0)),
        };
        if (e.TryGetProperty("scale", out var s))
        {
            insert.XScale = Finite(s[0].GetDouble());
            insert.YScale = Finite(s[1].GetDouble());
            insert.ZScale = s.GetArrayLength() > 2 ? Finite(s[2].GetDouble()) : 1;
        }
        if (e.TryGetProperty("attribs", out var attribs))
            foreach (var a in attribs.EnumerateObject())
            {
                var at = insert.Attributes.FirstOrDefault(x => x.Tag == a.Name) ?? throw new EngineError("invalid_spec");
                at.Value = a.Value.GetString() ?? "";
            }
        return insert;
    }

    private static LwPolyline Polyline(JsonElement e)
    {
        var p = new LwPolyline { IsClosed = e.TryGetProperty("closed", out var c) && c.GetBoolean() };
        var pts = e.GetProperty("pts").EnumerateArray().ToArray();
        var bulges = e.TryGetProperty("bulges", out var b) ? b.EnumerateArray().Select(x => x.GetDouble()).ToArray() : [];
        for (var i = 0; i < pts.Length; i++)
        {
            var v = new LwPolyline.Vertex(new XY(Finite(pts[i][0].GetDouble()), Finite(pts[i][1].GetDouble())));
            if (i < bulges.Length) v.Bulge = Finite(bulges[i]);
            p.Vertices.Add(v);
        }
        return p;
    }

    private static JsonDocument Parse(string path)
    {
        try { return JsonDocument.Parse(File.ReadAllBytes(path), new JsonDocumentOptions { MaxDepth = 16 }); }
        catch (JsonException) { throw new EngineError("usage"); }
        catch (IOException) { throw new EngineError("usage"); }
    }

    private static double Rad(double degrees) => degrees * Math.PI / 180;

    private static double Finite(double v) => double.IsFinite(v) ? v : throw new EngineError("usage");

    private static double Num(JsonElement e, string name) =>
        e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number ? Finite(v.GetDouble()) : throw new EngineError("usage");

    private static double Opt(JsonElement e, string name, double fallback) =>
        e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number ? Finite(v.GetDouble()) : fallback;

    private static XYZ Xyz(JsonElement e, string name)
    {
        var a = e.GetProperty(name);
        var z = a.GetArrayLength() > 2 ? a[2].GetDouble() : 0;
        return new XYZ(Finite(a[0].GetDouble()), Finite(a[1].GetDouble()), Finite(z));
    }

    private static string? Str(JsonElement e, string name) =>
        e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    public static ACadVersion Version(string code) => code switch
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
