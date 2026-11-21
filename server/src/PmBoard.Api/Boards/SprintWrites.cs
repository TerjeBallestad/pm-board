using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Microsoft.EntityFrameworkCore;
using PmBoard.Api.Data;

namespace PmBoard.Api.Boards;

/// <summary>pm-board-cli api/sprints.js, the write side and the two POST reads (suggest, explore), per board.</summary>
public static partial class SprintWrites
{
    public static void MapSprintWrites(this RouteGroupBuilder g)
    {
        g.MapPost("/sprints", (string slug, HttpRequest req, BoardDb db) => Write.Run(req, db, slug, Create));
        g.MapPost("/sprints/{key}/suggest", (string slug, string key, HttpRequest req, BoardDb db) => Write.Run(req, db, slug, w => Suggest(w, key)))
            .AllowAnonymous(); // changes nothing: a read (DD-020)
        g.MapPost("/sprints/{key}/explore", (string slug, string key, HttpRequest req, BoardDb db) => Write.Run(req, db, slug, w => Explore(w, key)))
            .AllowAnonymous(); // changes nothing: a read (DD-020)
        g.MapPost("/sprints/{key}/items", (string slug, string key, HttpRequest req, BoardDb db) => Write.Run(req, db, slug, w => AddItems(w, key)));
        g.MapPost(
            "/sprints/{key}/comments",
            (string slug, string key, HttpRequest req, BoardDb db) => Write.Run(req, db, slug, w => w.Comment(RecordKind.Sprint, key, touch: false))
        );
        g.MapPatch("/sprints/{key}", (string slug, string key, HttpRequest req, BoardDb db) => Write.Run(req, db, slug, w => Patch(w, key)));
    }

    private static async Task<IResult> Create(Write w)
    {
        var b = w.Body;
        if (!Js.Truthy(b["name"])) return Write.Error(400, "name required");
        var (key, _) = await w.NextKey("SPRINT");
        var r = Write.NewRecord(w.Board, RecordKind.Sprint, key);
        r.Title = Js.Text(b["name"])!;
        r.Body = Js.Truthy(b["body"]) ? Js.Text(b["body"]) : "";
        r.Status = "active";
        r.CreatedAt = w.Now;
        // A sprint has no updatedAt in 0.x.
        Write.SetFields(
            r,
            new JsonObject
            {
                ["problemStatement"] = Js.Truthy(b["problemStatement"]) ? b["problemStatement"]!.DeepClone() : "",
                ["completedAt"] = null,
            }
        );
        w.Db.Records.Add(r);
        return Write.Json(await w.Shape(r), 201);
    }

    private static async Task<IResult> Patch(Write w, string key)
    {
        var r = await w.Lock(RecordKind.Sprint, key);
        if (r is null) return ReadRoutes.NotFound();
        var b = w.Body;
        if (w.Unknown("a project", "name", "problemStatement", "body", "status") is { } unknown) return unknown;
        var fields = Write.Fields(r);
        if (Js.Has(b, "name")) r.Title = Js.Text(b["name"]) ?? "";
        if (Js.Has(b, "problemStatement")) fields["problemStatement"] = b["problemStatement"]?.DeepClone();
        if (Js.Has(b, "body")) r.Body = Js.Text(b["body"]);
        if (Js.Has(b, "status")) r.Status = Js.Text(b["status"]);
        if (b["status"]?.GetValueKind() == JsonValueKind.String && (string)b["status"]! == "completed")
        {
            fields["completedAt"] = V0Json.Time(w.Now);
            // Completing a project closes its open items. 0.x sets doneAt but not updatedAt, and keeps claims.
            var open = await w.Db.Records.FromSql(
                    $"SELECT * FROM records WHERE board_id = {w.Board.Id} AND kind = 'item' AND sprint_key = {key} AND archived_at IS NULL AND stage IS DISTINCT FROM 'done' FOR UPDATE"
                )
                .AsAsyncEnumerable()
                .ToListAsync();
            foreach (var item in open)
            {
                item.Stage = "done";
                item.DoneAt = w.Now;
            }
        }
        Write.SetFields(r, fields);
        return Write.Json(await w.Shape(r));
    }

