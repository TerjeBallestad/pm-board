using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using PmBoard.Api.Data;

namespace PmBoard.Api.Boards;

/// <summary>pm-board-cli api/items.js, the write side, per board.</summary>
public static class ItemWrites
{
    private static readonly string[] PatchFields =
        ["title", "priority", "pillar", "stage", "body", "related", "affectedFiles", "blockedBy", "aliases", "sprintId", "assignee"];

    public static void MapItemWrites(this RouteGroupBuilder g)
    {
        g.MapPost("/items/archive/sweep", (string slug, HttpRequest req, BoardDb db) => Write.Run(req, db, slug, Sweep));
        g.MapPost("/items/archive", (string slug, HttpRequest req, BoardDb db) => Write.Run(req, db, slug, Archive));
        g.MapPost("/items", (string slug, HttpRequest req, BoardDb db) => Write.Run(req, db, slug, Create));
        g.MapPatch("/items/{key}", (string slug, string key, HttpRequest req, BoardDb db) => Write.Run(req, db, slug, w => Patch(w, key)));
        g.MapDelete("/items/{key}", (string slug, string key, HttpRequest req, BoardDb db) => Write.Run(req, db, slug, w => Delete(w, key)));
        g.MapPost(
            "/items/{key}/comments",
            (string slug, string key, HttpRequest req, BoardDb db) => Write.Run(req, db, slug, w => w.Comment(RecordKind.Item, key, touch: true))
        );
        g.MapPost("/items/{key}/claim", (string slug, string key, HttpRequest req, BoardDb db) => Write.Run(req, db, slug, w => Claim(w, key)));
        g.MapPost("/items/{key}/release", (string slug, string key, HttpRequest req, BoardDb db) => Write.Run(req, db, slug, w => Release(w, key)));
    }

    private static async Task<IResult> Create(Write w)
    {
        var b = w.Body;
        if (!Js.Truthy(b["title"])) return Write.Error(400, "title required");
        var typePrefix = w.Cfg.TypePrefix();
        var type = b["type"];
        // An unknown type used to fall through to the first prefix in 0.x, and 0.x fixed that: so does 1.x.
        if (Js.Truthy(type) && !typePrefix.ContainsKey(Js.Str(type)))
        {
            return Write.Error(
                400,
                $"Unknown type \"{Js.Str(type)}\". Configured types: {string.Join(", ", typePrefix.Keys.Order(StringComparer.Ordinal))}"
            );
        }
        // 0.x falls back to the first entityTypes key. The defaults come first in 0.x's merge, so that
        // is SB on every board (jsonb keeps no key order to read it from).
        var prefix = Js.Truthy(type) ? typePrefix[Js.Str(type)] : w.Cfg.EntityTypes.ContainsKey("SB") ? "SB" : w.Cfg.EntityTypes.First().Key;
        var (key, _) = await w.NextKey(prefix);
        var stages = w.Cfg.Stages;
        var stage = b["stage"]?.GetValueKind() == JsonValueKind.String && stages.Contains((string)b["stage"]!) ? (string)b["stage"]! : stages.FirstOrDefault();

        var r = Write.NewRecord(w.Board, RecordKind.Item, key);
        r.Type = Js.Truthy(type) ? Js.Text(type) : "issue";
        r.Title = Js.Text(b["title"])!;
        r.Stage = stage;
        r.Priority = Js.Truthy(b["priority"]) ? Js.Text(b["priority"]) : null;
        r.Body = Js.Truthy(b["body"]) ? Js.Text(b["body"]) : "";
        r.SprintKey = Js.Truthy(b["sprintId"]) ? Js.Text(b["sprintId"]) : null;
        r.CreatedAt = w.Now;
        r.UpdatedAt = w.Now;
        var fields = new JsonObject
        {
            ["pillar"] = Js.Truthy(b["pillar"]) ? b["pillar"]!.DeepClone() : "",
            ["related"] = Js.Truthy(b["related"]) ? b["related"]!.DeepClone() : new JsonArray(),
            ["affectedFiles"] = Js.Truthy(b["affectedFiles"]) ? b["affectedFiles"]!.DeepClone() : new JsonArray(),
            // Glossary terms only: explicit inflections that link to this term.
            ["aliases"] = Js.Truthy(b["aliases"]) ? b["aliases"]!.DeepClone() : new JsonArray(),
        };
        Write.SetBlockedBy(r, fields, Js.Truthy(b["blockedBy"]) ? b["blockedBy"] : new JsonArray());
        Write.SetFields(r, fields);
        w.Db.Records.Add(r);

        var o = await w.Shape(r);
        o["body"] = r.Body; // 0.x answers with the record it holds in memory, body "" included
        return Write.Json(o, 201);
    }

