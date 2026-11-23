namespace CadAxi.Engine;

// Arguments only; the engine never reads stdin. The front end builds these.
internal sealed class Options
{
    public string? File { get; private set; }
    public string? Spec { get; private set; }
    public string? Out { get; private set; }
    public string? Ops { get; private set; }
    public string? As { get; private set; }
    public long MaxBytes { get; private set; } = 64L * 1024 * 1024;
    public int TimeLimitMs { get; private set; } = 120_000;
    public bool Entities { get; private set; }
    public bool UnitEvidence { get; private set; }

    public static Options Parse(string[] args, int start)
    {
        var o = new Options();
        for (var i = start; i < args.Length; i++)
        {
            var a = args[i];
            switch (a)
            {
                case "--spec": o.Spec = Value(args, ref i); break;
                case "--out": o.Out = Value(args, ref i); break;
                case "--ops": o.Ops = Value(args, ref i); break;
                case "--as": o.As = Value(args, ref i); break;
                case "--max-bytes": o.MaxBytes = Number(args, ref i, 1, 256L * 1024 * 1024); break;
                case "--time-limit-ms": o.TimeLimitMs = (int)Number(args, ref i, 1, 3_600_000); break;
                case "--entities": o.Entities = true; break;
                case "--unit-evidence": o.UnitEvidence = true; break;
                default:
                    if (a.StartsWith("--", StringComparison.Ordinal) || o.File is not null)
                        throw new EngineError("usage");
                    o.File = a;
                    break;
            }
        }
        return o;
    }

    private static string Value(string[] args, ref int i)
    {
        if (i + 1 >= args.Length) throw new EngineError("usage");
        return args[++i];
    }

    private static long Number(string[] args, ref int i, long min, long max)
    {
        if (!long.TryParse(Value(args, ref i), out var n) || n < min || n > max)
            throw new EngineError("usage");
        return n;
    }
}