    private static async Task<IResult> AddItems(Write w, string key)
    {
        var sprint = await w.Lock(RecordKind.Sprint, key);
        if (sprint is null) return ReadRoutes.NotFound();
        if (w.Body["itemIds"] is not JsonArray ids) return Write.Error(400, "itemIds array required");
        var added = 0;
        foreach (var id in ids.Where(x => x?.GetValueKind() == JsonValueKind.String).Select(x => (string)x!))
        {
            var item = await w.Lock(RecordKind.Item, id);
            if (item is null) continue;
            // 0.x does not touch updatedAt here.
            item.SprintKey = sprint.Key;
            added++;
        }
        return Write.Json(new JsonObject { ["added"] = added });
    }

    private static async Task<IResult> Suggest(Write w, string key)
    {
        var data = await BoardData.Load(w.Db, w.Board);
        var sprint = data.Sprints.FirstOrDefault(s => Js.Str(s["id"]) == key);
        if (sprint is null) return ReadRoutes.NotFound();
        var words = Words(Js.Text(sprint["problemStatement"]) ?? "");
        // `${item.body}` prints "undefined" for an item with no body, and that word can score.
        var scored = Score(data.Items, words, i => Js.Str(i, "body")).Take(10);
        return Write.Json(
            new JsonArray(
                scored.Select(s =>
                {
                    var o = s.Item.DeepClone().AsObject();
                    o["relevanceScore"] = s.Score;
                    return (JsonNode)o;
                }).ToArray()
            )
        );
    }

    private static async Task<IResult> Explore(Write w, string key)
    {
        var data = await BoardData.Load(w.Db, w.Board);
        var sprint = data.Sprints.FirstOrDefault(s => Js.Str(s["id"]) == key);
        if (sprint is null) return ReadRoutes.NotFound();
        var items = data.Items.Where(i => Js.Str(i["sprintId"]) == key).ToList();
        var designs = data.Designs.Where(d => Js.Str(d["sprintId"]) == key).ToList();
        var plans = data.Plans.Where(p => Js.Str(p["sprintId"]) == key).ToList();

        var doc = $"# Sprint Dossier: {Js.Str(sprint, "name")}\n\n";
        doc += $"**ID:** {Js.Str(sprint, "id")} | **Status:** {Js.Str(sprint, "status")} | **Created:** {Js.Str(sprint, "createdAt")}\n\n";
        if (Js.Truthy(sprint["problemStatement"]))
        {
            doc += $"## Problem Statement\n\n{Js.Str(sprint["problemStatement"])}\n\n";
        }

        if (items.Count > 0)
        {
            doc += $"## Sprint Items ({items.Count})\n\n";
            foreach (var group in items.GroupBy(i => Js.Or(i["type"], "issue")))
            {
                var type = group.Key;
                doc += $"### {(type.Length > 0 ? char.ToUpperInvariant(type[0]) + type[1..] : "")}s\n\n";
                foreach (var item in group)
                {
                    doc += $"#### {Js.Str(item, "id")}: {Js.Str(item, "title")}\n";
                    doc += $"- **Priority:** {Js.Or(item["priority"], "unset")} | **Stage:** {Js.Str(item, "stage")}\n";
                    if (Js.Truthy(item["body"]))
                    {
                        var body = Js.Str(item["body"]);
                        doc += $"- {Js.Slice(body, 300)}{(body.Length > 300 ? "..." : "")}\n";
                    }
                    if (item["affectedFiles"] is JsonArray { Count: > 0 } files)
                    {
                        doc += $"- **Files:** {string.Join(", ", files.Select(f => "`" + Js.Str(f) + "`"))}\n";
                    }
                    doc += "\n";
                }
            }
        }

        if (designs.Count > 0)
        {
            doc += $"## Design Documents ({designs.Count})\n\n";
            foreach (var sdd in designs)
            {
                doc += $"### {Js.Str(sdd, "id")}: {Js.Str(sdd, "title")}\n\n";
                if (Js.Truthy(sdd["body"]))
                {
                    var body = Js.Str(sdd["body"]);
                    doc += Js.Slice(body, 500) + (body.Length > 500 ? "..." : "") + "\n\n";
                }
                if (sdd["itemIds"] is JsonArray { Count: > 0 } ids)
                {
                    doc += $"**Linked items:** {string.Join(", ", ids.Select(x => x is null ? "" : Js.Str(x)))}\n\n";
                }
            }
        }

        if (plans.Count > 0)
        {
            doc += $"## Plans ({plans.Count})\n\n";
            foreach (var plan in plans)
            {
                doc += $"### {Js.Str(plan, "id")}: {Js.Str(plan, "title")}\n\n";
                var ctx = plan["context"] as JsonObject;
                if (Js.Truthy(ctx?["designDecisions"]))
                {
                    doc += $"**Design decisions:** {SliceValue(ctx!["designDecisions"]!, 300)}\n\n";
                }
                if (ctx?["relevantFiles"] is JsonArray { Count: > 0 } rf)
                {
                    doc += $"**Files:** {string.Join(", ", rf.Select(f => "`" + Js.Str(f) + "`"))}\n\n";
                }
                if (plan["tasks"] is JsonArray { Count: > 0 } tasks)
                {
                    doc += $"**Tasks:** {tasks.Count(t => Js.Truthy((t as JsonObject)?["passes"]))}/{tasks.Count} complete\n\n";
                }
            }
        }

        // A Set in insertion order, then sorted as JavaScript sorts strings.
        var allFiles = new List<string>();
        foreach (var item in items)
        {
            foreach (var f in item["affectedFiles"] as JsonArray ?? []) allFiles.Add(Js.Str(f));
        }
        foreach (var plan in plans)
        {
            foreach (var f in (plan["context"] as JsonObject)?["relevantFiles"] as JsonArray ?? []) allFiles.Add(Js.Str(f));
        }
        if (allFiles.Count > 0)
        {
            doc += "## Aggregated Files\n\n";
            doc += string.Join("\n", allFiles.Distinct().Order(StringComparer.Ordinal).Select(f => $"- `{f}`")) + "\n\n";
        }

        var words = Words(Js.Or(sprint["problemStatement"], ""));
        if (words.Count > 0)
        {
            var scored = Score(data.Items, words, i => Js.Or(i["body"], "")).Take(5).ToList();
            if (scored.Count > 0)
            {
                doc += "## Potentially Relevant (Unassigned)\n\n";
                foreach (var (item, score) in scored)
                {
                    doc += $"- **{Js.Str(item, "id")}:** {Js.Str(item, "title")} (relevance: {score})\n";
                }
                doc += "\n";
            }
        }

        var topics = new List<JsonNode?> { sprint["name"], sprint["problemStatement"] }
            .Concat(items.Select(i => i["title"]))
            .Where(Js.Truthy)
            .Select(t => Js.Str(t).ToLowerInvariant().Trim())
            .Where(t => t.Length > 0)
            .Distinct()
            .Take(5)
            .ToList();
        if (topics.Count > 0 && w.Cfg.QmdCommand("") is not null)
        {
            doc += "## Knowledge Base Queries\n\n";
            doc += "Run these to gather design context:\n\n";
            foreach (var topic in topics)
            {
                doc += $"```\n{w.Cfg.QmdCommand(topic)}\n```\n\n";
            }
        }

        return Write.Json(new JsonObject { ["sprint"] = sprint["id"]?.DeepClone(), ["dossier"] = doc });
    }