    private static async Task<IResult> Patch(Write w, string key)
    {
        var r = await w.Lock(RecordKind.Item, key);
        if (r is null) return ReadRoutes.NotFound();
        var b = w.Body;
        if (w.Unknown("an item", PatchFields) is { } unknown) return unknown;
        foreach (var name in new[] { "related", "affectedFiles", "blockedBy", "aliases" }) Js.CoerceArray(b, name);
        var stages = w.Cfg.Stages;
        if (Js.Truthy(b["stage"]) && !(b["stage"]!.GetValueKind() == JsonValueKind.String && stages.Contains((string)b["stage"]!)))
        {
            return Write.Error(400, $"Invalid stage. Must be one of: {string.Join(", ", stages)}");
        }

        var fields = Write.Fields(r);
        if (Js.Has(b, "title")) r.Title = Js.Text(b["title"]) ?? "";
        if (Js.Has(b, "priority")) r.Priority = Js.Text(b["priority"]);
        if (Js.Has(b, "stage")) r.Stage = Js.Text(b["stage"]);
        if (Js.Has(b, "body")) r.Body = Js.Text(b["body"]);
        if (Js.Has(b, "sprintId")) r.SprintKey = Js.Text(b["sprintId"]);
        if (Js.Has(b, "blockedBy")) Write.SetBlockedBy(r, fields, b["blockedBy"]);
        foreach (var name in new[] { "pillar", "related", "affectedFiles", "aliases" })
        {
            if (Js.Has(b, name)) fields[name] = b[name]?.DeepClone();
        }
        if (Js.Has(b, "assignee"))
        {
            // Patch is the force path: no conflict check (that is POST :id/claim).
            r.Assignee = Js.Truthy(b["assignee"]) ? Js.Text(b["assignee"]) : null;
            r.AssignedAt = r.Assignee is null ? null : w.Now;
        }
        if (b["stage"]?.GetValueKind() == JsonValueKind.String && (string)b["stage"]! == "done")
        {
            r.DoneAt ??= w.Now;
            // Closing a ticket releases its claim.
            r.Assignee = null;
            r.AssignedAt = null;
        }
        r.UpdatedAt = w.Now;
        Write.SetFields(r, fields);

        var o = await w.Shape(r);
        if (Js.Has(b, "body")) o["body"] = b["body"]?.DeepClone();
        return Write.Json(o);
    }

    private static async Task<IResult> Delete(Write w, string key)
    {
        var r = await w.Lock(RecordKind.Item, key);
        if (r is null) return ReadRoutes.NotFound();
        await w.Delete(r);
        return Results.StatusCode(204);
    }

    private static async Task<IResult> Claim(Write w, string key)
    {
        var r = await w.Lock(RecordKind.Item, key);
        if (r is null) return ReadRoutes.NotFound();
        var assignee = w.Body["assignee"];
        if (!Js.Truthy(assignee)) return Write.Error(400, "assignee required");
        if (r.Stage == "done") return Write.Error(409, $"{r.Key} is already done");
        // Refuse when someone else holds a live claim. Your own claim is refreshed; an expired one is free.
        if (w.Cfg.ClaimLive(r, w.Now) && r.Assignee != Js.Text(assignee))
        {
            var at = V0Json.Time(r.AssignedAt!.Value);
            return Write.Json(
                new JsonObject
                {
                    ["error"] = $"{r.Key} is claimed by \"{r.Assignee}\" since {at} — pick another frontier ticket (pm patch --assignee to override)",
                    ["assignee"] = r.Assignee,
                    ["assignedAt"] = at,
                },
                409
            );
        }
        r.Assignee = Js.Text(assignee);
        r.AssignedAt = w.Now;
        r.UpdatedAt = w.Now;
        return Write.Json(await w.Shape(r));
    }

    private static async Task<IResult> Release(Write w, string key)
    {
        var r = await w.Lock(RecordKind.Item, key);
        if (r is null) return ReadRoutes.NotFound();
        r.Assignee = null;
        r.AssignedAt = null;
        r.UpdatedAt = w.Now;
        return Write.Json(await w.Shape(r));
    }

    private static async Task<IResult> Archive(Write w)
    {
        if (w.Body["ids"] is not JsonArray ids) return Write.Error(400, "ids array required");
        var moved = await ArchiveKeys(w, ids.Select(x => x?.GetValueKind() == JsonValueKind.String ? (string)x! : null).OfType<string>());
        return Write.Json(Moved(moved));
    }

    private static async Task<IResult> Sweep(Write w)
    {
        var d = w.Body["days"];
        var days = d is null ? 1
            : d.GetValueKind() == JsonValueKind.Number ? Js.Num(d)
            : d.GetValueKind() == JsonValueKind.String && double.TryParse((string)d!, NumberStyles.Float, CultureInfo.InvariantCulture, out var n) ? n
            : double.NaN;
        var nonSweep = w.Cfg.NonSweep();
        var done = await ReadRoutes.Live(w.Db, w.Board, RecordKind.Item).Where(r => r.Stage == "done").ToListAsync();
        // Types with sweep: false are permanent records: decisions and terms outlive the work.
        var cutoff = w.Now.ToUnixTimeMilliseconds() - days * 24 * 60 * 60 * 1000;
        var eligible = done
            .Where(r => r.Type is null || !nonSweep.Contains(r.Type))
            .Where(r => (r.DoneAt ?? r.UpdatedAt ?? r.CreatedAt) is { } at && at.ToUnixTimeMilliseconds() < cutoff)
            .Select(r => r.Key)
            .Order(StringComparer.Ordinal);
        return Write.Json(Moved(await ArchiveKeys(w, eligible)));
    }

    /// <summary>store.archiveItems: live items only; an id that is not one is passed over.</summary>
    private static async Task<List<string>> ArchiveKeys(Write w, IEnumerable<string> keys)
    {
        var moved = new List<string>();
        foreach (var key in keys)
        {
            if (moved.Contains(key)) continue;
            var r = await w.Lock(RecordKind.Item, key);
            if (r is null) continue;
            r.ArchivedAt = w.Now;
            // 0.x reads a decision's sidecar tests only while it is on the board.
            var fields = Write.Fields(r);
            if (fields.Remove("tests")) Write.SetFields(r, fields);
            moved.Add(key);
        }
        return moved;
    }

    private static JsonObject Moved(List<string> moved) =>
        new() { ["archived"] = moved.Count, ["ids"] = new JsonArray(moved.Select(k => (JsonNode)k).ToArray()) };
}
