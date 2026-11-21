using System.Text.Json;

namespace PmBoard.Api.Data;

public static class RecordKind
{
    public const string Item = "item";
    public const string Design = "design";
    public const string Plan = "plan";
    public const string Task = "task";
    public const string Sprint = "sprint";
    public const string Milestone = "milestone";

    public static readonly string[] All = [Item, Design, Plan, Task, Sprint, Milestone];
}

/// <summary>
/// Every keyed thing on a board: items, designs, plans, tasks, sprints and milestones (DD-010).
/// The key is unique in the project across all kinds, live and archived.
/// </summary>
public class Record
{
    public Guid Id { get; set; }
    public Guid ProjectId { get; set; }

    /// <summary>SB-042. Never reused.</summary>
    public required string Key { get; set; }

    /// <summary>SB for SB-042. Null when the key has no number (SDD-flow-resonance, v0.1).</summary>
    public string? Prefix { get; set; }
    public int? Number { get; set; }

    public required string Kind { get; set; }

    /// <summary>issue, decision, term, ... Items only.</summary>
    public string? Type { get; set; }

    /// <summary>A task's plan.</summary>
    public Guid? ParentId { get; set; }

    /// <summary>A task's place in its plan, from 0.</summary>
    public int? Position { get; set; }

    public string Title { get; set; } = "";
    public string? Stage { get; set; }
    public string? Status { get; set; }
    public string? Priority { get; set; }
    public string? Body { get; set; }

    /// <summary>The project (SPRINT-NNN) this record belongs to. A key, not a foreign key (DD-012).</summary>
    public string? SprintKey { get; set; }

    /// <summary>Keys this record waits for (DD-012).</summary>
    public List<string> BlockedBy { get; set; } = [];

    /// <summary>The claim holder.</summary>
    public string? Assignee { get; set; }
    public DateTimeOffset? AssignedAt { get; set; }

    public DateTimeOffset? CreatedAt { get; set; }
    public DateTimeOffset? UpdatedAt { get; set; }
    public DateTimeOffset? DoneAt { get; set; }

    /// <summary>Null while the record is on the board.</summary>
    public DateTimeOffset? ArchivedAt { get; set; }

    /// <summary>Every other 0.x field, with its 0.x name and value.</summary>
    public JsonDocument Fields { get; set; } = JsonDocument.Parse("{}");
}
