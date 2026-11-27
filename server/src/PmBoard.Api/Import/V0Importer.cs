using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using PmBoard.Api.Data;
using PmBoard.Api.Keys;

namespace PmBoard.Api.Import;

/// <summary>
/// Loads one board from a tools/export-v0.mjs dump into Postgres, in one transaction (DD-013).
/// The mapping is the table in server/docs/data-model.md.
/// </summary>
public class V0Importer(BoardDb db)
{
    /// <summary>0.x fields that become columns. Everything else goes into Record.Fields verbatim.</summary>
    private static readonly HashSet<string> ColumnFields =
    [
        "id", "type", "title", "stage", "status", "priority", "body", "sprintId", "blockedBy",
        "assignee", "assignedAt", "createdAt", "updatedAt", "doneAt", "archivedAt",
        "comments", "progressNotes", "tasks",
    ];

    private readonly List<Record> _records = [];
    private readonly List<Comment> _comments = [];
    private readonly Dictionary<string, Record> _byKey = new(StringComparer.Ordinal);

    /// <summary>Records whose key clashed with a different record. They get a new key after the counters are known.</summary>
    private readonly List<(Record Record, Clash Clash)> _renumber = [];
    private readonly ImportReport _report = new();

    public async Task<ImportReport> ImportAsync(JsonNode dump, CancellationToken ct = default)
    {
        if ((string?)dump["format"] != "pm-v0-export")
        {
            throw new ImportException("not a tools/export-v0.mjs dump (format is not pm-v0-export)");
        }

        var p = dump["board"] ?? throw new ImportException("the dump has no board");
        var slug = (string?)p["slug"] ?? throw new ImportException("the dump's board has no slug");

        var board = new Board
        {
            Id = Guid.CreateVersion7(),
            Slug = slug,
            Name = (string?)p["name"] ?? slug,
            Config = JsonDocument.Parse(p["config"]?.ToJsonString() ?? "{}"),
        };
        _report.Board = slug;

        // Live records first, so on a clash the live copy wins and the archived copy is reported.
        foreach (var e in Array(dump, "items")) Add(board, RecordKind.Item, e, archivedAt: null);
        foreach (var e in Array(dump, "designs")) Add(board, RecordKind.Design, e, archivedAt: null);
        foreach (var e in Array(dump, "sprints")) Add(board, RecordKind.Sprint, e, archivedAt: null);
        foreach (var e in Array(dump, "milestones")) Add(board, RecordKind.Milestone, e, archivedAt: null);
        foreach (var e in Array(dump, "plans"))
        {
            var plan = Add(board, RecordKind.Plan, e, archivedAt: null);
            var position = 0;
            foreach (var t in e["tasks"]?.AsArray().OfType<JsonObject>() ?? [])
            {
                var task = Add(board, RecordKind.Task, t, archivedAt: null, parent: plan);
                if (task is not null)
                {
                    task.Position = position;
                    // A 0.x task has no timestamps of its own. Leave them null, as in 0.x.
                }
                position++;
            }
        }

        var archive = dump["archive"];
        var archivedAtMap = archive?["archivedAt"]?.AsObject();
        foreach (var e in Array(archive, "items"))
        {
            var key = (string?)e["id"];
            var at = Time(key is null ? null : archivedAtMap?[key]) ?? Time(e["archivedAt"]);
            Add(board, RecordKind.Item, e, archivedAt: at ?? DateTimeOffset.UnixEpoch);
        }
        foreach (var e in Array(archive, "designs"))
        {
            Add(board, RecordKind.Design, e, archivedAt: Time(e["archivedAt"]) ?? DateTimeOffset.UnixEpoch);
        }

        // `tests` from the *.tests.json sidecar files: 0.x merges them into the record when it reads it.
        foreach (var (id, tests) in dump["sidecarTests"]?.AsObject() ?? [])
        {
            if (_byKey.TryGetValue(id, out var r) && tests is not null)
            {
                var fields = JsonNode.Parse(r.Fields.RootElement.GetRawText())!.AsObject();
                fields["tests"] = tests.DeepClone();
                r.Fields = JsonDocument.Parse(fields.ToJsonString());
                _report.SidecarTests++;
            }
        }

        // Skipped files keep their number reserved, the same as in 0.x.
        var reserved = new List<string>();
        foreach (var q in dump["quarantined"]?.AsArray() ?? [])
        {
            var id = (string?)q?["id"];
            if (id is not null) reserved.Add(id);
            _report.Skipped.Add(q?.ToJsonString() ?? "null");
        }
        foreach (var f in dump["notRead"]?.AsArray() ?? [])
        {
            _report.NotRead.Add((string?)f ?? "");
        }

        var attachments = new List<Attachment>();
        foreach (var a in Array(dump, "attachments"))
        {
            var name = (string?)a["name"];
            var data = (string?)a["data"];
            if (name is null || data is null) continue;
            attachments.Add(new Attachment
            {
                Id = Guid.CreateVersion7(),
                BoardId = board.Id,
                Name = name,
                ContentType = Boards.FileRoutes.ImageType(name) ?? "application/octet-stream",
                Data = Convert.FromBase64String(data),
            });
        }

        var counters = Counters(board.Id, _records.Select(r => r.Key).Concat(reserved));
        Renumber(counters);
        FindDanglingReferences();

        await using var tx = await db.Database.BeginTransactionAsync(ct);
        // The slug is checked under the lock that create and rename hold (DD-035).
        await Boards.BoardAliases.LockSlugs(db, ct);
        switch (await Boards.BoardAliases.Holder(db, slug, null, ct))
        {
            case { IsAlias: false }:
                throw new ImportException($"board {slug} already exists; nothing was imported");
            case { Board: var owner }:
                // An alias is never a second board.
                throw new ImportException($"{slug} is an old slug of board {owner}; nothing was imported");
        }
        db.Add(board);
        db.AddRange(_records);
        db.AddRange(_comments);
        db.AddRange(counters);
        db.AddRange(attachments);
        await db.SaveChangesAsync(ct);
        await tx.CommitAsync(ct);

        _report.Records = _records.GroupBy(r => r.Kind).ToDictionary(g => g.Key, g => g.Count());
        _report.Archived = _records.Count(r => r.ArchivedAt is not null);
        _report.Comments = _comments.Count(c => c.Kind == CommentKind.Comment);
        _report.ProgressNotes = _comments.Count(c => c.Kind == CommentKind.Progress);
        _report.Attachments = attachments.Count;
        _report.Counters = counters.OrderBy(c => c.Prefix).ToDictionary(c => c.Prefix, c => c.NextNumber);
        return _report;
    }

