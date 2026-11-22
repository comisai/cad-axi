using System.Reflection;
using System.Runtime.InteropServices;
using ACadSharp;

namespace CadAxi.Engine;

// The cad-axi engine. It is started once per command by the front end, with
// arguments only, and prints newline-delimited JSON records on stdout. It
// never reads stdin, never uses the network and writes only the path it is
// given with --out. Exit code 0 means success, 1 an error record, 2 usage.
internal static class Program
{
    private static int Main(string[] args)
    {
        using var rec = new Records(Console.OpenStandardOutput());
        try
        {
            if (args.Length == 0) throw new EngineError("usage");
            var o = Options.Parse(args, 1);
            StartWatchdog(rec, o.TimeLimitMs);
            return args[0] switch
            {
                "probe" => Probe(rec),
                "read" => Reader.Run(rec, o),
                "write" => Writer.Run(rec, o),
                _ => throw new EngineError("usage"),
            };
        }
        catch (EngineError e)
        {
            rec.Close("error", w =>
            {
                w.WriteString("code", e.Code);
                if (e.Detail is not null) w.WriteString("exception", e.Detail);
            });
            return e.Code == "usage" ? 2 : 1;
        }
        catch (OutOfMemoryException)
        {
            rec.Close("error", w => w.WriteString("code", "too_large"));
            return 1;
        }
        catch (Exception)
        {
            rec.Close("error", w => w.WriteString("code", "internal_error"));
            return 1;
        }
    }

    private static int Probe(Records rec)
    {
        var acad = typeof(CadDocument).Assembly
            .GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion ?? "unknown";
        var engine = typeof(Program).Assembly
            .GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion ?? "unknown";
        rec.Close("probe", w =>
        {
            w.WriteString("engine", engine.Split('+')[0]);
            w.WriteString("acadsharp", acad.Split('+')[0]);
            w.WriteNumber("protocol", Records.Protocol);
            w.WriteString("platform", RuntimeInformation.RuntimeIdentifier);
            w.WriteNumber("heap_limit", GC.GetGCMemoryInfo().TotalAvailableMemoryBytes);
        });
        return 0;
    }

    // A file must never run forever: after the limit the engine prints one
    // error record and exits, whatever it was doing.
    private static void StartWatchdog(Records rec, int limitMs)
    {
        var timer = new Thread(() =>
        {
            Thread.Sleep(limitMs);
            rec.Close("error", w => w.WriteString("code", "timed_out"));
            Environment.Exit(1);
        })
        { IsBackground = true };
        timer.Start();
    }
}
