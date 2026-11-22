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

    public static void MapBoardWrites(this WebApplication app)
    {
        app.MapPost("/api/boards", Create);
    }

    private static async Task<IResult> Create(HttpRequest req, BoardDb db)
    {
        JsonObject body;
        try
        {
            body = JsonNode.Parse(await new StreamReader(req.Body).ReadToEndAsync()) as JsonObject ?? throw new JsonException();
        }
        catch (JsonException)
        {
            return Write.Error(400, "the body is not a JSON object");
        }

        var unknown = body.Select(kv => kv.Key).Where(k => k is not ("slug" or "name")).ToList();
        if (unknown.Count > 0)
        {
            return Write.Error(400, $"unknown field {string.Join(", ", unknown.Select(k => $"\"{k}\""))}; a board takes slug and name");
        }
        var slug = body["slug"] is JsonValue s && s.GetValueKind() == JsonValueKind.String ? (string)s! : null;
        if (slug is null || !SlugPattern().IsMatch(slug) || Reserved.Contains(slug))
        {
            return Write.Error(400, "slug must be 1 to 63 lowercase letters, digits and dashes, start with a letter or digit, and not be api, attachments or assets");
        }
        var name = body["name"] is JsonValue n && n.GetValueKind() == JsonValueKind.String && ((string)n!).Trim() is { Length: > 0 } t ? t : slug;

        if (await db.Boards.AnyAsync(b => b.Slug == slug))
        {
            return Write.Error(409, $"board {slug} already exists");
        }
        var board = new Board
        {
            Id = Guid.NewGuid(),
            Slug = slug,
            Name = name,
            Config = JsonDocument.Parse(DefaultConfig),
            CreatedAt = DateTimeOffset.UtcNow,
        };
        db.Boards.Add(board);
        try
        {
            await db.SaveChangesAsync();
        }
        catch (DbUpdateException)
        {
            // Two inits of one slug at once: the unique index lets one win.
            return Write.Error(409, $"board {slug} already exists");
        }
        return Results.Json(new JsonObject { ["slug"] = slug, ["name"] = name }, statusCode: 201);
    }
}