    private Record? Add(Board board, string kind, JsonObject e, DateTimeOffset? archivedAt, Record? parent = null)
    {
        var key = (string?)e["id"];
        if (string.IsNullOrWhiteSpace(key))
        {
            _report.Skipped.Add($"a {kind} with no id: {Shorten(e.ToJsonString())}");
            return null;
        }
        Clash? clash = null;
        if (_byKey.TryGetValue(key, out var first))
        {
            // The same record twice (for example archived, then put back on the board): keep the first,
            // which is the live copy. Two different records with one key: keep both, and give the second
            // a new key (see Renumber).
            var same = first.Kind == kind && first.Title == (Text(e[kind == RecordKind.Sprint ? "name" : "title"]) ?? "")
                && first.Body == Text(e["body"]);
            clash = new Clash(key, Where(first), Where(kind, archivedAt), e.ToJsonString())
            {
                Action = same ? "dropped: the same record as the one kept" : "renumbered",
            };
            _report.Clashes.Add(clash);
            if (same)
            {
                return null;
            }
            if (KeyAllocator.Parse(key).Prefix is null)
            {
                throw new ImportException($"{key} is two different records, and a key with no number cannot be renumbered");
            }
        }

        var (prefix, number) = KeyAllocator.Parse(key);
        var fields = new JsonObject();
        foreach (var (name, value) in e)
        {
            if (!ColumnFields.Contains(name) && !(kind == RecordKind.Sprint && name == "name"))
            {
                fields[name] = value?.DeepClone();
            }
        }

        // A few old tasks have numbers in blockedBy (ordinal references). The column holds keys as text,
        // so keep the original array in fields too; the API returns fields over columns.
        if (e["blockedBy"] is JsonArray blockers && blockers.Any(b => b?.GetValueKind() != JsonValueKind.String))
        {
            fields["blockedBy"] = blockers.DeepClone();
        }

        var r = new Record
        {
            Id = Guid.CreateVersion7(),
            BoardId = board.Id,
            Key = key,
            Prefix = prefix,
            Number = number,
            Kind = kind,
            Type = (string?)e["type"],
            ParentId = parent?.Id,
            Title = Text(e[kind == RecordKind.Sprint ? "name" : "title"]) ?? "",
            Stage = Text(e["stage"]),
            Status = Text(e["status"]),
            Priority = Text(e["priority"]),
            Body = Text(e["body"]),
            SprintKey = Text(e["sprintId"]),
            BlockedBy = e["blockedBy"]?.AsArray().Select(x => x?.ToString() ?? "").Where(x => x != "").ToList() ?? [],
            Assignee = Text(e["assignee"]),
            AssignedAt = Time(e["assignedAt"], key, "assignedAt", fields),
            CreatedAt = Time(e["createdAt"], key, "createdAt", fields),
            UpdatedAt = Time(e["updatedAt"], key, "updatedAt", fields),
            DoneAt = Time(e["doneAt"], key, "doneAt", fields),
            ArchivedAt = archivedAt,
            Fields = JsonDocument.Parse(fields.ToJsonString()),
        };
        if (kind == RecordKind.Task && parent is null)
        {
            _report.Skipped.Add($"task {key}: its plan was not imported (see clashes)");
            return null;
        }
        if (archivedAt == DateTimeOffset.UnixEpoch)
        {
            _report.UnreadableTimes.Add($"{key}.archivedAt is missing; set to 1970-01-01");
        }
        _records.Add(r);
        if (clash is null)
        {
            _byKey[key] = r;
        }
        else
        {
            _renumber.Add((r, clash));
        }

        var position = 0;
        foreach (var c in e["comments"]?.AsArray().OfType<JsonObject>() ?? [])
        {
            _comments.Add(new Comment
            {
                Id = Guid.CreateVersion7(),
                RecordId = r.Id,
                Position = position++,
                Kind = CommentKind.Comment,
                LegacyId = Text(c["id"]),
                Author = Text(c["author"]),
                Text = Text(c["text"]) ?? "",
                CreatedAt = Time(c["createdAt"]),
            });
        }
        position = 0;
        foreach (var n in e["progressNotes"]?.AsArray().OfType<JsonObject>() ?? [])
        {
            _comments.Add(new Comment
            {
                Id = Guid.CreateVersion7(),
                RecordId = r.Id,
                Position = position++,
                Kind = CommentKind.Progress,
                Text = Text(n["text"]) ?? "",
                CreatedAt = Time(n["timestamp"]),
            });
        }
        return r;
    }

