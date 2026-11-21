using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Microsoft.EntityFrameworkCore;
using PmBoard.Api.Data;
using PmBoard.Api.Keys;

namespace PmBoard.Api.Boards;

/// <summary>pm-board-cli api/plans.js: the writes, and the two reads next-task and context, per board.</summary>
public static partial class PlanWrites
{
    public static void MapPlanWrites(this RouteGroupBuilder g)
    {
        g.MapPost("/plans", (string slug, HttpRequest req, BoardDb db) => Write.Run(req, db, slug, Create));
        g.MapGet("/plans/{key}/next-task", NextTask);
        g.MapGet("/plans/{key}/context", PlanContext);
        g.MapPost("/plans/{key}/tasks", (string slug, string key, HttpRequest req, BoardDb db) => Write.Run(req, db, slug, w => AddTasks(w, key)));
        g.MapPatch(
            "/plans/{planKey}/tasks/{taskKey}",
            (string slug, string planKey, string taskKey, HttpRequest req, BoardDb db) => Write.Run(req, db, slug, w => PatchTask(w, planKey, taskKey))
        );
        g.MapPost(
            "/plans/{key}/comments",
            (string slug, string key, HttpRequest req, BoardDb db) => Write.Run(req, db, slug, w => w.Comment(RecordKind.Plan, key, touch: true))
        );
        g.MapPatch("/plans/{key}", (string slug, string key, HttpRequest req, BoardDb db) => Write.Run(req, db, slug, w => Patch(w, key)));
    }

    private static async Task<IResult> Create(Write w)
    {
        var b = w.Body;
        if (!Js.Truthy(b["title"])) return Write.Error(400, "title required");
        var (key, _) = await w.NextKey("PLAN");
        var plan = Write.NewRecord(w.Board, RecordKind.Plan, key);
        plan.Title = Js.Text(b["title"])!;
        plan.Stage = "planned";
        plan.SprintKey = Js.Truthy(b["sprintId"]) ? Js.Text(b["sprintId"]) : null;
        plan.CreatedAt = w.Now;
        plan.UpdatedAt = w.Now;
        Write.SetFields(
            plan,
            new JsonObject
            {
                ["sddId"] = Js.Truthy(b["sddId"]) ? b["sddId"]!.DeepClone() : null,
                ["context"] = Js.Truthy(b["context"])
                    ? b["context"]!.DeepClone()
                    : new JsonObject { ["setupNotes"] = "", ["relevantFiles"] = new JsonArray(), ["designDecisions"] = "" },
            }
        );

        var built = await BuildTasks(w, plan, b["tasks"], preserve: false);
        if (built.Error is { } error) return error;
        var tasks = built.Tasks;
        ResolveBlockedBy(tasks);
        if (Unresolved(tasks) is { Count: > 0 } errors) return Refused(errors);

        w.Db.Records.Add(plan);
        await SaveTasks(w, plan, [], tasks, rebuild: true);
        return Write.Json(await w.Shape(plan), 201);
    }

    private static async Task<IResult> Patch(Write w, string key)
    {
        var plan = await w.Lock(RecordKind.Plan, key);
        if (plan is null) return ReadRoutes.NotFound();
        var b = w.Body;
        if (w.Unknown("a plan", "title", "sddId", "stage", "sprintId", "context", "tasks") is { } unknown) return unknown;
        var fields = Write.Fields(plan);
        if (Js.Has(b, "title")) plan.Title = Js.Text(b["title"]) ?? "";
        if (Js.Has(b, "stage")) plan.Stage = Js.Text(b["stage"]);
        if (Js.Has(b, "sprintId")) plan.SprintKey = Js.Text(b["sprintId"]);
        if (Js.Has(b, "sddId")) fields["sddId"] = b["sddId"]?.DeepClone();
        if (Js.Has(b, "context")) fields["context"] = b["context"]?.DeepClone();
        Write.SetFields(plan, fields);

        if (b["tasks"] is JsonArray)
        {
            // A full replacement: a task with an id keeps it, with its status and notes as given.
            var existing = await w.LockTasks(plan);
            var built = await BuildTasks(w, plan, b["tasks"], preserve: true);
            if (built.Error is { } error) return error;
            ResolveBlockedBy(built.Tasks);
            if (Unresolved(built.Tasks) is { Count: > 0 } errors) return Refused(errors);
            await SaveTasks(w, plan, existing, built.Tasks, rebuild: true);
        }
        plan.UpdatedAt = w.Now;
        return Write.Json(await w.Shape(plan));
    }

