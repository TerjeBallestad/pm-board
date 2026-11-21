using Microsoft.EntityFrameworkCore;
using PmBoard.Api.Data;

namespace PmBoard.Api.Keys;

/// <summary>
/// Gives out the next key for a prefix in a project (DD-011). Call it inside the transaction that
/// inserts the record: the counter row stays locked until that transaction ends, so a second
/// writer for the same prefix waits, and a rollback gives the number back.
/// </summary>
public static class KeyAllocator
{
    public static async Task<(string Key, int Number)> NextAsync(
        BoardDb db,
        Guid projectId,
        string prefix,
        CancellationToken ct = default
    )
    {
        if (db.Database.CurrentTransaction is null)
        {
            throw new InvalidOperationException(
                "Allocate a key inside the transaction that inserts the record, or a failed insert loses the number"
            );
        }

        // An INSERT cannot be wrapped in a SELECT, so read the one row without composing a query.
        var rows = await db
            .Database.SqlQuery<int>(
                $"""
                INSERT INTO id_counters (project_id, prefix, next_number)
                VALUES ({projectId}, {prefix}, 2)
                ON CONFLICT (project_id, prefix)
                DO UPDATE SET next_number = id_counters.next_number + 1
                RETURNING next_number - 1 AS "Value"
                """
            )
            .AsAsyncEnumerable()
            .ToListAsync(ct);
        var number = rows.Single();

        return (Format(prefix, number), number);
    }

    /// <summary>The 0.x format: at least three digits. SB-007, SB-042, SB-1000.</summary>
    public static string Format(string prefix, int number) => $"{prefix}-{number:D3}";

    /// <summary>SB-042 gives (SB, 42). DC-NEW-7 gives (DC-NEW, 7). SDD-flow-resonance and v0.1 give (null, null).</summary>
    public static (string? Prefix, int? Number) Parse(string key)
    {
        var dash = key.LastIndexOf('-');
        if (dash <= 0 || dash == key.Length - 1)
        {
            return (null, null);
        }
        var digits = key[(dash + 1)..];
        if (!digits.All(char.IsAsciiDigit) || !int.TryParse(digits, out var n))
        {
            return (null, null);
        }
        return (key[..dash], n);
    }
}
