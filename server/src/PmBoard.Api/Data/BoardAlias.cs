namespace PmBoard.Api.Data;

/// <summary>
/// An old slug of a renamed board (DD-035). A request to /api/boards/&lt;alias&gt; acts on the board,
/// and the dashboard at /&lt;alias&gt; redirects to the board's slug. An alias is never the slug of a
/// board.
/// </summary>
public class BoardAlias
{
    /// <summary>The old slug: time-turtle. Unique among aliases.</summary>
    public required string Slug { get; set; }
    public Guid BoardId { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
}
