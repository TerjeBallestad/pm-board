namespace PmBoard.Api.Data;

public static class CommentKind
{
    public const string Comment = "comment";

    /// <summary>A task's progress note.</summary>
    public const string Progress = "progress";
}

/// <summary>A comment, or a task's progress note (DD-014).</summary>
public class Comment
{
    public Guid Id { get; set; }
    public Guid RecordId { get; set; }
    public required string Kind { get; set; }

    /// <summary>The 0.x comment id, for example c1795214079082.</summary>
    public string? LegacyId { get; set; }
    public string? Author { get; set; }
    public required string Text { get; set; }
    public DateTimeOffset? CreatedAt { get; set; }
}