    /// <summary>
    /// The second of two different records with one key gets the next free number. Its 0.x key stays
    /// in fields as v0Key, so a reference to it can be found.
    /// </summary>
    private void Renumber(List<IdCounter> counters)
    {
        foreach (var (r, clash) in _renumber)
        {
            var counter = counters.Single(c => c.Prefix == r.Prefix);
            var fields = JsonNode.Parse(r.Fields.RootElement.GetRawText())!.AsObject();
            fields["v0Key"] = r.Key;
            r.Fields = JsonDocument.Parse(fields.ToJsonString());
            r.Number = counter.NextNumber++;
            r.Key = KeyAllocator.Format(r.Prefix!, r.Number.Value);
            clash.Action = $"renumbered to {r.Key}";
            _byKey[r.Key] = r;
        }

        // 0.x resolves a task's blockedBy among the tasks of its own plan, so in the plan of a
        // renumbered task its old key means that task: follow it to the new key there.
        var moved = _renumber
            .Where(x => x.Record.Kind == RecordKind.Task)
            .GroupBy(x => x.Record.ParentId!.Value)
            .ToDictionary(g => g.Key, g => g.ToDictionary(x => x.Record.Fields.RootElement.GetProperty("v0Key").GetString()!, x => x));
        foreach (var task in _records.Where(t => t.ParentId is { } p && moved.ContainsKey(p)))
        {
            var map = moved[task.ParentId!.Value];
            if (!task.BlockedBy.Any(map.ContainsKey)) continue;
            task.BlockedBy = task.BlockedBy.Select(b => map.TryGetValue(b, out var to) ? to.Record.Key : b).ToList();
            var fields = JsonNode.Parse(task.Fields.RootElement.GetRawText())!.AsObject();
            if (fields["blockedBy"] is JsonArray raw)
            {
                fields["blockedBy"] = new JsonArray(
                    raw.Select(b => b?.GetValueKind() == JsonValueKind.String && map.TryGetValue((string)b!, out var to) ? (JsonNode)to.Record.Key : b?.DeepClone()).ToArray()
                );
                task.Fields = JsonDocument.Parse(fields.ToJsonString());
            }
            foreach (var (_, (r, clash)) in map.Where(kv => task.BlockedBy.Contains(kv.Value.Record.Key)))
            {
                clash.Action = $"renumbered to {r.Key}; the blockedBy of its plan's tasks follows it";
            }
        }
    }

