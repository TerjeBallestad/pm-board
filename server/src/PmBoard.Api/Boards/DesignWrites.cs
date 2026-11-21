using System.Text.Json;
using System.Text.Json.Nodes;
using PmBoard.Api.Data;

namespace PmBoard.Api.Boards;

/// <summary>pm-board-cli api/designs.js, the write side, per board.</summary>
public static class DesignWrites
{
    public static void MapDesignWrites(this RouteGroupBuilder g)
    {
        g.MapPost("/designs", (string slug, HttpRequest req, BoardDb db) => Write.Run(req, db, slug, Create));
        g.MapPatch("/designs/{key}", (string slug, string key, HttpRequest req, BoardDb db) => Write.Run(req, db, slug, w => Patch(w, key)));
        g.MapPost(
            "/designs/{key}/comments",
            (string slug, string key, HttpRequest req, BoardDb db) => Write.Run(req, db, slug, w => w.Comment(RecordKind.Design, key, touch: true))
        );
    }

    private static async Task<IResult> Create(Write w)
    {
        var b = w.Body;
        if (!Js.Truthy(b["title"])) return Write.Error(400, "title required");
        var (key, _) = await w.NextKey("SDD");
        var r = Write.NewRecord(w.Board, RecordKind.Design, key);
        r.Title = Js.Text(b["title"])!;
        r.Body = Js.Truthy(b["body"]) ? Js.Text(b["body"]) : "";
        r.Stage = "sdd";
        r.SprintKey = Js.Truthy(b["sprintId"]) ? Js.Text(b["sprintId"]) : null;
        r.CreatedAt = w.Now;
        r.UpdatedAt = w.Now;
        var itemIds = Js.Truthy(b["itemIds"]) ? b["itemIds"]!.DeepClone() : new JsonArray();
        Write.SetFields(r, new JsonObject { ["itemIds"] = itemIds });

        // Linked items that are not done move to the sdd stage.
        foreach (var itemKey in (itemIds as JsonArray ?? []).Where(x => x?.GetValueKind() == JsonValueKind.String).Select(x => (string)x!))
        {
            var item = await w.Lock(RecordKind.Item, itemKey);
            if (item is not null && item.Stage != "done")
            {
                item.Stage = "sdd";
                item.UpdatedAt = w.Now;
            }
        }
        w.Db.Records.Add(r);

        var o = await w.Shape(r);
        o["body"] = r.Body;
        return Write.Json(o, 201);
    }

    private static async Task<IResult> Patch(Write w, string key)
    {
        var r = await w.Lock(RecordKind.Design, key);
        if (r is null) return ReadRoutes.NotFound();
        var b = w.Body;
        if (w.Unknown("a design", "title", "body", "itemIds", "stage", "sprintId") is { } unknown) return unknown;
        Js.CoerceArray(b, "itemIds");
        if (Js.Has(b, "title")) r.Title = Js.Text(b["title"]) ?? "";
        if (Js.Has(b, "body")) r.Body = Js.Text(b["body"]);
        if (Js.Has(b, "stage")) r.Stage = Js.Text(b["stage"]);
        if (Js.Has(b, "sprintId")) r.SprintKey = Js.Text(b["sprintId"]);
        if (Js.Has(b, "itemIds"))
        {
            var fields = Write.Fields(r);
            fields["itemIds"] = b["itemIds"]?.DeepClone();
            Write.SetFields(r, fields);
        }
        r.UpdatedAt = w.Now;

        var o = await w.Shape(r);
        if (Js.Has(b, "body")) o["body"] = b["body"]?.DeepClone();
        return Write.Json(o);
    }
}
