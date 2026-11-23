using System.Text.Json;
using ACadSharp.Entities;
using CSMath;

namespace CadAxi.Engine;

// One entity record: what every entity has, then the geometry and text the
// front end needs for its kind. Angles are radians. Points are in the
// entity's own coordinate system where AutoCAD keeps them so (arcs, circles,
// polylines, text, inserts), with the normal that defines it; the front end
// turns them into world coordinates.
internal static class Entities
{
    public static void Write(Records rec, Entity e, string owner, bool unitEvidenceOnly)
    {
        rec.Write("entity", w =>
        {
            w.WriteString("h", e.Handle.ToString("X"));
            w.WriteString("kind", Reader.KindOf(e));
            w.WriteString("layer", e.Layer?.Name ?? "");
            w.WriteString("owner", owner);
            Json.Color(w, e.Color);
            w.WriteString("lt", e.LineType?.Name ?? "ByLayer");
            if (double.IsFinite(e.LineTypeScale) && e.LineTypeScale != 1) w.WriteNumber("lts", e.LineTypeScale);
            if (e.IsInvisible) w.WriteBoolean("invisible", true);
            Geometry(w, e, unitEvidenceOnly);
        });
    }

    private static void Normal(Utf8JsonWriter w, XYZ n)
    {
        if (n.X == 0 && n.Y == 0 && n.Z == 1) return;
        Json.Point(w, "n", n);
    }