    /// <summary>One more than the highest number of each prefix, counting clashes and skipped files.</summary>
    private static List<IdCounter> Counters(Guid boardId, IEnumerable<string> keys)
    {
        var max = new Dictionary<string, int>(StringComparer.Ordinal);
        foreach (var key in keys)
        {
            var (prefix, number) = KeyAllocator.Parse(key);
            if (prefix is null || number is null) continue;
            max[prefix] = Math.Max(max.GetValueOrDefault(prefix), number.Value);
        }
        return max.Select(kv => new IdCounter { BoardId = boardId, Prefix = kv.Key, NextNumber = kv.Value + 1 }).ToList();
    }

    private void FindDanglingReferences()
    {
        void Check(Record from, string field, string? to)
        {
            if (!string.IsNullOrWhiteSpace(to) && !_byKey.ContainsKey(to))
            {
                _report.Dangling.Add(new Dangling(from.Key, field, to));
            }
        }

        foreach (var r in _records)
        {
            Check(r, "sprintId", r.SprintKey);
            foreach (var b in r.BlockedBy) Check(r, "blockedBy", b);
            var f = r.Fields.RootElement;
            foreach (var name in new[] { "related", "itemIds" })
            {
                if (f.TryGetProperty(name, out var arr) && arr.ValueKind == JsonValueKind.Array)
                {
                    foreach (var x in arr.EnumerateArray())
                    {
                        if (x.ValueKind == JsonValueKind.String) Check(r, name, x.GetString());
                    }
                }
            }
            if (f.TryGetProperty("sddId", out var sdd) && sdd.ValueKind == JsonValueKind.String)
            {
                Check(r, "sddId", sdd.GetString());
            }
        }
    }

    private static IEnumerable<JsonObject> Array(JsonNode? parent, string name) =>
        parent?[name]?.AsArray().OfType<JsonObject>() ?? [];

    private static string? Text(JsonNode? n) =>
        n is null ? null
        : n.GetValueKind() == JsonValueKind.String ? (string?)n
        : n.ToJsonString();

    private static DateTimeOffset? Time(JsonNode? n) =>
        n is not null
        && n.GetValueKind() == JsonValueKind.String
        && DateTimeOffset.TryParse((string?)n, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var t)
            ? t
            : null;

    /// <summary>A time that does not parse stays in fields under its 0.x name, so it is not lost.</summary>
    private DateTimeOffset? Time(JsonNode? n, string key, string name, JsonObject fields)
    {
        if (n is null || n.GetValueKind() == JsonValueKind.Null) return null;
        var t = Time(n);
        if (t is null)
        {
            fields[name] = n.DeepClone();
            _report.UnreadableTimes.Add($"{key}.{name} = {n.ToJsonString()}");
        }
        return t;
    }

    private static string Where(Record r) => Where(r.Kind, r.ArchivedAt);

    private static string Where(string kind, DateTimeOffset? archivedAt) =>
        archivedAt is null ? kind : $"archived {kind}";

    private static string Shorten(string s) => s.Length <= 120 ? s : s[..120] + "…";
}

public class ImportException(string message) : Exception(message);

/// <summary>Two records with one key. Second is the one that was dropped or renumbered.</summary>
public record Clash(string Key, string Kept, string Second, string SecondJson)
{
    public string Action { get; set; } = "";
}

public record Dangling(string From, string Field, string To);

public class ImportReport
{
    public string Board { get; set; } = "";
    public Dictionary<string, int> Records { get; set; } = [];
    public int Archived { get; set; }
    public int Comments { get; set; }
    public int ProgressNotes { get; set; }
    public Dictionary<string, int> Counters { get; set; } = [];
    public List<Clash> Clashes { get; } = [];
    public List<string> Skipped { get; } = [];
    public List<string> NotRead { get; } = [];
    public List<Dangling> Dangling { get; } = [];
    public List<string> UnreadableTimes { get; } = [];
    public int SidecarTests { get; set; }
    public int Attachments { get; set; }
}
