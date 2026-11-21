using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using PmBoard.Api.Data;

namespace PmBoard.Api.Boards;

/// <summary>
/// The read side of the 0.x API, per board: /api/boards/{slug}/items is 0.x's /api/items for that
/// board, with the same filters and the same JSON (V0Json).
/// </summary>
public static class ReadRoutes
{
    public static void MapReadRoutes(this WebApplication app)
    {
        app.MapGet(
            "/api/boards",
            async (BoardDb db) =>
                await db.Boards.OrderBy(p => p.Slug).Select(p => new { slug = p.Slug, name = p.Name }).ToListAsync()
        );

        var g = app.MapGroup("/api/boards/{slug}");

        g.MapGet(
            "/config",
            async (string slug, BoardDb db) =>
                await Board(db, slug) is { } p ? Results.Json(Config(p)) : NotFound()
        );

        g.MapGet(
            "/items",
            async (string slug, BoardDb db, string? type, string? stage, string? priority, string? sprintId, string? frontier, string? allClaims) =>
            {
                if (await Board(db, slug) is not { } p) return NotFound();
                var q = Live(db, p, RecordKind.Item);
                if (type is not null) q = q.Where(r => r.Type == type);
                if (stage is not null) q = q.Where(r => r.Stage == stage);
                if (priority is not null) q = q.Where(r => r.Priority == priority);
                if (sprintId is not null) q = q.Where(r => r.SprintKey == sprintId);
                var items = await q.OrderBy(r => r.Key).ToListAsync();
                if (frontier == "true")
                {
                    items = Frontier(p, items, await Live(db, p, RecordKind.Item).ToListAsync(), allClaims == "true");
                }
                return Results.Json(await Shape(db, items));
            }
        );

        g.MapGet(
            "/items/archived",
            async (string slug, BoardDb db, string? type) =>
            {
                if (await Board(db, slug) is not { } p) return NotFound();
                var q = db.Records.Where(r => r.BoardId == p.Id && r.Kind == RecordKind.Item && r.ArchivedAt != null);
                if (type is not null) q = q.Where(r => r.Type == type);
                return Results.Json(await Shape(db, await q.OrderBy(r => r.Key).ToListAsync()));
            }
        );

        g.MapGet("/items/{key}", (string slug, string key, BoardDb db) => One(db, slug, RecordKind.Item, key));

        g.MapGet(
            "/designs",
            async (string slug, BoardDb db, string? sprintId) =>
            {
                if (await Board(db, slug) is not { } p) return NotFound();
                var q = Live(db, p, RecordKind.Design);
                if (sprintId is not null) q = q.Where(r => r.SprintKey == sprintId);
                return Results.Json(await Shape(db, await q.OrderBy(r => r.Key).ToListAsync()));
            }
        );
        g.MapGet("/designs/{key}", (string slug, string key, BoardDb db) => One(db, slug, RecordKind.Design, key));

        g.MapGet(
            "/plans",
            async (string slug, BoardDb db, string? sprintId) =>
            {
                if (await Board(db, slug) is not { } p) return NotFound();
                var q = Live(db, p, RecordKind.Plan);
                if (sprintId is not null) q = q.Where(r => r.SprintKey == sprintId);
                return Results.Json(await Shape(db, await q.OrderBy(r => r.Key).ToListAsync()));
            }
        );
        g.MapGet("/plans/{key}", (string slug, string key, BoardDb db) => One(db, slug, RecordKind.Plan, key));

        g.MapGet(
            "/sprints",
            async (string slug, BoardDb db) =>
                await Board(db, slug) is { } p
                    ? Results.Json(await Shape(db, await Live(db, p, RecordKind.Sprint).OrderBy(r => r.Key).ToListAsync()))
                    : NotFound()
        );
        g.MapGet(
            "/sprints/{key}",
            async (string slug, string key, BoardDb db) =>
            {
                if (await Board(db, slug) is not { } p) return NotFound();
                var sprint = await Live(db, p, RecordKind.Sprint).SingleOrDefaultAsync(r => r.Key == key);
                if (sprint is null) return NotFound();
                var o = (await Shape(db, [sprint]))[0]!.AsObject();
                foreach (var (name, kind) in new[] { ("items", RecordKind.Item), ("designs", RecordKind.Design), ("plans", RecordKind.Plan) })
                {
                    var rs = await Live(db, p, kind).Where(r => r.SprintKey == key).OrderBy(r => r.Key).ToListAsync();
                    var shaped = await Shape(db, rs);
                    // 0.x embeds the raw records here, without the `tests` it merges in everywhere else.
                    foreach (var x in shaped) x!.AsObject().Remove("tests");
                    o[name] = shaped;
                }
                return Results.Json(o);
            }
        );

        g.MapGet(
            "/milestones",
            async (string slug, BoardDb db) =>
                await Board(db, slug) is { } p
                    ? Results.Json(await Shape(db, await Live(db, p, RecordKind.Milestone).OrderBy(r => r.Key).ToListAsync()))
                    : NotFound()
        );
        g.MapGet("/milestones/{key}", (string slug, string key, BoardDb db) => One(db, slug, RecordKind.Milestone, key));
    }

