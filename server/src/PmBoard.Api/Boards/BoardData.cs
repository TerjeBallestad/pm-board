using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using PmBoard.Api.Data;

namespace PmBoard.Api.Boards;

/// <summary>
/// A board's live records as 0.x's store.get() held them: the 0.x JSON, without the sidecar `tests`
/// that only the read routes merge in, in file name order (0.x read each folder sorted). The routes
/// that build text from many records (explore, suggest, prompt, review) read this.
/// </summary>
public sealed class BoardData
{
    public required List<JsonObject> Items { get; init; }
    public required List<JsonObject> Designs { get; init; }
    public required List<JsonObject> Plans { get; init; }
    public required List<JsonObject> Sprints { get; init; }

    public static async Task<BoardData> Load(BoardDb db, Board board) =>
        new()
        {
            Items = await Kind(db, board, RecordKind.Item),
            Designs = await Kind(db, board, RecordKind.Design),
            Plans = await Kind(db, board, RecordKind.Plan),
            Sprints = await Kind(db, board, RecordKind.Sprint),
        };

    private static async Task<List<JsonObject>> Kind(BoardDb db, Board board, string kind)
    {
        var records = (await ReadRoutes.Live(db, board, kind).ToListAsync()).OrderBy(r => r.Key, StringComparer.Ordinal).ToList();
        var shaped = (await ReadRoutes.Shape(db, records)).Select(x => x!.AsObject()).ToList();
        foreach (var o in shaped) o.Remove("tests");
        return shaped;
    }
}
