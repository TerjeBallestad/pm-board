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
                if (path.StartsWith(ApiPrefix, StringComparison.OrdinalIgnoreCase))
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
                        // From PathStrings, so the decoded rest is escaped again: %3F stays in the path, and
                        // %C3%A6 or %0D never reaches the Location header raw.
                        ctx.Response.Redirect(new PathString("/" + slug).Add(new PathString(rest)).ToUriComponent() + ctx.Request.QueryString);
                        return;
                    }
                }
                await next();
            }
        );
    }

    /// <summary>
    /// A board's slug and the aliases are in two tables, so no unique index keeps a slug in one
    /// of them only. Every write that takes a slug (create, rename, import) holds this lock in its
    /// transaction and checks the slug after it, so two such writes take turns.
    /// </summary>
    private const long SlugLock = 0x706d_736c_7567; // "pmslug"

    public static Task LockSlugs(BoardDb db, CancellationToken ct = default) =>
        db.Database.ExecuteSqlRawAsync($"SELECT pg_advisory_xact_lock({SlugLock})", ct);

    /// <summary>Who holds <paramref name="slug"/>, other than board <paramref name="self"/>: a board as its slug, or as an alias.</summary>
    public sealed record SlugHolder(string Board, bool IsAlias);

    public static async Task<SlugHolder?> Holder(BoardDb db, string slug, Guid? self, CancellationToken ct = default)
    {
        if (await db.Boards.AnyAsync(b => b.Slug == slug && b.Id != self, ct)) return new SlugHolder(slug, IsAlias: false);
        var owner = await db.BoardAliases.Where(a => a.Slug == slug && a.BoardId != self)
            .Join(db.Boards, a => a.BoardId, b => b.Id, (a, b) => b.Slug)
            .SingleOrDefaultAsync(ct);
        return owner is null ? null : new SlugHolder(owner, IsAlias: true);
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
