using System.Text.Json;
using CSMath;

namespace CadAxi.Engine;

// Small helpers for writing records. A non-finite number in geometry is a
// damaged file: it is never printed (protocol rules).
internal static class Json
{
    public static double Safe(double v) => double.IsFinite(v) ? v : 0;

    public static void Num(Utf8JsonWriter w, string name, double v)
    {
        if (!double.IsFinite(v)) throw new EngineError("damaged", "NonFinite");
        w.WriteNumber(name, v);
    }

    public static void Value(Utf8JsonWriter w, double v)
    {
        if (!double.IsFinite(v)) throw new EngineError("damaged", "NonFinite");
        w.WriteNumberValue(v);
    }

    public static void Point(Utf8JsonWriter w, string name, XYZ p, bool lenient = false)
    {
        if (lenient && !(double.IsFinite(p.X) && double.IsFinite(p.Y) && double.IsFinite(p.Z))) return;
        w.WriteStartArray(name);
        Value(w, p.X);
        Value(w, p.Y);
        Value(w, p.Z);
        w.WriteEndArray();
    }

    public static void PointValue(Utf8JsonWriter w, XYZ p)
    {
        w.WriteStartArray();
        Value(w, p.X);
        Value(w, p.Y);
        Value(w, p.Z);
        w.WriteEndArray();
    }

    public static void Point2Named(Utf8JsonWriter w, string name, XY p)
    {
        w.WritePropertyName(name);
        Point2(w, p);
    }

    public static void Point2(Utf8JsonWriter w, XY p)
    {
        w.WriteStartArray();
        Value(w, p.X);
        Value(w, p.Y);
        w.WriteEndArray();
    }

    // Colour as AutoCAD numbers it: 256 by layer, 0 by block, 1 to 255 an
    // index; a true colour also gives its RGB.
    public static void Color(Utf8JsonWriter w, ACadSharp.Color c)
    {
        if (c.IsByLayer) w.WriteNumber("color", 256);
        else if (c.IsByBlock) w.WriteNumber("color", 0);
        else if (c.IsTrueColor)
        {
            w.WriteNumber("color", c.GetApproxIndex());
            w.WriteString("rgb", $"#{c.R:x2}{c.G:x2}{c.B:x2}");
        }
        else w.WriteNumber("color", c.Index);
    }
}