    private static async Task<IResult> AddTasks(Write w, string key)
    {
        var plan = await w.Lock(RecordKind.Plan, key);
        if (plan is null) return ReadRoutes.NotFound();
        if (w.Body["tasks"] is not JsonArray { Count: > 0 }) return Write.Error(400, "tasks array required");
        var existing = await w.LockTasks(plan);
        var current = (await w.Shape(plan))["tasks"]!.AsArray().Select(t => t!.AsObject()).ToList();
        var built = await BuildTasks(w, plan, w.Body["tasks"], preserve: false);
        if (built.Error is { } error) return error;
        // 0.x resolves and checks the whole list, so an old task's ordinal blockers become keys here too.
        var merged = current.Concat(built.Tasks).ToList();
        ResolveBlockedBy(merged);
        if (Unresolved(merged) is { Count: > 0 } errors) return Refused(errors);
        await SaveTasks(w, plan, existing, merged, rebuild: false);
        plan.UpdatedAt = w.Now;

        var newKeys = built.Tasks.Select(t => Js.Str(t["id"])).ToHashSet();
        var tasks = (await w.Shape(plan))["tasks"]!.AsArray();
        var added = tasks.Where(t => newKeys.Contains((string)t!["id"]!)).Select(t => t!.DeepClone()).ToArray();
        return Write.Json(new JsonObject { ["added"] = new JsonArray(added), ["total"] = tasks.Count }, 201);
    }

    private static async Task<IResult> PatchTask(Write w, string planKey, string taskKey)
    {
        var plan = await w.Lock(RecordKind.Plan, planKey);
        if (plan is null) return Write.Error(404, "Plan not found");
        var task = (await w.LockTasks(plan)).SingleOrDefault(t => t.Key == taskKey);
        if (task is null) return Write.Error(404, "Task not found");
        var b = w.Body;
        if (w.Unknown("a task", "description", "steps", "verification", "status", "passes", "progressNote") is { } unknown) return unknown;

        var fields = Write.Fields(task);
        foreach (var name in new[] { "description", "steps", "verification" })
        {
            if (Js.Has(b, name)) fields[name] = b[name]?.DeepClone();
        }
        if (Js.Truthy(b["status"])) task.Status = Js.Text(b["status"]);
        if (Js.Has(b, "passes")) fields["passes"] = b["passes"]?.DeepClone();
        if (Js.Truthy(b["progressNote"]))
        {
            await w.AddComment(task, CommentKind.Progress, null, Js.Text(b["progressNote"])!);
        }
        if (Js.Truthy(fields["passes"]) && task.Status != "done") task.Status = "done";
        Write.SetFields(task, fields);
        plan.UpdatedAt = w.Now;

        var shaped = (await w.Shape(plan))["tasks"]!.AsArray().Single(t => (string)t!["id"]! == taskKey)!;
        return Write.Json(shaped.DeepClone());
    }

