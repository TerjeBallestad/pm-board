namespace PmBoard.Api.Data;

/// <summary>
/// A personal access token, one for each machine (DD-003). Only the SHA-256 hash of the token is
/// stored: the token is 32 random bytes, so a fast hash is enough. It is not a password.
/// </summary>
public class Token
{
    public Guid Id { get; set; }
    public Guid UserId { get; set; }

    /// <summary>The machine, for example mac-mini. Unique among the user's tokens that are not revoked.</summary>
    public required string Name { get; set; }
    public required byte[] Hash { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset? LastUsedAt { get; set; }

    /// <summary>Set once. A revoked token never passes again.</summary>
    public DateTimeOffset? RevokedAt { get; set; }
}
