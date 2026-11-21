using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using PmBoard.Api.Data;
using PmBoard.Api.Keys;

namespace PmBoard.Api.Boards;

/// <summary>
/// One write request: the board, its config, the JSON body, one time for the whole request, and one
/// transaction. Records it changes are locked with FOR UPDATE first, so two writers to one record
/// take turns, the way 0.x's single thread made them.
/// </summary>
public sealed class Write(BoardDb db, Board board, BoardConfig cfg, JsonObject body, DateTimeOffset now)
{
    public BoardDb Db { get; } = db;
    public Board Board { get; } = board;
    public BoardConfig Cfg { get; } = cfg;
    public JsonObject Body { get; } = body;

    /// <summary>The request's time, to the millisecond, as 0.x wrote it.</summary>
    public DateTimeOffset Now { get; } = now;

    /// <summary>The token's user (DD-003). Null only on a route that needs no token.</summary>
    public string? UserName { get; init; }

    /// <summary>
    /// Runs a write in a transaction. A result below 400 commits; anything else rolls back, so a
    /// refused request changes nothing and gives its key numbers back.
    /// </summary>
    public static async Task<IResult> Run(HttpRequest req, BoardDb db, string slug, Func<Write, Task<IResult>> work)
    {
        JsonObject body;
        try
        {
            body = await ReadBody(req);
        }
        catch (JsonException)
        {
            return Error(400, "the body is not a JSON object");
        }

        await using var tx = await db.Database.BeginTransactionAsync();
        var board = await db.Boards.AsNoTracking().SingleOrDefaultAsync(b => b.Slug == slug);
        if (board is null) return ReadRoutes.NotFound();

        var now = DateTimeOffset.FromUnixTimeMilliseconds(DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
        var result = await work(new Write(db, board, new BoardConfig(board), body, now) { UserName = req.HttpContext.User.Identity?.Name });
        if (result is IStatusCodeHttpResult { StatusCode: < 400 })
        {
            await db.SaveChangesAsync();
            await tx.CommitAsync();
        }
        return result;
    }

    /// <summary>An empty body is {}, as the 0.x dispatcher passed it.</summary>
    private static async Task<JsonObject> ReadBody(HttpRequest req)
    {
        using var reader = new StreamReader(req.Body);
        var text = await reader.ReadToEndAsync();
        if (string.IsNullOrWhiteSpace(text)) return [];
        return JsonNode.Parse(text) as JsonObject ?? throw new JsonException("not an object");
    }

    public static IResult Error(int status, string message) =>
        Results.Json(new JsonObject { ["error"] = message }, statusCode: status);

    public static IResult Json(JsonNode node, int status = 200) => Results.Json(node, statusCode: status);

    /// <summary>
    /// 1.x refuses a field that the route does not change (DD-016). 0.x dropped it silently, so a
    /// typo in a flag name changed nothing and said nothing.
    /// </summary>
    public IResult? Unknown(string what, params string[] allowed)
    {
        var unknown = Body.Select(kv => kv.Key).Where(k => !allowed.Contains(k)).ToList();
        if (unknown.Count == 0) return null;
        var names = string.Join(", ", unknown.Select(k => $"\"{k}\""));
        return Error(400, $"Unknown field{(unknown.Count > 1 ? "s" : "")} {names} for {what}. Allowed: {string.Join(", ", allowed)}");
    }

    /// <summary>A live record of this board, locked until the transaction ends. Null when there is none.</summary>
    public async Task<Record?> Lock(string kind, string key) =>
        (
            await Db.Records.FromSql(
                    $"SELECT * FROM records WHERE board_id = {Board.Id} AND kind = {kind} AND key = {key} AND archived_at IS NULL FOR UPDATE"
                )
                .AsAsyncEnumerable()
                .ToListAsync()
        ).SingleOrDefault();

    /// <summary>A plan's tasks in plan order, locked. Lock the plan first.</summary>
    public async Task<List<Record>> LockTasks(Record plan) =>
        await Db.Records.FromSql($"SELECT * FROM records WHERE parent_id = {plan.Id} ORDER BY position FOR UPDATE")
            .AsAsyncEnumerable()
            .ToListAsync();

    public Task<(string Key, int Number)> NextKey(string prefix) => KeyAllocator.NextAsync(Db, Board.Id, prefix);

    /// <summary>Writes pending changes, so the response can be read back from the database.</summary>
    public Task Save() => Db.SaveChangesAsync();

    /// <summary>The record's 0.x JSON, as the read routes give it.</summary>
    public async Task<JsonObject> Shape(Record r)
    {
        await Save();
        return (await ReadRoutes.Shape(Db, [r]))[0]!.AsObject();
    }

    /// <summary>
    /// Appends a comment or progress note as a new row, after the record's last one (DD-014). The
    /// record is locked, so no other writer takes the same position.
    /// </summary>
    public async Task<Comment> AddComment(Record r, string kind, string? author, string text, DateTimeOffset? at = null)
    {
        var last = await Db.Comments.Where(c => c.RecordId == r.Id).MaxAsync(c => (int?)c.Position);
        var pending = Db.ChangeTracker.Entries<Comment>()
            .Where(e => e.State == EntityState.Added && e.Entity.RecordId == r.Id)
            .Select(e => (int?)e.Entity.Position)
            .Max();
        var c = new Comment
        {
            Id = Guid.CreateVersion7(),
            RecordId = r.Id,
            Position = Math.Max(last ?? -1, pending ?? -1) + 1,
            Kind = kind,
            LegacyId = kind == CommentKind.Comment ? "c" + Now.ToUnixTimeMilliseconds().ToString(CultureInfo.InvariantCulture) : null,
            Author = author,
            Text = text,
            CreatedAt = at ?? Now,
        };
        Db.Comments.Add(c);
        return c;
    }

    /// <summary>Deletes a record with its comments (0.x deleted the file).</summary>
    public async Task Delete(Record r)
    {
        await Db.Comments.Where(c => c.RecordId == r.Id).ExecuteDeleteAsync();
        Db.Records.Remove(r);
    }

    /// <summary>POST :id/comments for items, designs, plans and sprints.</summary>
    public async Task<IResult> Comment(string kind, string key, bool touch)
    {
        var r = await Lock(kind, key);
        if (r is null) return ReadRoutes.NotFound();
        if (!Js.Truthy(Body["text"])) return Error(400, "text required");
        // With no author, the token's user, where 0.x wrote "user" (DD-020).
        var author = Js.Truthy(Body["author"]) ? Js.Text(Body["author"]) : UserName ?? "user";
        var c = await AddComment(r, CommentKind.Comment, author, Js.Text(Body["text"])!);
        // 0.x sets updatedAt on every record but a sprint, which has none.
        if (touch) r.UpdatedAt = Now;
        await Save();
        return Json(V0Json.Comment(c), 201);
    }

    public static JsonObject Fields(Record r) => JsonNode.Parse(r.Fields.RootElement.GetRawText())!.AsObject();

    public static void SetFields(Record r, JsonObject fields) => r.Fields = JsonDocument.Parse(fields.ToJsonString());

    /// <summary>
    /// blockedBy as the column holds it: keys as text. An array of anything but strings, or a value
    /// that is not an array, is kept as it was in fields too, and the API returns that (as the
    /// importer does).
    /// </summary>
    public static void SetBlockedBy(Record r, JsonObject fields, JsonNode? value)
    {
        if (value is JsonArray a && a.All(x => x?.GetValueKind() == JsonValueKind.String))
        {
            r.BlockedBy = a.Select(x => (string)x!).ToList();
            fields.Remove("blockedBy");
        }
        else
        {
            r.BlockedBy = Js.Strings(value).Where(x => x != "").ToList();
            fields["blockedBy"] = value?.DeepClone();
        }
    }

    public static Record NewRecord(Board board, string kind, string key) =>
        new()
        {
            Id = Guid.CreateVersion7(),
            BoardId = board.Id,
            Key = key,
            Prefix = KeyAllocator.Parse(key).Prefix,
            Number = KeyAllocator.Parse(key).Number,
            Kind = kind,
        };
}
