using System.Globalization;
using Microsoft.EntityFrameworkCore;
using PmBoard.Api.Data;

namespace PmBoard.Api.Auth;

/// <summary>
/// The `token` command: create, list and revoke personal access tokens (DD-003). In the cluster it
/// runs with kubectl exec in the pod (README, Tokens).
/// </summary>
public static class TokenCommand
{
    private const string Usage = """
        usage: PmBoard.Api token create --user <name> --name <machine>
                                         prints a new token once, on stdout; creates the user if needed
               PmBoard.Api token list    every token, revoked ones too
               PmBoard.Api token revoke <id>
                                         the whole id from `token list`
        """;

    public static async Task<int> RunAsync(IServiceProvider services, string[] args, TextWriter? stdout = null, TextWriter? stderr = null)
    {
        var o = stdout ?? Console.Out;
        var e = stderr ?? Console.Error;
        using var scope = services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<BoardDb>();
        switch (args)
        {
            case ["create", .. var rest] when Flags(rest) is { } f && f.TryGetValue("user", out var user) && f.TryGetValue("name", out var name):
                return await Create(db, user, name, o, e);
            case ["list"]:
                return await List(db, o);
            case ["revoke", var id]:
                return await Revoke(db, id, o, e);
            default:
                e.WriteLine(Usage);
                return 2;
        }
    }

    /// <summary>--user a --name b as a map; null for anything else, so a typo prints the usage.</summary>
    private static Dictionary<string, string>? Flags(string[] args)
    {
        if (args.Length % 2 != 0) return null;
        var flags = new Dictionary<string, string>();
        for (var i = 0; i < args.Length; i += 2)
        {
            if (args[i] is not ("--user" or "--name") || string.IsNullOrWhiteSpace(args[i + 1])) return null;
            flags[args[i][2..]] = args[i + 1].Trim();
        }
        return flags;
    }

    private static async Task<int> Create(BoardDb db, string userName, string name, TextWriter o, TextWriter e)
    {
        await using var tx = await db.Database.BeginTransactionAsync();
        var user = await db.Users.SingleOrDefaultAsync(u => u.Name == userName);
        if (user is null)
        {
            user = new User { Id = Guid.CreateVersion7(), Name = userName };
            db.Users.Add(user);
            e.WriteLine($"created user {userName}");
        }
        else if (await db.Tokens.AnyAsync(t => t.UserId == user.Id && t.Name == name && t.RevokedAt == null))
        {
            e.WriteLine($"{userName} already has a token named {name}: revoke it first (token list, token revoke <id>)");
            return 1;
        }

        var token = Tokens.New();
        var row = new Token { Id = Guid.CreateVersion7(), UserId = user.Id, Name = name, Hash = Tokens.Hash(token) };
        db.Tokens.Add(row);
        await db.SaveChangesAsync();
        await tx.CommitAsync();

        o.WriteLine(token);
        // The id goes to stderr with the note. It is easy to copy it for the token, so say which line is the token.
        e.WriteLine($"made token for {userName} on {name} (id {row.Id}, for token revoke).");
        e.WriteLine($"The token is the other line, the one that starts with {Tokens.Prefix}. It is shown only now: the server keeps its hash.");
        return 0;
    }

    private static async Task<int> List(BoardDb db, TextWriter o)
    {
        var rows = await db.Tokens
            .Join(db.Users, t => t.UserId, u => u.Id, (t, u) => new { t, User = u.Name })
            .OrderBy(x => x.User)
            .ThenBy(x => x.t.CreatedAt)
            .ToListAsync();
        o.WriteLine($"{"id",-36}  {"user",-12}  {"name",-16}  {"created",-16}  {"last used",-16}  revoked");
        foreach (var x in rows)
        {
            o.WriteLine($"{x.t.Id,-36}  {x.User,-12}  {x.t.Name,-16}  {Time(x.t.CreatedAt),-16}  {Time(x.t.LastUsedAt),-16}  {Time(x.t.RevokedAt)}");
        }
        return 0;
    }

    private static async Task<int> Revoke(BoardDb db, string id, TextWriter o, TextWriter e)
    {
        if (!Guid.TryParse(id, out var guid))
        {
            e.WriteLine($"{id} is not a token id: copy the whole id from `token list`");
            return 2;
        }
        var token = await db.Tokens.SingleOrDefaultAsync(t => t.Id == guid);
        if (token is null)
        {
            e.WriteLine($"no token {guid}");
            return 1;
        }
        if (token.RevokedAt is not null)
        {
            o.WriteLine($"token {token.Id} ({token.Name}) was already revoked at {Time(token.RevokedAt)}");
            return 0;
        }
        token.RevokedAt = DateTimeOffset.UtcNow;
        await db.SaveChangesAsync();
        o.WriteLine($"revoked token {token.Id} ({token.Name})");
        return 0;
    }

    private static string Time(DateTimeOffset? t) =>
        t?.UtcDateTime.ToString("yyyy-MM-dd HH:mm", CultureInfo.InvariantCulture) ?? "-";
}
