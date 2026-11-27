using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Microsoft.EntityFrameworkCore;
using PmBoard.Api.Data;

namespace PmBoard.Api.Boards;

/// <summary>
/// POST /api/boards: `pm init &lt;slug&gt;` makes a new, empty board (DD-021). 0.x wrote a
/// pm.config.json from its defaults/pm.config.json; the new board gets the same config, without the
/// parts that only a local server used (port, dataDir, frontend).
/// PATCH /api/boards/{slug}: `pm board-rename` gives a board a new slug, a new name or both (DD-035).
/// 0.x had no rename: a 0.x board's slug was its folder.
/// </summary>
public static partial class BoardWrites
{
    /// <summary>The board part of 0.x's defaults/pm.config.json, as 0.5.5 ships it.</summary>
    private const string DefaultConfig = """
        {
          "stages": ["inbox", "exploring", "sdd", "planned", "done"],
          "entityTypes": {
            "SB":    { "label": "Issue",    "color": "#66d9ef" },
            "DD":    { "label": "Decision", "color": "#ae81ff", "sweep": false },
            "DC":    { "label": "Concern",  "color": "#e6db74" },
            "GAP":   { "label": "Gap",      "color": "#f92672" },
            "TERM":  { "label": "Term",     "color": "#a6e22e", "frontier": false, "sweep": false },
            "SDD":   { "label": "Design" },
            "PLAN":  { "label": "Plan" },
            "SPRINT": { "label": "Sprint" },
            "TASK":  { "label": "Task" },
            "MILESTONE": { "label": "Milestone" }
          },
          "commands": {
            "ticket": { "default": "Work the PM ticket {id}: {title}" },
            "sdd": "Work the PM design doc {id}: {title}",
            "plan": "Execute PM plan {id}",
            "project": "Work the frontier of PM project {id}"
          },
          "knowledgeBase": { "command": "qmd query", "scope": null },
          "templates": null
        }
        """;

    /// <summary>
    /// The first path part of every route that is not a board. A board with one of these slugs
    /// could never open at /&lt;slug&gt;.
    /// </summary>
    private static readonly HashSet<string> Reserved = ["api", "attachments", "assets", "index.html"];

    [GeneratedRegex("^[a-z0-9][a-z0-9-]{0,62}$")]
    private static partial Regex SlugPattern();

    private const string SlugRule = "slug must be 1 to 63 lowercase letters, digits and dashes, start with a letter or digit, and not be api, attachments or assets";

    /// <summary>
    /// A board's slug and the aliases are in two tables, so no unique index keeps a slug in one
    /// of them only. Every write that takes a slug holds this lock until it commits, so two such
    /// writes take turns.
    /// </summary>
    private const long SlugLock = 0x706d_736c_7567; // "pmslug"

    public static void MapBoardWrites(this WebApplication app)
    {
        app.MapPost("/api/boards", Create);
        app.MapPatch("/api/boards/{slug}", Rename);
    }

    private static bool ValidSlug(string? slug) => slug is not null && SlugPattern().IsMatch(slug) && !Reserved.Contains(slug);

    private static Task LockSlugs(BoardDb db) => db.Database.ExecuteSqlRawAsync($"SELECT pg_advisory_xact_lock({SlugLock})");

    /// <summary>Why <paramref name="slug"/> cannot be the slug of board <paramref name="self"/>, or null.</summary>
    private static async Task<IResult?> Taken(BoardDb db, string slug, Guid? self)
    {
        if (await db.Boards.AnyAsync(b => b.Slug == slug && b.Id != self))
        {
            return Write.Error(409, $"board {slug} already exists");
        }
        var owner = await db.BoardAliases.Where(a => a.Slug == slug && a.BoardId != self)
            .Join(db.Boards, a => a.BoardId, b => b.Id, (a, b) => b.Slug)
            .SingleOrDefaultAsync();
        return owner is null ? null : Write.Error(409, $"{slug} is an old slug of board {owner}, and it still leads there");
    }

