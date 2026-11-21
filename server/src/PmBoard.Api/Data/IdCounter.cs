namespace PmBoard.Api.Data;

/// <summary>The number the next key with this prefix gets in this board (DD-011).</summary>
public class IdCounter
{
    public Guid BoardId { get; set; }
    public required string Prefix { get; set; }
    public int NextNumber { get; set; }
}