    private static void Geometry(Utf8JsonWriter w, Entity e, bool unitEvidenceOnly)
    {
        switch (e)
        {
            case UnknownEntity:
                w.WriteBoolean("unknown", true);
                break;
            case ProxyEntity p:
                w.WriteBoolean("proxy", true);
                w.WriteString("class", p.DxfClass?.DxfName ?? "");
                break;
            case Line l:
                Json.Point(w, "a", l.StartPoint);
                Json.Point(w, "b", l.EndPoint);
                break;
            case Arc a:
                Json.Point(w, "c", a.Center);
                Json.Num(w, "r", a.Radius);
                Json.Num(w, "a0", a.StartAngle);
                Json.Num(w, "a1", a.EndAngle);
                Normal(w, a.Normal);
                break;
            case Circle c:
                Json.Point(w, "c", c.Center);
                Json.Num(w, "r", c.Radius);
                Normal(w, c.Normal);
                break;
            case Ellipse el:
                Json.Point(w, "c", el.Center);
                Json.Point(w, "major", el.MajorAxisEndPoint);
                Json.Num(w, "ratio", el.RadiusRatio);
                Json.Num(w, "t0", el.StartParameter);
                Json.Num(w, "t1", el.EndParameter);
                Normal(w, el.Normal);
                break;
            case LwPolyline p:
                w.WriteStartArray("pts");
                foreach (var v in p.Vertices) Json.Point2(w, v.Location);
                w.WriteEndArray();
                w.WriteStartArray("bulges");
                foreach (var v in p.Vertices) Json.Value(w, v.Bulge);
                w.WriteEndArray();
                w.WriteBoolean("closed", p.IsClosed);
                if (p.Elevation != 0) Json.Num(w, "elev", p.Elevation);
                Normal(w, p.Normal);
                break;
            case Polyline2D p:
                w.WriteStartArray("pts");
                foreach (var v in p.Vertices) Json.PointValue(w, v.Location);
                w.WriteEndArray();
                w.WriteStartArray("bulges");
                foreach (var v in p.Vertices) Json.Value(w, v.Bulge);
                w.WriteEndArray();
                w.WriteBoolean("closed", p.IsClosed);
                if (p.Elevation != 0) Json.Num(w, "elev", p.Elevation);
                Normal(w, p.Normal);
                break;
            case Polyline3D p:
                w.WriteStartArray("pts");
                foreach (var v in p.Vertices) Json.PointValue(w, v.Location);
                w.WriteEndArray();
                w.WriteBoolean("closed", p.IsClosed);
                w.WriteBoolean("d3", true);
                break;
            case Spline s:
                w.WriteNumber("degree", s.Degree);
                w.WriteBoolean("closed", s.IsClosed);
                w.WriteBoolean("periodic", s.IsPeriodic);
                w.WriteStartArray("ctrl");
                foreach (var c in s.ControlPoints) Json.PointValue(w, c);
                w.WriteEndArray();
                w.WriteStartArray("knots");
                foreach (var k in s.Knots) Json.Value(w, k);
                w.WriteEndArray();
                w.WriteStartArray("weights");
                foreach (var k in s.Weights) Json.Value(w, k);
                w.WriteEndArray();
                w.WriteStartArray("fit");
                foreach (var c in s.FitPoints) Json.PointValue(w, c);
                w.WriteEndArray();
                Normal(w, s.Normal);
                break;
            case Point pt:
                Json.Point(w, "at", pt.Location);
                break;
            case AttributeDefinition ad:
                w.WriteString("tag", ad.Tag ?? "");
                w.WriteString("prompt", ad.Prompt ?? "");
                Text(w, ad);
                break;
            case TextEntity t:
                Text(w, t);
                break;
            case MText m:
                w.WriteString("raw", m.Value ?? "");
                Json.Point(w, "at", m.InsertPoint);
                Json.Num(w, "height", m.Height);
                Json.Num(w, "rot", Json.Safe(m.Rotation));
                w.WriteString("style", m.Style?.Name ?? "");
                Json.Num(w, "width", Json.Safe(m.RectangleWidth));
                w.WriteNumber("attach", (int)m.AttachmentPoint);
                Normal(w, m.Normal);
                break;
            case TableEntity table:
                w.WriteString("block", table.Block?.Name ?? "");
                Json.Point(w, "at", table.InsertPoint);
                break;
            case Insert i:
                w.WriteString("block", i.Block?.Name ?? "");
                if (unitEvidenceOnly)
                {
                    if (double.IsFinite(i.XScale)) w.WriteNumber("sx", i.XScale);
                    if (double.IsFinite(i.YScale)) w.WriteNumber("sy", i.YScale);
                    if (double.IsFinite(i.ZScale)) w.WriteNumber("sz", i.ZScale);
                    break;
                }
                Json.Point(w, "at", i.InsertPoint);
                Json.Num(w, "sx", i.XScale);
                Json.Num(w, "sy", i.YScale);
                Json.Num(w, "sz", i.ZScale);
                Json.Num(w, "rot", i.Rotation);
                Normal(w, i.Normal);
                if (i.ColumnCount > 1 || i.RowCount > 1)
                {
                    w.WriteNumber("cols", i.ColumnCount);
                    w.WriteNumber("rows", i.RowCount);
                    Json.Num(w, "cs", i.ColumnSpacing);
                    Json.Num(w, "rs", i.RowSpacing);
                }
                w.WriteStartArray("attribs");
                foreach (var a in i.Attributes)
                {
                    w.WriteStartObject();
                    w.WriteString("h", a.Handle.ToString("X"));
                    w.WriteString("tag", a.Tag ?? "");
                    w.WriteString("layer", a.Layer?.Name ?? "");
                    Text(w, a);
                    w.WriteEndObject();
                }
                w.WriteEndArray();
                break;
            case Dimension d:
                w.WriteString("block", d.Block?.Name ?? "");
                w.WriteString("text", d.Text ?? "");
                Json.Point(w, "at", d.TextMiddlePoint, lenient: true);
                try
                {
                    var m = d.Measurement;
                    if (double.IsFinite(m)) w.WriteNumber("measurement", m);
                    if (d is DimensionAligned or DimensionRadius or DimensionDiameter or DimensionArc)
                    {
                        w.WriteString("measurement_kind", "length");
                        var style = d.GetActiveDimensionStyle();
                        if (style is not null)
                        {
                            if (double.IsFinite(style.LinearScaleFactor))
                                w.WriteNumber("dimension_factor", style.LinearScaleFactor);
                            w.WriteString("dimension_suffix", style.Suffix);
                        }
                    }
                    else if (d is DimensionAngular2Line or DimensionAngular3Pt)
                        w.WriteString("measurement_kind", "angle");
                }
                catch (Exception) { /* not every dimension kind can measure itself */ }
                break;
            case Hatch hatch:
                w.WriteString("pattern", hatch.Pattern?.Name ?? "");
                w.WriteBoolean("solid", hatch.IsSolid);
                if (hatch.Elevation != 0) Json.Num(w, "elev", hatch.Elevation);
                Normal(w, hatch.Normal);
                w.WriteStartArray("loops");
                foreach (var path in hatch.Paths)
                {
                    w.WriteStartArray();
                    try
                    {
                        foreach (var p in path.GetPoints(16))
                        {
                            w.WriteStartArray();
                            Json.Value(w, p.X);
                            Json.Value(w, p.Y);
                            w.WriteEndArray();
                        }
                    }
                    catch (EngineError) { throw; }
                    catch (Exception) { /* a boundary that cannot be flattened is left empty */ }
                    w.WriteEndArray();
                }
                w.WriteEndArray();
                break;
            case Solid s:
                Corners(w, s.FirstCorner, s.SecondCorner, s.ThirdCorner, s.FourthCorner);
                Normal(w, s.Normal);
                break;
            case Face3D f:
                Corners(w, f.FirstCorner, f.SecondCorner, f.ThirdCorner, f.FourthCorner);
                break;
            case Leader leader:
                w.WriteStartArray("pts");
                foreach (var v in leader.Vertices) Json.PointValue(w, v);
                w.WriteEndArray();
                break;
            case RasterImage image:
                Json.Point(w, "at", image.InsertPoint);
                Json.Point(w, "u", image.UVector);
                Json.Point(w, "v", image.VVector);
                w.WriteStartArray("size");
                Json.Value(w, image.Size.X);
                Json.Value(w, image.Size.Y);
                w.WriteEndArray();
                w.WriteBoolean("path_present", !string.IsNullOrEmpty(image.Definition?.FileName));
                break;
            case Viewport vp:
                if (unitEvidenceOnly)
                {
                    if (double.IsFinite(vp.Height)) w.WriteNumber("ht", vp.Height);
                    if (double.IsFinite(vp.ViewHeight)) w.WriteNumber("view_height", vp.ViewHeight);
                    w.WriteNumber("id", vp.Id);
                    break;
                }
                Json.Point(w, "c", vp.Center);
                Json.Num(w, "w", vp.Width);
                Json.Num(w, "ht", vp.Height);
                Json.Point2Named(w, "view", vp.ViewCenter);
                Json.Num(w, "view_height", vp.ViewHeight);
                w.WriteNumber("id", vp.Id);
                break;
        }
    }

