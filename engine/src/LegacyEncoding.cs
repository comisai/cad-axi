using System.Text;
using ACadSharp;
using ACadSharp.Header;
using ACadSharp.IO;

namespace CadAxi.Engine;

// ACadSharp uses Encoding.GetEncoding(0) for an unmapped declaration.
// .NET normally returns UTF-8 for 0, which can lose legacy bytes before
// the text view has a chance to identify their encoding.
internal static class LegacyEncoding
{
    [ThreadStatic] private static Encoding? _fallback;
    private static readonly Encoding DefaultLegacy;

    static LegacyEncoding()
    {
        Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);
        // Keep a distinct instance so DXF reads can tell a fallback from a
        // drawing that explicitly selected Windows-1252.
        DefaultLegacy = (Encoding)Encoding.GetEncoding(1252).Clone();
        Encoding.RegisterProvider(new FallbackProvider());
    }

    private sealed class FallbackProvider : EncodingProvider
    {
        public override Encoding? GetEncoding(int codepage) => codepage == 0 ? _fallback : null;
        public override Encoding? GetEncoding(string name) => null;
    }

    public static CadDocument ReadDwg(string file, NotificationEventHandler note)
    {
        _fallback = DefaultLegacy;
        try
        {
            return DwgReader.Read(file, new DwgReaderConfiguration
            {
                KeepUnknownEntities = true,
                KeepUnknownNonGraphicalObjects = true,
            }, note);
        }
        finally { _fallback = null; }
    }

    public static CadDocument ReadDxf(string file, NotificationEventHandler note, out bool assumed)
    {
        try { return ReadDxf(file, note, DefaultLegacy, out assumed); }
        catch (UseCodePage retry) { return ReadDxf(file, note, retry.Encoding, out assumed); }
    }

    private static CadDocument ReadDxf(
        string file, NotificationEventHandler note, Encoding fallback, out bool assumed)
    {
        _fallback = fallback;
        try
        {
            using var reader = new DxfWithFallback(file, note, fallback);
            var doc = reader.Read();
            assumed = reader.UsedDefault;
            return doc;
        }
        finally { _fallback = null; }
    }

    private sealed class DxfWithFallback : DxfReader
    {
        public bool UsedDefault => ReferenceEquals(_encoding, DefaultLegacy);

        public DxfWithFallback(string file, NotificationEventHandler note, Encoding fallback)
            : base(file, note)
        {
            _encoding = fallback;
            Configuration = new DxfReaderConfiguration
            {
                KeepUnknownEntities = true,
                KeepUnknownNonGraphicalObjects = true,
            };
        }

        public override CadHeader ReadHeader()
        {
            var header = base.ReadHeader();
            // Known declarations and 2007+ UTF-8 are handled by ACadSharp.
            // For a declaration missing from its map, restart before reading
            // tables or entities, with the actual encoding as the fallback.
            if (UsedDefault && !string.Equals(header.CodePage, "ANSI_1252", StringComparison.OrdinalIgnoreCase)
                && DeclaredEncoding(header.CodePage) is { } encoding)
                throw new UseCodePage(encoding);
            return header;
        }
    }

    private sealed class UseCodePage(Encoding encoding) : Exception
    {
        public Encoding Encoding { get; } = encoding;
    }

    private static Encoding? DeclaredEncoding(string? name)
    {
        if (string.IsNullOrWhiteSpace(name)) return null;
        var label = name.Trim().ToUpperInvariant();
        foreach (var prefix in new[] { "ANSI_", "ANSI", "DOS", "CP", "IBM" })
        {
            if (!label.StartsWith(prefix, StringComparison.Ordinal)) continue;
            if (int.TryParse(label.AsSpan(prefix.Length).TrimStart('_'), out var number) && number > 0)
                return CodePagesEncodingProvider.Instance.GetEncoding(number);
        }
        return CodePagesEncodingProvider.Instance.GetEncoding(label);
    }
}
