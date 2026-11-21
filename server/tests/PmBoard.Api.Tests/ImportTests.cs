using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using PmBoard.Api.Data;
using PmBoard.Api.Import;
using PmBoard.Api.Keys;
using Record = PmBoard.Api.Data.Record;

namespace PmBoard.Api.Tests;

public class ImportTests(BoardFactory factory) : IClassFixture<BoardFactory>
{
    /// <summary>A small tools/export-v0.mjs dump with one of each case.</summary>
    private static JsonNode Dump(string slug) =>
        JsonNode.Parse(
            $$"""
            {
              "format": "pm-v0-export",
              "board": { "slug": "{{slug}}", "name": "Fixture", "config": { "stages": ["inbox", "done"] } },
              "items": [
                { "id": "SB-001", "type": "issue", "title": "Live", "stage": "inbox", "priority": "high",
                  "pillar": "core", "related": ["DD-001", "SB-404"], "affectedFiles": ["a.js"], "blockedBy": ["SB-002"],
                  "sprintId": "SPRINT-001", "createdAt": "2026-01-02T03:04:05.000Z", "updatedAt": "not a time",
                  "seeds": [1, 2], "body": "live body",
                  "comments": [{ "id": "c1", "author": "claude", "text": "hello", "createdAt": "2026-01-03T00:00:00.000Z" }] },
                { "id": "SB-002", "type": "issue", "title": "Same twice", "stage": "done", "body": "b" },
                { "id": "DD-001", "type": "decision", "title": "A decision", "stage": "inbox" }
              ],
              "designs": [ { "id": "SDD-flow-resonance", "title": "Slug design", "itemIds": ["SB-001"], "stage": "sdd" } ],
              "plans": [
                { "id": "PLAN-001", "title": "Plan", "stage": "planned", "sddId": "SDD-404", "context": { "setupNotes": "x" },
                  "tasks": [
                    { "id": "TASK-001", "title": "First", "status": "done", "passes": true, "steps": ["a", "b"],
                      "progressNotes": [{ "text": "did it", "timestamp": "2026-01-04T00:00:00.000Z" }] },
                    { "id": "TASK-002", "title": "Second", "status": "pending", "blockedBy": ["TASK-001"] }
                  ] },
                { "id": "PLAN-002", "title": "Other plan", "stage": "planned",
                  "tasks": [ { "id": "TASK-002", "title": "A different task with the same key", "status": "pending" } ] }
              ],
              "sprints": [ { "id": "SPRINT-001", "name": "Sprint one", "problemStatement": "why", "status": "active" } ],
              "milestones": [ { "id": "v0.1", "title": "First", "status": "shipped", "phases": [] } ],
              "archive": {
                "items": [
                  { "id": "SB-002", "type": "issue", "title": "Same twice", "stage": "done", "body": "b" },
                  { "id": "DD-001", "type": "decision", "title": "Different", "stage": "done" },
                  { "id": "SB-009", "type": "issue", "title": "Archived", "stage": "done" }
                ],
                "designs": [],
                "archivedAt": { "SB-009": "2026-02-01T00:00:00.000Z", "DD-001": "2026-02-02T00:00:00.000Z" }
              },
              "quarantined": [ { "id": "SB-020" } ],
              "notRead": [ "items/DD-001.tests.json" ]
            }
            """
        )!;

