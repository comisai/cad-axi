using System.Text.Json;

namespace CadAxi.Engine;

// One JSON object per line on stdout. Every record carries the protocol
// version and its type. Text is written with JSON escapes, so anything
// outside ASCII, control characters included, leaves as \uXXXX.
internal sealed class Records : IDisposable
{
    public const int Protocol = 1;

    private readonly Stream output;
    private readonly Utf8JsonWriter writer;
    private readonly object gate = new();
    private bool closed;

    public Records(Stream output)
    {
        this.output = output;
        writer = new Utf8JsonWriter(output);
    }

    // Writes one record. The writer is reset after each line so several
    // top-level objects can share it. Nothing is written once closed, so a
    // watchdog's last record is the last line.
    public void Write(string type, Action<Utf8JsonWriter> body)
    {
        lock (gate)
        {
            if (closed) return;
            writer.WriteStartObject();
            writer.WriteNumber("p", Protocol);
            writer.WriteString("type", type);
            body(writer);
            writer.WriteEndObject();
            writer.Flush();
            writer.Reset(output);
            output.WriteByte((byte)'\n');
            output.Flush();
        }
    }

    public void Error(string code)
    {
        Write("error", w => w.WriteString("code", code));
    }

    // The last record: nothing after it is written.
    public void Close(string type, Action<Utf8JsonWriter> body)
    {
        lock (gate)
        {
            Write(type, body);
            closed = true;
        }
    }

    public void Dispose()
    {
        lock (gate)
        {
            closed = true;
            writer.Dispose();
        }
    }
}

// An expected failure with a closed code. The message never leaves the
// engine; only the code does.
// Detail is an exception's type name at most: it never carries file text.
internal sealed class EngineError(string code, string? detail = null) : Exception(code)
{
    public string Code { get; } = code;
    public string? Detail { get; } = detail;
}
