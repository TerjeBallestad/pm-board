using System.Data;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Microsoft.EntityFrameworkCore;
using PmBoard.Api.Boards;
using PmBoard.Api.Data;

namespace PmBoard.Api.Export;

/// <summary>
/// Writes boards as 0.x board folders, for the pm-data repo (DD-005, DD-022): pm.config.json, then
/// data/items and data/designs as markdown with frontmatter, data/plans, data/sprints and
/// data/milestones as JSON, data/archive, the *.tests.json sidecars, attachments/ and templates/.
/// 0.x's own store reads the result, and tools/compare-export.mjs checks that it reads the same
/// board the server serves.
///
/// The output is the same for the same data: no clock, keys in V0Json's order, files sorted. So an
/// export with no change in between makes no commit.
/// </summary>
public static partial class V0Exporter
{
    private static readonly JsonSerializerOptions Indented = new()
    {
        WriteIndented = true,
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };

    private static readonly JsonSerializerOptions OneLine = new() { Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping };

    /// <summary>Exports the boards (every board when <paramref name="slugs"/> is empty) into &lt;dir&gt;/&lt;slug&gt;.</summary>
    public static async Task<List<string>> ExportAsync(BoardDb db, string dir, IReadOnlyCollection<string> slugs, CancellationToken ct = default)
    {
        // One snapshot for every board: a write during the export is in all of it or none of it.
        await using var tx = await db.Database.BeginTransactionAsync(IsolationLevel.RepeatableRead, ct);
        var boards = await db.Boards.AsNoTracking()
            .Where(b => slugs.Count == 0 || slugs.Contains(b.Slug))
            .OrderBy(b => b.Slug)
            .ToListAsync(ct);
        var missing = slugs.Except(boards.Select(b => b.Slug)).ToList();
        if (missing.Count > 0) throw new ExportException($"no board {string.Join(", ", missing)}");
        foreach (var b in boards)
        {
            if (Directory.Exists(Path.Combine(dir, b.Slug)) || File.Exists(Path.Combine(dir, b.Slug)))
            {
                throw new ExportException($"{Path.Combine(dir, b.Slug)} exists; export into an empty folder");
            }
        }
        foreach (var b in boards)
        {
            await ExportBoard(db, b, Path.Combine(dir, b.Slug), ct);
        }
        return boards.Select(b => b.Slug).ToList();
    }

    private static async Task ExportBoard(BoardDb db, Board board, string root, CancellationToken ct)
    {
        var records = await db.Records.AsNoTracking().Where(r => r.BoardId == board.Id).ToListAsync(ct);
        var comments = (await db.Comments.AsNoTracking().Where(c => db.Records.Any(r => r.Id == c.RecordId && r.BoardId == board.Id)).ToListAsync(ct))
            .OrderBy(c => c.Position)
            .ThenBy(c => c.Seq)
            .ToLookup(c => c.RecordId);
        var tasks = records.Where(r => r.Kind == RecordKind.Task).OrderBy(r => r.Position).ToLookup(r => r.ParentId);

        JsonObject Shape(Record r) => V0Json.Record(
            r,
            comments[r.Id].ToList(),
            r.Kind == RecordKind.Plan ? tasks[r.Id].Select(t => (t, (IReadOnlyList<Comment>)comments[t.Id].ToList())).ToList() : null
        );

        var data = Path.Combine(root, "data");
        foreach (var sub in new[] { "items", "designs", "plans", "sprints", "milestones", "archive" })
        {
            Directory.CreateDirectory(Path.Combine(data, sub));
        }

        foreach (var r in records.Where(r => r.Kind != RecordKind.Task).OrderBy(r => r.Key, StringComparer.Ordinal))
        {
            var o = Shape(r);
            // 0.x keeps `tests` in a sidecar file next to the record and merges it when it reads (DD-019).
            if (o["tests"] is JsonNode tests)
            {
                o.Remove("tests");
                if (r.ArchivedAt is null && r.Kind is RecordKind.Item or RecordKind.Design)
                {
                    var sidecar = new JsonObject { ["schema"] = 1, ["id"] = r.Key, ["tests"] = tests.DeepClone() };
                    await Write(Path.Combine(data, r.Kind == RecordKind.Item ? "items" : "designs", $"{r.Key}.tests.json"), sidecar.ToJsonString(Indented) + "\n", ct);
                }
            }
            var (folder, markdown) = (r.ArchivedAt, r.Kind) switch
            {
                (not null, _) => ("archive", true),
                (null, RecordKind.Item) => ("items", true),
                (null, RecordKind.Design) => ("designs", true),
                (null, RecordKind.Plan) => ("plans", false),
                (null, RecordKind.Sprint) => ("sprints", false),
                _ => ("milestones", false),
            };
            var path = Path.Combine(data, folder, r.Key + (markdown ? ".md" : ".json"));
            await Write(path, markdown ? Markdown(o) : o.ToJsonString(Indented), ct);
        }

        // pm.config.json: the board's config as 0.x read it, with the data folder next to it. A
        // board's own templates (templateFiles, DD-017) go back to a templates folder.
        var config = JsonNode.Parse(board.Config.RootElement.GetRawText())!.AsObject();
        var templateFiles = config["templateFiles"] as JsonObject;
        config.Remove("templateFiles");
        var file = new JsonObject { ["name"] = board.Name, ["dataDir"] = "data" };
        foreach (var (k, v) in config)
        {
            if (k is "name" or "dataDir" or "port") continue;
            file[k] = v?.DeepClone();
        }
        file["templates"] = templateFiles is { Count: > 0 } ? "templates" : null;
        await Write(Path.Combine(root, "pm.config.json"), file.ToJsonString(Indented) + "\n", ct);
        foreach (var (name, text) in templateFiles ?? [])
        {
            if (text?.GetValueKind() != JsonValueKind.String || !SafeName().IsMatch(name)) continue;
            Directory.CreateDirectory(Path.Combine(root, "templates"));
            await Write(Path.Combine(root, "templates", name + ".md"), (string)text!, ct);
        }

        // Images, where 0.x kept them: <dataDir>/../attachments (DD-018).
        var attachments = await db.Attachments.AsNoTracking().Where(a => a.BoardId == board.Id).OrderBy(a => a.Name).ToListAsync(ct);
        foreach (var a in attachments.Where(a => SafeName().IsMatch(a.Name)))
        {
            Directory.CreateDirectory(Path.Combine(root, "attachments"));
            await File.WriteAllBytesAsync(Path.Combine(root, "attachments", a.Name), a.Data, ct);
        }
    }

