using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using PmBoard.Api.Data;

namespace PmBoard.Api.Board;

/// <summary>
/// Turns records back into the JSON that the 0.x API returned, so the dashboard and the CLI read the
/// same shapes (the mapping table in server/docs/data-model.md, read the other way).
/// </summary>
public static class V0Json
{
    /// <summary>0.x wrote times with Date.toISOString(): milliseconds and a Z.</summary>
    public static string Time(DateTimeOffset t) =>
        t.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture);

    public static JsonObject Record(Record r, IReadOnlyList<Comment> comments, IReadOnlyList<(Record Task, IReadOnlyList<Comment> Notes)>? tasks = null)
    {
        var o = new JsonObject { ["id"] = r.Key };
        if (r.Kind == RecordKind.Item)
        {
            o["type"] = r.Type;
        }
        o[r.Kind == RecordKind.Sprint ? "name" : "title"] = r.Title;
        Put(o, "stage", r.Stage);
        Put(o, "status", r.Status);
        if (r.Kind is RecordKind.Item)
        {
            o["priority"] = r.Priority;
        }
        else
        {
            Put(o, "priority", r.Priority);
        }
        Put(o, "body", r.Body);
        if (r.Kind is RecordKind.Item or RecordKind.Task || r.BlockedBy.Count > 0)
        {
            o["blockedBy"] = new JsonArray(r.BlockedBy.Select(b => (JsonNode)b).ToArray());
        }
        if (r.Kind is RecordKind.Item or RecordKind.Design or RecordKind.Plan)
        {
            o["sprintId"] = r.SprintKey;
        }
        if (r.Kind is RecordKind.Item)
        {
            o["assignee"] = r.Assignee;
            o["assignedAt"] = r.AssignedAt is { } a ? Time(a) : null;
        }

        // Every other 0.x field, as it was. A time that did not parse is in here under its own name.
        foreach (var p in r.Fields.RootElement.EnumerateObject())
        {
            if (p.Name == "v0Key") continue;
            o[p.Name] = JsonNode.Parse(p.Value.GetRawText());
        }

        PutTime(o, "createdAt", r.CreatedAt);
        PutTime(o, "updatedAt", r.UpdatedAt);
        PutTime(o, "doneAt", r.DoneAt);
        PutTime(o, "archivedAt", r.ArchivedAt);

        if (r.Kind == RecordKind.Task)
        {
            o["progressNotes"] = new JsonArray(
                comments
                    .Where(c => c.Kind == CommentKind.Progress)
                    .Select(c => (JsonNode)new JsonObject { ["text"] = c.Text, ["timestamp"] = c.CreatedAt is { } t ? Time(t) : null })
                    .ToArray()
            );
        }
        else if (r.Kind != RecordKind.Milestone)
        {
            o["comments"] = new JsonArray(comments.Where(c => c.Kind == CommentKind.Comment).Select(Comment).ToArray());
        }

        if (tasks is not null)
        {
            o["tasks"] = new JsonArray(tasks.Select(t => (JsonNode)Record(t.Task, t.Notes)).ToArray());
        }
        return o;
    }

    public static JsonNode Comment(Comment c)
    {
        var o = new JsonObject { ["id"] = c.LegacyId ?? c.Id.ToString() };
        Put(o, "author", c.Author);
        o["text"] = c.Text;
        if (c.CreatedAt is { } t) o["createdAt"] = Time(t);
        return o;
    }

    private static void Put(JsonObject o, string name, string? value)
    {
        if (value is not null) o[name] = value;
    }

    private static void PutTime(JsonObject o, string name, DateTimeOffset? value)
    {
        if (value is { } t && !o.ContainsKey(name)) o[name] = Time(t);
    }
}
