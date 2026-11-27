using Microsoft.EntityFrameworkCore;
using PmBoard.Api.Data;

namespace PmBoard.Api.Boards;

/// <summary>
/// The old slugs of renamed boards (DD-035), in the one place where a request names a board: its
/// path. This middleware runs before routing. A path under /api/boards/&lt;alias&gt; is rewritten to
/// the board's slug, so every read and write route acts on the board, and the answer names the
/// slug in <see cref="Header"/>. A dashboard path /&lt;alias&gt;/... redirects to /&lt;slug&gt;/....
/// </summary>
public static class BoardAliases
{
    /// <summary>Set only on an answer to a request that named an alias: the board's slug now.</summary>
    public const string Header = "X-Pm-Board";

    private const string ApiPrefix = "/api/boards/";

    /// <summary>First path parts that are never a board, so they need no lookup.</summary>
    private static readonly HashSet<string> NotBoards = ["api", "attachments", "assets", "index.html"];

    public static void UseBoardAliases(this WebApplication app)
    {
        app.Use(
            async (ctx, next) =>
            {
                var path = ctx.Request.Path.Value ?? "";
                if (path.StartsWith(ApiPrefix, StringComparison.Ordinal))
                {
                    var (first, rest) = Split(path[ApiPrefix.Length..]);
                    if (first.Length > 0 && await SlugOf(ctx, first) is { } slug)
                    {
                        ctx.Request.Path = ApiPrefix + slug + rest;
                        ctx.Response.Headers[Header] = slug;
                    }
                }
                else if (HttpMethods.IsGet(ctx.Request.Method) || HttpMethods.IsHead(ctx.Request.Method))
                {
                    var (first, rest) = Split(path.TrimStart('/'));
                    // A board slug has no dot, so a file such as /favicon.svg needs no lookup.
                    if (first.Length > 0 && !first.Contains('.') && !NotBoards.Contains(first) && await SlugOf(ctx, first) is { } slug)
                    {
                        // 302, not 301: a later rename can move the alias, so no browser may keep it.
                        ctx.Response.Redirect("/" + slug + rest + ctx.Request.QueryString);
                        return;
                    }
                }
                await next();
            }
        );
    }

    /// <summary>"makron/items/SB-001" is ("makron", "/items/SB-001").</summary>
    private static (string First, string Tail) Split(string path)
    {
        var i = path.IndexOf('/');
        return i < 0 ? (path, "") : (path[..i], path[i..]);
    }

    /// <summary>The slug of the board that <paramref name="alias"/> is an alias of, or null.</summary>
    private static Task<string?> SlugOf(HttpContext ctx, string alias)
    {
        var db = ctx.RequestServices.GetRequiredService<BoardDb>();
        return db.BoardAliases.AsNoTracking()
            .Where(a => a.Slug == alias)
            .Join(db.Boards, a => a.BoardId, b => b.Id, (a, b) => b.Slug)
            .SingleOrDefaultAsync(ctx.RequestAborted);
    }
}