    private static void Text(Utf8JsonWriter w, TextEntity t)
    {
        w.WriteString("raw", t.Value ?? "");
        Json.Point(w, "at", t.InsertPoint);
        if (t.HorizontalAlignment != TextHorizontalAlignment.Left || t.VerticalAlignment != TextVerticalAlignmentType.Baseline)
        {
            Json.Point(w, "align", t.AlignmentPoint);
            w.WriteNumber("halign", (int)t.HorizontalAlignment);
            w.WriteNumber("valign", (int)t.VerticalAlignment);
        }
        Json.Num(w, "height", t.Height);
        Json.Num(w, "rot", t.Rotation);
        w.WriteString("style", t.Style?.Name ?? "");
        if (t.WidthFactor != 1 && double.IsFinite(t.WidthFactor)) w.WriteNumber("wf", t.WidthFactor);
        if (t.Mirror.HasFlag(TextMirrorFlag.Backward)) w.WriteBoolean("backwards", true);
        if (t.Mirror.HasFlag(TextMirrorFlag.UpsideDown)) w.WriteBoolean("upside", true);
        Normal(w, t.Normal);
    }

    private static void Corners(Utf8JsonWriter w, XYZ a, XYZ b, XYZ c, XYZ d)
    {
        w.WriteStartArray("pts");
        Json.PointValue(w, a);
        Json.PointValue(w, b);
        Json.PointValue(w, c);
        Json.PointValue(w, d);
        w.WriteEndArray();
    }
}
