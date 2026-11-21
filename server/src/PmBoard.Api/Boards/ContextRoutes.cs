using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using PmBoard.Api.Data;

namespace PmBoard.Api.Boards;

/// <summary>
/// pm-board-cli api/context.js: the prompt and review texts, per board. The knowledge-base command
/// (qmd) runs on the machine of whoever asks, not on the server (DD-017). Where 0.x ran it, the
/// answer lists the queries in `qmdQueries`, and the CLI runs them and appends the results as 0.x did.
/// GET context/qmd stays in the CLI for the same reason.
/// </summary>
public static partial class ContextRoutes
{
    public static void MapContextRoutes(this RouteGroupBuilder g)
    {
        g.MapPost("/context/prompt", (string slug, HttpRequest req, BoardDb db) => Write.Run(req, db, slug, Prompt))
            .AllowAnonymous(); // changes nothing: a read (DD-020)
        g.MapPost("/context/review", (string slug, HttpRequest req, BoardDb db) => Write.Run(req, db, slug, Review))
            .AllowAnonymous(); // changes nothing: a read (DD-020)
    }

    private static async Task<IResult> Prompt(Write w)
    {
        var entityType = Js.Text(w.Body["entityType"]);
        var entityId = w.Body["entityId"];
        var data = await BoardData.Load(w.Db, w.Board);
        var project = new JsonObject { ["name"] = w.Cfg.Name };
        string prompt;
        string? title;

        if (entityType == "item")
        {
            var item = Find(data.Items, entityId);
            if (item is null) return Write.Error(404, "Item not found");
            title = Js.Text(item["title"]);
            var related = item["related"];
            var relatedItems = data.Items.Where(i => Includes(related, i["id"]));
            prompt = Templates.RenderTemplate(
                w.Cfg,
                "prompt-item",
                new JsonObject
                {
                    ["project"] = project,
                    ["item"] = new JsonObject
                    {
                        ["id"] = item["id"]?.DeepClone(),
                        ["title"] = item["title"]?.DeepClone(),
                        ["type"] = item["type"]?.DeepClone(),
                        ["priority"] = Js.Or(item["priority"], "unset"),
                        ["stage"] = item["stage"]?.DeepClone(),
                        ["body"] = Js.Truthy(item["body"]) ? item["body"]!.DeepClone() : "(no description)",
                        ["affectedFiles"] = Templates.FilesBlob(item["affectedFiles"]),
                        ["related"] = Templates.RelatedBlob(relatedItems),
                        ["comments"] = Templates.CommentsBlob(item["comments"]),
                    },
                },
                ItemPromptFallback(item)
            );
        }
        else if (entityType == "sdd")
        {
            var sdd = Find(data.Designs, entityId);
            if (sdd is null) return Write.Error(404, "SDD not found");
            title = Js.Text(sdd["title"]);
            prompt = Templates.RenderTemplate(
                w.Cfg,
                "prompt-sdd",
                new JsonObject
                {
                    ["project"] = project,
                    ["sdd"] = new JsonObject
                    {
                        ["id"] = sdd["id"]?.DeepClone(),
                        ["title"] = sdd["title"]?.DeepClone(),
                        ["body"] = Js.Truthy(sdd["body"]) ? sdd["body"]!.DeepClone() : "(no description)",
                        ["linkedItems"] = Templates.ItemsBlob(Linked(data, sdd)),
                        ["comments"] = Templates.CommentsBlob(sdd["comments"]),
                    },
                },
                $"# {Js.Str(sdd, "id")}: {Js.Str(sdd, "title")}\n\n" + (Js.Truthy(sdd["body"]) ? Js.Str(sdd["body"]) + "\n\n" : "")
            );
        }
        else if (entityType == "plan")
        {
            var plan = Find(data.Plans, entityId);
            if (plan is null) return Write.Error(404, "Plan not found");
            title = Js.Text(plan["title"]);
            var sdd = Find(data.Designs, plan["sddId"]);
            var ctx = plan["context"] as JsonObject;
            prompt = Templates.RenderTemplate(
                w.Cfg,
                "prompt-plan",
                new JsonObject
                {
                    ["project"] = project,
                    ["plan"] = new JsonObject
                    {
                        ["id"] = plan["id"]?.DeepClone(),
                        ["title"] = plan["title"]?.DeepClone(),
                        ["setupNotes"] = Js.Truthy(ctx?["setupNotes"]) ? ctx!["setupNotes"]!.DeepClone() : "",
                        ["designDecisions"] = Js.Truthy(ctx?["designDecisions"]) ? ctx!["designDecisions"]!.DeepClone() : "",
                        ["relevantFiles"] = Templates.FilesBlob(ctx?["relevantFiles"]),
                        ["sddTitle"] = sdd is null ? "(none)" : $"{Js.Str(sdd, "id")} — {Js.Str(sdd, "title")}",
                        ["sddBody"] = Js.Truthy(sdd?["body"]) ? sdd!["body"]!.DeepClone() : "(no SDD linked)",
                        ["taskList"] = Templates.TasksBlob(plan["tasks"]),
                    },
                },
                $"# {Js.Str(plan, "id")}: {Js.Str(plan, "title")}\n\n"
                    + (Js.Truthy(ctx?["setupNotes"]) ? $"## Setup\n\n{Js.Str(ctx!["setupNotes"])}\n\n" : "")
            );
        }
        else
        {
            return Write.Error(400, "entityType must be item, sdd, or plan");
        }

        var o = Answer(prompt, w.Body);
        // includeQmd: 0.x ran one query, the record's title, and appended a non-empty result.
        if (Js.Truthy(w.Body["includeQmd"]) && !string.IsNullOrEmpty(title) && w.Cfg.QmdCommand(title) is not null)
        {
            o["qmdQueries"] = new JsonArray(title);
        }
        return Write.Json(o);
    }