    private async Task<(ImportReport Report, List<Record> Records, List<Comment> Comments, List<IdCounter> Counters)> Import(string slug)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<BoardDb>();
        var report = await new V0Importer(db).ImportAsync(Dump(slug));
        var board = await db.Boards.SingleAsync(p => p.Slug == slug);
        var records = await db.Records.Where(r => r.BoardId == board.Id).ToListAsync();
        var ids = records.Select(r => r.Id).ToList();
        var comments = await db.Comments.Where(c => ids.Contains(c.RecordId)).ToListAsync();
        var counters = await db.IdCounters.Where(c => c.BoardId == board.Id).ToListAsync();
        return (report, records, comments, counters);
    }

    private static string Slug() => "import-" + Guid.NewGuid().ToString("N")[..8];

    [Fact]
    public async Task Shared_fields_become_columns_and_every_other_field_stays_in_fields_verbatim()
    {
        var (_, records, _, _) = await Import(Slug());
        var sb1 = records.Single(r => r.Key == "SB-001");
        Assert.Equal(("SB", 1), (sb1.Prefix, sb1.Number));
        Assert.Equal(("item", "issue", "Live", "inbox", "high"), (sb1.Kind, sb1.Type, sb1.Title, sb1.Stage, sb1.Priority));
        Assert.Equal("SPRINT-001", sb1.SprintKey);
        Assert.Equal(["SB-002"], sb1.BlockedBy);
        Assert.Equal(new DateTimeOffset(2026, 1, 2, 3, 4, 5, TimeSpan.Zero), sb1.CreatedAt);
        var f = sb1.Fields.RootElement;
        Assert.Equal("core", f.GetProperty("pillar").GetString());
        Assert.Equal("[1,2]", f.GetProperty("seeds").GetRawText());
        Assert.False(f.TryGetProperty("title", out _));

        var sprint = records.Single(r => r.Key == "SPRINT-001");
        Assert.Equal(("sprint", "Sprint one"), (sprint.Kind, sprint.Title));
        Assert.Equal("why", sprint.Fields.RootElement.GetProperty("problemStatement").GetString());
    }

    [Fact]
    public async Task A_time_that_does_not_parse_stays_in_fields_and_is_reported()
    {
        var (report, records, _, _) = await Import(Slug());
        var sb1 = records.Single(r => r.Key == "SB-001");
        Assert.Null(sb1.UpdatedAt);
        Assert.Equal("not a time", sb1.Fields.RootElement.GetProperty("updatedAt").GetString());
        Assert.Contains(report.UnreadableTimes, t => t.StartsWith("SB-001.updatedAt"));
    }

    [Fact]
    public async Task Comments_and_progress_notes_become_comment_rows()
    {
        var (_, records, comments, _) = await Import(Slug());
        var sb1 = records.Single(r => r.Key == "SB-001");
        var c = Assert.Single(comments, x => x.RecordId == sb1.Id);
        Assert.Equal(("comment", "c1", "claude", "hello"), (c.Kind, c.LegacyId, c.Author, c.Text));
        var task1 = records.Single(r => r.Key == "TASK-001");
        var n = Assert.Single(comments, x => x.RecordId == task1.Id);
        Assert.Equal(("progress", "did it"), (n.Kind, n.Text));
    }

    [Fact]
    public async Task Tasks_belong_to_their_plan_in_plan_order()
    {
        var (_, records, _, _) = await Import(Slug());
        var plan = records.Single(r => r.Key == "PLAN-001");
        var tasks = records.Where(r => r.ParentId == plan.Id).OrderBy(r => r.Position).Select(r => r.Key);
        Assert.Equal(["TASK-001", "TASK-002"], tasks);
        Assert.Equal("[\"a\",\"b\"]", records.Single(r => r.Key == "TASK-001").Fields.RootElement.GetProperty("steps").GetRawText());
    }

    [Fact]
    public async Task The_same_record_live_and_archived_keeps_only_the_live_copy()
    {
        var (report, records, _, _) = await Import(Slug());
        var sb2 = Assert.Single(records, r => r.Key == "SB-002");
        Assert.Null(sb2.ArchivedAt);
        Assert.Contains(report.Clashes, c => c.Key == "SB-002" && c.Action.StartsWith("dropped"));
    }

    [Fact]
    public async Task Two_different_records_with_one_key_are_both_kept_and_the_second_gets_a_new_key()
    {
        var (report, records, _, _) = await Import(Slug());

        // TASK-002 in PLAN-002 is a different task from TASK-002 in PLAN-001.
        Assert.Equal("Second", records.Single(r => r.Key == "TASK-002").Title);
        var moved = records.Single(r => r.Title == "A different task with the same key");
        Assert.Equal("TASK-003", moved.Key);
        Assert.Equal("TASK-002", moved.Fields.RootElement.GetProperty("v0Key").GetString());

        // DD-001 archived ("Different") is not the live DD-001.
        var dd = records.Single(r => r.Title == "Different");
        Assert.Equal("DD-002", dd.Key);
        Assert.NotNull(dd.ArchivedAt);

        Assert.Contains(report.Clashes, c => c.Key == "TASK-002" && c.Action == "renumbered to TASK-003");
    }

    [Fact]
    public async Task Counters_start_after_the_highest_number_including_skipped_files_and_renumbered_records()
    {
        var (_, _, _, counters) = await Import(Slug());
        var next = counters.ToDictionary(c => c.Prefix, c => c.NextNumber);
        Assert.Equal(21, next["SB"]); // SB-020 was a skipped file
        Assert.Equal(4, next["TASK"]); // TASK-003 went to the renumbered task
        Assert.Equal(3, next["DD"]);
        Assert.False(next.ContainsKey("v0.1"));
    }

    [Fact]
    public async Task A_new_key_after_the_import_continues_from_the_counter()
    {
        var slug = Slug();
        await Import(slug);
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<BoardDb>();
        var board = await db.Boards.SingleAsync(p => p.Slug == slug);
        await using var tx = await db.Database.BeginTransactionAsync();
        Assert.Equal("SB-021", (await KeyAllocator.NextAsync(db, board.Id, "SB")).Key);
    }

    [Fact]
    public async Task References_to_keys_that_do_not_exist_are_reported_and_kept()
    {
        var (report, records, _, _) = await Import(Slug());
        Assert.Contains(new Dangling("SB-001", "related", "SB-404"), report.Dangling);
        Assert.Contains(new Dangling("PLAN-001", "sddId", "SDD-404"), report.Dangling);
        Assert.DoesNotContain(report.Dangling, d => d.To == "DD-001" || d.To == "SPRINT-001" || d.To == "SB-001");
        Assert.Equal("SDD-404", records.Single(r => r.Key == "PLAN-001").Fields.RootElement.GetProperty("sddId").GetString());
    }

    [Fact]
    public async Task Importing_a_slug_that_exists_changes_nothing()
    {
        var slug = Slug();
        var (_, before, _, _) = await Import(slug);
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<BoardDb>();
        await Assert.ThrowsAsync<ImportException>(() => new V0Importer(db).ImportAsync(Dump(slug)));
        var board = await db.Boards.SingleAsync(p => p.Slug == slug);
        Assert.Equal(before.Count, await db.Records.CountAsync(r => r.BoardId == board.Id));
    }
}