    private static async Task<JsonObject?> ReadObject(HttpRequest req)
    {
        try
        {
            return JsonNode.Parse(await new StreamReader(req.Body).ReadToEndAsync()) as JsonObject;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    /// <summary>
    /// Renames a board. A new slug leaves the old one as an alias, so links and .pm.json files that
    /// name it keep working. A slug that is one of the board's own aliases moves back: that alias
    /// goes. A slug that another board has, as its slug or an alias, is 409. Keys, bodies and links
    /// inside the board do not change.
    /// </summary>
    private static async Task<IResult> Rename(string slug, HttpRequest req, HttpResponse res, BoardDb db)
    {
        if (await ReadObject(req) is not { } body) return Write.Error(400, "the body is not a JSON object");
        var unknown = body.Select(kv => kv.Key).Where(k => k is not ("slug" or "name")).ToList();
        if (unknown.Count > 0)
        {
            return Write.Error(400, $"unknown field {string.Join(", ", unknown.Select(k => $"\"{k}\""))}; a rename takes slug and name");
        }
        if (body.Count == 0) return Write.Error(400, "a rename takes slug, name or both");

        string? newSlug = null;
        if (body.ContainsKey("slug"))
        {
            newSlug = body["slug"] is JsonValue s && s.GetValueKind() == JsonValueKind.String ? (string)s! : null;
            if (!ValidSlug(newSlug)) return Write.Error(400, SlugRule);
        }
        string? newName = null;
        if (body.ContainsKey("name"))
        {
            newName = body["name"] is JsonValue n && n.GetValueKind() == JsonValueKind.String ? ((string)n!).Trim() : "";
            if (newName.Length == 0) return Write.Error(400, "name must be text that is not blank");
        }

        await using var tx = await db.Database.BeginTransactionAsync();
        await LockSlugs(db);
        var board = await db.Boards.SingleOrDefaultAsync(b => b.Slug == slug);
        if (board is null) return ReadRoutes.NotFound();

        if (newSlug is not null && newSlug != board.Slug)
        {
            if (await Taken(db, newSlug, board.Id) is { } taken) return taken;
            // Back to one of its own old slugs: that alias moves to the slug it leaves.
            await db.BoardAliases.Where(a => a.Slug == newSlug).ExecuteDeleteAsync();
            db.BoardAliases.Add(new BoardAlias { Slug = board.Slug, BoardId = board.Id, CreatedAt = DateTimeOffset.UtcNow });
            board.Slug = newSlug;
        }
        if (newName is not null) board.Name = newName;
        await db.SaveChangesAsync();
        await tx.CommitAsync();

        // A rename through an alias: the header names the slug as it is now.
        if (res.Headers.ContainsKey(BoardAliases.Header)) res.Headers[BoardAliases.Header] = board.Slug;
        var aliases = await db.BoardAliases.Where(a => a.BoardId == board.Id).OrderBy(a => a.Slug).Select(a => a.Slug).ToListAsync();
        return Results.Json(
            new JsonObject
            {
                ["slug"] = board.Slug,
                ["name"] = board.Name,
                ["aliases"] = new JsonArray(aliases.Select(a => (JsonNode)JsonValue.Create(a)).ToArray()),
            }
        );
    }

    private static async Task<IResult> Create(HttpRequest req, BoardDb db)
    {
        if (await ReadObject(req) is not { } body) return Write.Error(400, "the body is not a JSON object");

        var unknown = body.Select(kv => kv.Key).Where(k => k is not ("slug" or "name")).ToList();
        if (unknown.Count > 0)
        {
            return Write.Error(400, $"unknown field {string.Join(", ", unknown.Select(k => $"\"{k}\""))}; a board takes slug and name");
        }
        var slug = body["slug"] is JsonValue s && s.GetValueKind() == JsonValueKind.String ? (string)s! : null;
        if (!ValidSlug(slug)) return Write.Error(400, SlugRule);
        var name = body["name"] is JsonValue n && n.GetValueKind() == JsonValueKind.String && ((string)n!).Trim() is { Length: > 0 } t ? t : slug!;

        await using var tx = await db.Database.BeginTransactionAsync();
        await LockSlugs(db);
        // An alias is never a second board (DD-035).
        if (await Taken(db, slug!, null) is { } taken) return taken;
        var board = new Board
        {
            Id = Guid.NewGuid(),
            Slug = slug!,
            Name = name,
            Config = JsonDocument.Parse(DefaultConfig),
            CreatedAt = DateTimeOffset.UtcNow,
        };
        db.Boards.Add(board);
        try
        {
            await db.SaveChangesAsync();
            await tx.CommitAsync();
        }
        catch (DbUpdateException)
        {
            // Two inits of one slug at once: the unique index lets one win.
            return Write.Error(409, $"board {slug} already exists");
        }
        return Results.Json(new JsonObject { ["slug"] = slug, ["name"] = name }, statusCode: 201);
    }
}