    private static async Task<IResult> NextTask(string slug, string key, BoardDb db)
    {
        if (await ReadRoutes.Board(db, slug) is not { } board) return ReadRoutes.NotFound();
        var planRecord = await ReadRoutes.Live(db, board, RecordKind.Plan).SingleOrDefaultAsync(r => r.Key == key);
        if (planRecord is null) return ReadRoutes.NotFound();
        var plan = (await ReadRoutes.Shape(db, [planRecord]))[0]!.AsObject();
        var tasks = plan["tasks"]!.AsArray().Select(t => t!.AsObject()).ToList();
        var byId = Ids(tasks);
        var passed = tasks.Where(t => Js.Truthy(t["passes"])).Select(t => Js.Str(t["id"])).ToHashSet();

        var withUnblocked = tasks.Select(t =>
        {
            var o = t.DeepClone().AsObject();
            var blockers = t["blockedBy"] as JsonArray ?? [];
            o["unblocked"] = blockers.All(dep => ResolveRef(dep, tasks, byId) is { } r && r.GetValueKind() == JsonValueKind.String && passed.Contains((string)r!));
            return (JsonNode)o;
        });

        var context = plan["context"] as JsonObject;
        var sddKey = plan["sddId"];
        var sdd = sddKey?.GetValueKind() == JsonValueKind.String
            ? await ReadRoutes.Live(db, board, RecordKind.Design).AnyAsync(d => d.Key == (string)sddKey!)
            : false;
        var references = new JsonObject { ["plan"] = $"/api/plans/{Js.Str(plan["id"])}" };
        if (sdd) references["sdd"] = $"/api/designs/{(string)sddKey!}";
        if (Js.Truthy(plan["sprintId"])) references["sprint"] = $"/api/sprints/{Js.Str(plan["sprintId"])}/explore";

        return Results.Json(
            new JsonObject
            {
                ["planTitle"] = plan["title"]?.DeepClone(),
                ["tasks"] = new JsonArray(withUnblocked.ToArray()),
                ["designDecisions"] = Js.Truthy(context?["designDecisions"]) ? context!["designDecisions"]!.DeepClone() : "",
                ["relevantFiles"] = Js.Truthy(context?["relevantFiles"]) ? context!["relevantFiles"]!.DeepClone() : new JsonArray(),
                ["references"] = references,
                ["progress"] = new JsonObject { ["completed"] = passed.Count, ["total"] = tasks.Count },
                ["allComplete"] = tasks.All(t => Js.Truthy(t["passes"])),
            }
        );
    }

    private static async Task<IResult> PlanContext(string slug, string key, BoardDb db)
    {
        if (await ReadRoutes.Board(db, slug) is not { } board) return ReadRoutes.NotFound();
        var planRecord = await ReadRoutes.Live(db, board, RecordKind.Plan).SingleOrDefaultAsync(r => r.Key == key);
        if (planRecord is null) return ReadRoutes.NotFound();
        var plan = (await ReadRoutes.Shape(db, [planRecord]))[0]!.AsObject();
        var tasks = plan["tasks"]!.AsArray().Select(t => t!.AsObject()).ToList();
        var sddKey = plan["sddId"];
        var sddRecord = sddKey?.GetValueKind() == JsonValueKind.String
            ? await ReadRoutes.Live(db, board, RecordKind.Design).SingleOrDefaultAsync(d => d.Key == (string)sddKey!)
            : null;
        JsonNode? sdd = null;
        if (sddRecord is not null)
        {
            var s = (await ReadRoutes.Shape(db, [sddRecord]))[0]!.AsObject();
            sdd = Pick(s, "id", "title", "body");
        }

        var o = new JsonObject { ["planId"] = plan["id"]?.DeepClone(), ["title"] = plan["title"]?.DeepClone() };
        if (plan.ContainsKey("context")) o["context"] = plan["context"]?.DeepClone();
        o["sdd"] = sdd;
        o["progress"] = new JsonObject { ["completed"] = tasks.Count(t => Js.Truthy(t["passes"])), ["total"] = tasks.Count };
        o["tasks"] = new JsonArray(tasks.Select(t => (JsonNode)Pick(t, "id", "title", "status", "passes")).ToArray());
        return Results.Json(o);
    }

    /// <summary>The named fields that are there, as JSON.stringify writes an object with undefined fields.</summary>
    private static JsonObject Pick(JsonObject from, params string[] names)
    {
        var o = new JsonObject();
        foreach (var n in names)
        {
            if (from.ContainsKey(n)) o[n] = from[n]?.DeepClone();
        }
        return o;
    }