    /// <summary>The words of a problem statement that count: longer than three characters.</summary>
    private static List<string> Words(string text) =>
        Whitespace().Split(text.ToLowerInvariant()).Where(w => w.Length > 3).ToList();

    /// <summary>
    /// Items in no project and not done, scored by how many of the words their title and body hold,
    /// best first, ties in board order (a stable sort, as in JavaScript).
    /// </summary>
    private static IEnumerable<(JsonObject Item, int Score)> Score(List<JsonObject> items, List<string> words, Func<JsonObject, string> body) =>
        items
            .Where(i => !Js.Truthy(i["sprintId"]) && Js.Text(i["stage"]) != "done")
            .Select(i =>
            {
                var text = $"{Js.Str(i, "title")} {body(i)}".ToLowerInvariant();
                return (Item: i, Score: words.Count(w => text.Contains(w, StringComparison.Ordinal)));
            })
            .Where(s => s.Score > 0)
            .OrderByDescending(s => s.Score);

    /// <summary>value.slice(0, n) for a string or an array, printed.</summary>
    private static string SliceValue(JsonNode v, int n) =>
        v is JsonArray a ? Js.Str(new JsonArray(a.Take(n).Select(x => x?.DeepClone()).ToArray())) : Js.Slice(Js.Str(v), n);

    [GeneratedRegex(@"\s+")]
    private static partial Regex Whitespace();
}