    private static async Task<IResult> Review(Write w)
    {
        var entityType = Js.Text(w.Body["entityType"]);
        var entityId = w.Body["entityId"];
        var data = await BoardData.Load(w.Db, w.Board);
        var project = new JsonObject { ["name"] = w.Cfg.Name };
        string prompt;
        var queries = new List<string>();

        if (entityType == "sdd")
        {
            var sdd = Find(data.Designs, entityId);
            if (sdd is null) return Write.Error(404, "SDD not found");
            var linked = Linked(data, sdd).ToList();
            var decisions = data.Items.Where(i => Js.Text(i["type"]) == "decision").Take(20);
            prompt = Templates.RenderTemplate(
                w.Cfg,
                "review-sdd",
                new JsonObject
                {
                    ["project"] = project,
                    ["sdd"] = new JsonObject
                    {
                        ["id"] = sdd["id"]?.DeepClone(),
                        ["title"] = sdd["title"]?.DeepClone(),
                        ["body"] = Js.Truthy(sdd["body"]) ? sdd["body"]!.DeepClone() : "(empty body)",
                        ["linkedItems"] = Templates.ItemsBlob(linked),
                        ["decisions"] = Templates.DecisionsBlob(decisions),
                    },
                },
                $"# SDD Review: {Js.Str(sdd, "id")} — {Js.Str(sdd, "title")}\n\n(No review template found. Install default templates.)\n\n{Js.Or(sdd["body"], "")}"
            );
            queries.Add(Js.Str(sdd, "title"));
            queries.AddRange(linked.Select(i => Js.Str(i, "title")));
        }
        else if (entityType == "plan")
        {
            var plan = Find(data.Plans, entityId);
            if (plan is null) return Write.Error(404, "Plan not found");
            var sdd = Find(data.Designs, plan["sddId"]);
            var ctx = plan["context"] as JsonObject;
            var dd = ctx?["designDecisions"];
            var refs = Js.Truthy(dd)
                ? DdRef().Matches(dd is JsonArray a ? string.Join(" ", a.Select(x => x is null ? "" : Js.Str(x))) : Js.Str(dd)).Select(m => m.Value).ToList()
                : [];
            var referenced = refs.Select(r => Find(data.Items, r)).OfType<JsonObject>();
            prompt = Templates.RenderTemplate(
                w.Cfg,
                "review-plan",
                new JsonObject
                {
                    ["project"] = project,
                    ["plan"] = new JsonObject
                    {
                        ["id"] = plan["id"]?.DeepClone(),
                        ["title"] = plan["title"]?.DeepClone(),
                        ["setupNotes"] = Js.Truthy(ctx?["setupNotes"]) ? ctx!["setupNotes"]!.DeepClone() : "",
                        ["designDecisions"] = dd is JsonArray arr
                            ? string.Join("\n", arr.Select(x => x is null ? "" : Js.Str(x)))
                            : Js.Truthy(dd) ? dd!.DeepClone() : "",
                        ["relevantFiles"] = Templates.FilesBlob(ctx?["relevantFiles"]),
                        ["sddTitle"] = sdd is null ? "(none)" : $"{Js.Str(sdd, "id")} — {Js.Str(sdd, "title")}",
                        ["sddBody"] = Js.Truthy(sdd?["body"]) ? sdd!["body"]!.DeepClone() : "(no SDD linked)",
                        ["taskList"] = Templates.TasksBlob(plan["tasks"]),
                        ["referencedDecisions"] = Templates.ItemsBlob(referenced),
                    },
                },
                $"# Plan Review: {Js.Str(plan, "id")} — {Js.Str(plan, "title")}\n\n(No review template found. Install default templates.)"
            );
            queries.Add(Js.Str(plan, "title"));
            if (sdd is not null) queries.Add(Js.Str(sdd, "title"));
            foreach (var r in refs.Take(3))
            {
                if (Find(data.Items, r) is { } item) queries.Add(Js.Str(item, "title"));
            }
        }
        else
        {
            return Write.Error(400, "entityType must be sdd or plan");
        }

        var o = Answer(prompt, w.Body);
        // 0.x ran up to five distinct queries when a knowledge base is set, and appended the
        // non-empty results under "## Knowledge Base Context".
        var distinct = queries.Distinct().Take(5).ToList();
        if (distinct.Count > 0 && w.Cfg.QmdCommand("") is not null)
        {
            o["qmdQueries"] = new JsonArray(distinct.Select(q => (JsonNode)q).ToArray());
        }
        return Write.Json(o);
    }

