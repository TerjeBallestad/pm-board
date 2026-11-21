namespace PmBoard.Api.Data;

/// <summary>A person who writes to boards (DD-003). Only tokens sign in for now.</summary>
public class User
{
    public Guid Id { get; set; }

    /// <summary>Unique. Comments and claims record it when the request names nobody (DD-020).</summary>
    public required string Name { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
}
