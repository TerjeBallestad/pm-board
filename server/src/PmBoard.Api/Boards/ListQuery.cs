using System.Text.Json.Nodes;
using PmBoard.Api.Data;

namespace PmBoard.Api.Boards;

/// <summary>
/// The optional query of the list routes (items, designs, plans, sprints), so `pm list` downloads
/// only the rows it prints (DD-029). Without it a list answers as 0.x did.
///
/// - sort=updatedAt: oldest to newest by updatedAt, or createdAt where a record has none, as the
///   CLI's printList sorts: the JSON's strings, compared as JavaScript compares them. Ties keep key order.
/// - limit=N, with sort: the newest N. The header X-Total-Count says how many rows matched before the cut.
/// - fields=a,b: only those keys of each record.
/// </summary>
public sealed record ListQuery(bool Sort, int? Limit, string[]? Fields, IResult? Refusal)
{
    public const string TotalHeader = "X-Total-Count";

    public static ListQuery Parse(string? sort, string? limit, string? fields)
    {
        if (sort is not null && sort != "updatedAt")
        {
            return Refused("sort must be updatedAt");
        }
        int? n = null;
        if (limit is not null)
        {
            if (!int.TryParse(limit, System.Globalization.NumberStyles.None, null, out var v) || v < 1)
            {
                return Refused("limit must be a whole number above 0");
            }
            if (sort is null)
            {
                return Refused("limit needs sort=updatedAt: it keeps the newest rows");
            }
            n = v;
        }
        var keys = fields?.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        return new ListQuery(sort is not null, n, keys, null);
    }

    private static ListQuery Refused(string message) => new(false, null, null, Write.Error(400, message));

    /// <summary>The rows (in key order) sorted, cut and shaped as the query asks.</summary>
    public async Task<IResult> Answer(BoardDb db, HttpResponse res, List<Record> rows)
    {
        if (Sort)
        {
            // OrderBy is stable, as JavaScript's sort is, so ties stay in key order.
            rows = rows.OrderBy(SortKey, StringComparer.Ordinal).ToList();
        }
        if (Limit is { } n)
        {
            res.Headers[TotalHeader] = rows.Count.ToString(System.Globalization.CultureInfo.InvariantCulture);
            if (rows.Count > n) rows = rows[^n..];
        }
        var shaped = await ReadRoutes.Shape(db, rows);
        if (Fields is { } keys)
        {
            foreach (var o in shaped.Select(x => x!.AsObject()))
            {
                foreach (var k in o.Select(kv => kv.Key).Where(k => !keys.Contains(k)).ToList()) o.Remove(k);
            }
        }
        return Results.Json(shaped);
    }

    /// <summary>
    /// printList's <c>it.updatedAt || it.createdAt || ''</c>, read from the record's JSON: a time that
    /// did not parse on import is there as its own text (V0Json).
    /// </summary>
    private static string SortKey(Record r)
    {
        var o = V0Json.Record(r, []);
        var at = Js.Truthy(o["updatedAt"]) ? o["updatedAt"] : o["createdAt"];
        return Js.Truthy(at) ? Js.Str(at) : "";
    }
}
