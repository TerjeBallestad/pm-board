namespace PmBoard.Api.Data;

/// <summary>An image that a record's markdown links to (0.x kept these in &lt;dataDir&gt;/../attachments). DD-018.</summary>
public class Attachment
{
    public Guid Id { get; set; }
    public Guid BoardId { get; set; }

    /// <summary>The file name, for example 0c4635b040a6.png. Unique in the board.</summary>
    public required string Name { get; set; }
    public required string ContentType { get; set; }
    public required byte[] Data { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
}