    private static JsonObject Answer(string prompt, JsonObject body)
    {
        var o = new JsonObject { ["prompt"] = prompt };
        if (body.ContainsKey("entityType")) o["entityType"] = body["entityType"]?.DeepClone();
        if (body.ContainsKey("entityId")) o["entityId"] = body["entityId"]?.DeepClone();
        return o;
    }

    private static string ItemPromptFallback(JsonObject item)
    {
        var p = $"# {Js.Str(item, "id")}: {Js.Str(item, "title")}\n\n";
        p += $"**Type:** {Js.Str(item, "type")} | **Priority:** {Js.Or(item["priority"], "unset")} | **Stage:** {Js.Str(item, "stage")}\n\n";
        if (Js.Truthy(item["body"])) p += $"## Description\n\n{Js.Str(item["body"])}\n\n";
        return p;
    }

    /// <summary>The design's itemIds that are live items, in itemIds order.</summary>
    private static IEnumerable<JsonObject> Linked(BoardData data, JsonObject sdd) =>
        (sdd["itemIds"] as JsonArray ?? []).Select(id => Find(data.Items, id)).OfType<JsonObject>();

    /// <summary>list.find(x => x.id === id).</summary>
    private static JsonObject? Find(List<JsonObject> list, JsonNode? id) =>
        id?.GetValueKind() == JsonValueKind.String ? Find(list, (string)id!) : null;

    private static JsonObject? Find(List<JsonObject> list, string id) =>
        list.FirstOrDefault(x => x["id"]?.GetValueKind() == JsonValueKind.String && (string)x["id"]! == id);

    /// <summary>(related || []).includes(id): an array holds it, or a string contains it.</summary>
    private static bool Includes(JsonNode? related, JsonNode? id)
    {
        if (id?.GetValueKind() != JsonValueKind.String) return false;
        var s = (string)id!;
        return related switch
        {
            JsonArray a => a.Any(x => x?.GetValueKind() == JsonValueKind.String && (string)x! == s),
            JsonValue v when v.GetValueKind() == JsonValueKind.String => ((string)v!).Contains(s, StringComparison.Ordinal),
            _ => false,
        };
    }

    [GeneratedRegex(@"DD-\d+", RegexOptions.ECMAScript)]
    private static partial Regex DdRef();
}