    private static IResult Refused(List<string> errors) =>
        Write.Json(
            new JsonObject { ["error"] = "unresolved blockedBy refs", ["details"] = new JsonArray(errors.Select(e => (JsonNode)e).ToArray()) },
            400
        );

    /// <summary>
    /// buildTasks: normalized tasks, each with a key. A new task gets the next TASK key. With
    /// preserve (the full replacement in PATCH), a task keeps the id, status and notes it was given.
    /// 1.x refuses an id that is twice in the list or is another record's key (DD-016): 0.x wrote both,
    /// and two records with one key are what the importer had to renumber.
    /// </summary>
    private static async Task<(List<JsonObject> Tasks, IResult? Error)> BuildTasks(Write w, Record plan, JsonNode? input, bool preserve)
    {
        var tasks = new List<JsonObject>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var item in input as JsonArray ?? [])
        {
            var t = item as JsonObject ?? [];
            string id;
            if (preserve && Js.Truthy(t["id"]))
            {
                id = Js.Str(t["id"]);
                if (!seen.Add(id)) return ([], Write.Error(400, $"{id} is in the tasks list twice"));
                var owner = await w.Db.Records.AsNoTracking()
                    .Where(r => r.BoardId == w.Board.Id && r.Key == id && r.ParentId != plan.Id)
                    .Select(r => new { r.Kind, Plan = w.Db.Records.Where(p => p.Id == r.ParentId).Select(p => p.Key).FirstOrDefault() })
                    .FirstOrDefaultAsync();
                if (owner is not null)
                {
                    var what = owner.Plan is null ? $"a {owner.Kind}" : $"a task of {owner.Plan}";
                    return ([], Write.Error(400, $"{id} is already the key of another record ({what}): leave out the id for a new task"));
                }
                // A key given by hand must never come out of the counter later.
                if (KeyAllocator.Parse(id) is { Prefix: { } prefix, Number: { } number })
                {
                    await KeyAllocator.ReserveAsync(w.Db, w.Board.Id, prefix, number);
                }
            }
            else
            {
                (id, _) = await w.NextKey("TASK");
                seen.Add(id);
            }
            tasks.Add(
                new JsonObject
                {
                    ["id"] = id,
                    ["title"] = Or(t["title"], ""),
                    ["description"] = Or(t["description"], ""),
                    ["steps"] = Or(t["steps"], new JsonArray()),
                    ["verification"] = Or(t["verification"], ""),
                    ["blockedBy"] = Or(t["blockedBy"], new JsonArray()),
                    ["passes"] = preserve ? Or(t["passes"], false) : false,
                    ["status"] = preserve ? Or(t["status"], "pending") : "pending",
                    ["progressNotes"] = preserve ? Or(t["progressNotes"], new JsonArray()) : new JsonArray(),
                }
            );
        }
        return (tasks, null);
    }

    /// <summary>
    /// Writes a plan's task list. With rebuild, each task is exactly the given JSON (0.x rewrote the
    /// file from buildTasks); without, the tasks already there change only in blockedBy.
    /// </summary>
    private static async Task SaveTasks(Write w, Record plan, List<Record> existing, List<JsonObject> tasks, bool rebuild)
    {
        var byKey = existing.ToDictionary(r => r.Key, StringComparer.Ordinal);
        var kept = new HashSet<string>(StringComparer.Ordinal);
        for (var i = 0; i < tasks.Count; i++)
        {
            var t = tasks[i];
            var key = Js.Str(t["id"]);
            kept.Add(key);
            var isNew = !byKey.TryGetValue(key, out var r);
            if (r is null)
            {
                r = Write.NewRecord(w.Board, RecordKind.Task, key);
                r.ParentId = plan.Id;
                w.Db.Records.Add(r);
            }
            r.Position = i;
            if (!isNew && !rebuild)
            {
                var f = Write.Fields(r);
                Write.SetBlockedBy(r, f, t["blockedBy"]);
                Write.SetFields(r, f);
                continue;
            }

            r.Title = Js.Text(t["title"]) ?? "";
            r.Status = Js.Text(t["status"]);
            var fields = new JsonObject
            {
                ["description"] = t["description"]?.DeepClone(),
                ["steps"] = t["steps"]?.DeepClone(),
                ["verification"] = t["verification"]?.DeepClone(),
                ["passes"] = t["passes"]?.DeepClone(),
            };
            Write.SetBlockedBy(r, fields, t["blockedBy"]);
            Write.SetFields(r, fields);

            if (!isNew)
            {
                await w.Db.Comments.Where(c => c.RecordId == r.Id && c.Kind == CommentKind.Progress).ExecuteDeleteAsync();
            }
            var position = 0;
            foreach (var n in (t["progressNotes"] as JsonArray ?? []).OfType<JsonObject>())
            {
                w.Db.Comments.Add(
                    new Comment
                    {
                        Id = Guid.CreateVersion7(),
                        RecordId = r.Id,
                        Position = position++,
                        Kind = CommentKind.Progress,
                        Text = Js.Text(n["text"]) ?? "",
                        CreatedAt = n["timestamp"]?.GetValueKind() == JsonValueKind.String
                            && DateTimeOffset.TryParse((string)n["timestamp"]!, out var at)
                                ? at
                                : null,
                    }
                );
            }
        }
        foreach (var gone in existing.Where(r => !kept.Contains(r.Key)))
        {
            await w.Delete(gone);
        }
    }

    /// <summary>resolveRef: a task key, or "TASK-1", "Task 1", "task_1", "#1", "1" for the Nth task (from 1).</summary>
    private static JsonNode? ResolveRef(JsonNode? r, List<JsonObject> tasks, HashSet<string> byId)
    {
        if (r?.GetValueKind() == JsonValueKind.String && byId.Contains((string)r!)) return r.DeepClone();
        var m = Ordinal().Match(r is null ? "null" : Js.Str(r));
        if (m.Success && long.TryParse(m.Groups[1].Value, out var n) && n - 1 >= 0 && n - 1 < tasks.Count)
        {
            return tasks[(int)(n - 1)]["id"]?.DeepClone();
        }
        return r?.DeepClone();
    }

    private static void ResolveBlockedBy(List<JsonObject> tasks)
    {
        var byId = Ids(tasks);
        foreach (var t in tasks)
        {
            var blockers = t["blockedBy"] as JsonArray ?? [];
            t["blockedBy"] = new JsonArray(blockers.Select(x => ResolveRef(x, tasks, byId)).ToArray());
        }
    }

    private static List<string> Unresolved(List<JsonObject> tasks)
    {
        var byId = Ids(tasks);
        var errors = new List<string>();
        foreach (var t in tasks)
        {
            foreach (var dep in t["blockedBy"] as JsonArray ?? [])
            {
                if (!(dep?.GetValueKind() == JsonValueKind.String && byId.Contains((string)dep!)))
                {
                    errors.Add($"{Js.Str(t, "id")} blockedBy \"{(dep is null ? "null" : Js.Str(dep))}\" matches no task id or ordinal");
                }
            }
        }
        return errors;
    }

    private static HashSet<string> Ids(List<JsonObject> tasks) =>
        tasks.Where(t => t["id"]?.GetValueKind() == JsonValueKind.String).Select(t => (string)t["id"]!).ToHashSet(StringComparer.Ordinal);

    /// <summary><c>value || fallback</c>.</summary>
    private static JsonNode? Or(JsonNode? value, JsonNode fallback) => Js.Truthy(value) ? value!.DeepClone() : fallback;

    [GeneratedRegex(@"^\s*(?:task[\s\-_]*)?#?(\d+)\s*$", RegexOptions.IgnoreCase | RegexOptions.ECMAScript)]
    private static partial Regex Ordinal();
}
