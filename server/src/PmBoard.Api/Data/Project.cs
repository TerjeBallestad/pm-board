using System.Text.Json;

namespace PmBoard.Api.Data;

public class Project
{
    public Guid Id { get; set; }

    /// <summary>The URL part: /pm-board-cli. Unique.</summary>
    public required string Slug { get; set; }
    public required string Name { get; set; }

    /// <summary>stages, entityTypes, commands, knowledgeBase, templates, frontend (0.x pm.config.json).</summary>
    public JsonDocument Config { get; set; } = JsonDocument.Parse("{}");

    public DateTimeOffset CreatedAt { get; set; }
}