    private static IResult NotFound() => Results.Json(new { error = "Not found" }, statusCode: 404);

    private static Task<Board?> Board(BoardDb db, string slug) =>
        db.Boards.AsNoTracking().SingleOrDefaultAsync(p => p.Slug == slug);

    private static IQueryable<Record> Live(BoardDb db, Board p, string kind) =>
        db.Records.AsNoTracking().Where(r => r.BoardId == p.Id && r.Kind == kind && r.ArchivedAt == null);

    private static async Task<IResult> One(BoardDb db, string slug, string kind, string key)
    {
        if (await Board(db, slug) is not { } p) return NotFound();
        var r = await Live(db, p, kind).SingleOrDefaultAsync(x => x.Key == key);
        return r is null ? NotFound() : Results.Json((await Shape(db, [r]))[0]);
    }

    /// <summary>The 0.x JSON for each record, with its comments, and a plan's tasks in plan order.</summary>
    private static async Task<JsonArray> Shape(BoardDb db, List<Record> records)
    {
        var ids = records.Select(r => r.Id).ToList();
        var tasks = await db.Records.AsNoTracking()
            .Where(t => t.ParentId != null && ids.Contains(t.ParentId.Value))
            .OrderBy(t => t.Position)
            .ToListAsync();
        var all = ids.Concat(tasks.Select(t => t.Id)).ToList();
        var comments = (await db.Comments.AsNoTracking().Where(c => all.Contains(c.RecordId)).ToListAsync())
            .OrderBy(c => c.Position)
            .ThenBy(c => c.Seq)
            .ToLookup(c => c.RecordId);
        var tasksByPlan = tasks.ToLookup(t => t.ParentId!.Value);

        return new JsonArray(
            records
                .Select(r => (JsonNode)V0Json.Record(
                    r,
                    comments[r.Id].ToList(),
                    r.Kind == RecordKind.Plan ? tasksByPlan[r.Id].Select(t => (t, (IReadOnlyList<Comment>)comments[t.Id].ToList())).ToList() : null
                ))
                .ToArray()
        );
    }

    /// <summary>
    /// 0.x's ?frontier=true: not done, not a non-frontier type (entityTypes.*.frontier = false), not
    /// live-claimed unless allClaims, and no blocker that is an active item not yet done.
    /// </summary>
    private static List<Record> Frontier(Board p, List<Record> items, List<Record> active, bool allClaims)
    {
        var cfg = Config(p);
        var nonFrontier = new HashSet<string>();
        if (cfg["entityTypes"] is JsonObject types)
        {
            foreach (var (prefix, meta) in types)
            {
                if (meta?["frontier"]?.GetValueKind() == JsonValueKind.False)
                {
                    nonFrontier.Add(((string?)meta["label"] ?? prefix).ToLowerInvariant());
                }
            }
        }
        var ttl = cfg["claimTtlHours"]?.GetValue<double>() ?? 4;
        var byKey = active.ToDictionary(r => r.Key);
        var now = DateTimeOffset.UtcNow;

        bool ClaimLive(Record r) =>
            r.Assignee is not null && r.AssignedAt is { } at && (ttl <= 0 || now - at < TimeSpan.FromHours(ttl));

        return items
            .Where(r => r.Stage != "done")
            .Where(r => r.Type is null || !nonFrontier.Contains(r.Type))
            .Where(r => allClaims || !ClaimLive(r))
            .Where(r => !r.BlockedBy.Any(b => byKey.TryGetValue(b, out var blocker) && blocker.Stage != "done"))
            .ToList();
    }

    /// <summary>0.x's /api/config: name, stages, entityTypes, commands, with 0.x's defaults where missing.</summary>
    public static JsonObject Config(Board p)
    {
        var stored = JsonNode.Parse(p.Config.RootElement.GetRawText())!.AsObject();
        var o = new JsonObject
        {
            ["name"] = p.Name,
            ["stages"] = stored["stages"]?.DeepClone() ?? new JsonArray("inbox", "exploring", "sdd", "planned", "done"),
            ["entityTypes"] = stored["entityTypes"]?.DeepClone() ?? new JsonObject(),
            ["commands"] = stored["commands"]?.DeepClone() ?? new JsonObject(),
            ["claimTtlHours"] = stored["claimTtlHours"]?.DeepClone() ?? 4,
        };
        return o;
    }
}