    /// <summary>A file name with no folder in it, so a name from the database never writes outside the board.</summary>
    [GeneratedRegex(@"^[A-Za-z0-9][A-Za-z0-9._-]*$")]
    private static partial Regex SafeName();

    private static Task Write(string path, string text, CancellationToken ct) =>
        File.WriteAllTextAsync(path, text, new UTF8Encoding(false), ct);

    /// <summary>0.x's entityToMd: the fields as YAML frontmatter, then the body as it is.</summary>
    public static string Markdown(JsonObject o)
    {
        var meta = o.DeepClone().AsObject();
        var body = meta["body"]?.GetValueKind() == JsonValueKind.String ? (string)meta["body"]! : "";
        meta.Remove("body");
        var sb = new StringBuilder("---\n");
        Mapping(sb, meta, 0);
        sb.Append("---\n").Append(body);
        return sb.ToString();
    }

    // --- YAML: block style; every string a JSON-quoted scalar, which YAML 1.2 reads the same ---

    private static void Mapping(StringBuilder sb, JsonObject o, int indent, bool firstInline = false)
    {
        var first = true;
        foreach (var (key, value) in o)
        {
            if (!(first && firstInline)) sb.Append(' ', indent);
            first = false;
            sb.Append(Key(key)).Append(':');
            Value(sb, value, indent);
        }
    }

    private static void Value(StringBuilder sb, JsonNode? value, int indent)
    {
        switch (value)
        {
            case JsonObject { Count: > 0 } m:
                sb.Append('\n');
                Mapping(sb, m, indent + 2);
                break;
            case JsonArray { Count: > 0 } a:
                sb.Append('\n');
                Sequence(sb, a, indent);
                break;
            default:
                sb.Append(' ').Append(Scalar(value)).Append('\n');
                break;
        }
    }

    private static void Sequence(StringBuilder sb, JsonArray a, int indent)
    {
        foreach (var item in a)
        {
            sb.Append(' ', indent).Append('-');
            switch (item)
            {
                case JsonObject { Count: > 0 } m:
                    sb.Append(' ');
                    Mapping(sb, m, indent + 2, firstInline: true);
                    break;
                case JsonArray { Count: > 0 } inner:
                    sb.Append('\n');
                    Sequence(sb, inner, indent + 2);
                    break;
                default:
                    sb.Append(' ').Append(Scalar(item)).Append('\n');
                    break;
            }
        }
    }

    [GeneratedRegex(@"^[A-Za-z_][A-Za-z0-9_-]*$")]
    private static partial Regex PlainKey();

    private static readonly HashSet<string> YamlWords = new(StringComparer.OrdinalIgnoreCase)
    {
        "true", "false", "null", "yes", "no", "on", "off", "y", "n",
    };

    private static string Key(string key) =>
        PlainKey().IsMatch(key) && !YamlWords.Contains(key) ? key : JsonSerializer.Serialize(key, OneLine);

    private static string Scalar(JsonNode? v) =>
        v switch
        {
            null => "null",
            JsonObject => "{}",
            JsonArray => "[]",
            JsonValue x when x.GetValueKind() == JsonValueKind.String => JsonSerializer.Serialize((string)x!, OneLine),
            JsonValue x when x.GetValueKind() == JsonValueKind.Number => x.ToJsonString(),
            JsonValue x when x.GetValueKind() == JsonValueKind.True => "true",
            JsonValue x when x.GetValueKind() == JsonValueKind.False => "false",
            _ => "null",
        };
}

public class ExportException(string message) : Exception(message);
