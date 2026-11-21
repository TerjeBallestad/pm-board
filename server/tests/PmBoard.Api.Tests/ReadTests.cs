using System.Net;
using System.Text.Json.Nodes;
using Microsoft.Extensions.DependencyInjection;
using PmBoard.Api.Data;
using PmBoard.Api.Import;

namespace PmBoard.Api.Tests;

/// <summary>
/// The read API returns 0.x's JSON. tools/compare-read.mjs checks it against 0.x on real boards; these
/// tests pin the rules on a small board, so CI checks them without the real boards.
/// </summary>
public class ReadTests(BoardFactory factory) : IClassFixture<BoardFactory>
{
    private static readonly string Hour = DateTimeOffset.UtcNow.AddMinutes(-30).ToString("O");

    private async Task<string> Board()
    {
        var slug = "read-" + Guid.NewGuid().ToString("N")[..8];
        var dump = JsonNode.Parse(
            $$"""
            {
              "format": "pm-v0-export",
              "board": { "slug": "{{slug}}", "name": "Read test",
                "config": { "stages": ["inbox", "done"], "claimTtlHours": 4,
                  "entityTypes": { "SB": { "label": "Issue" }, "TERM": { "label": "Term", "frontier": false } } } },
              "items": [
                { "id": "SB-001", "type": "issue", "title": "Open", "stage": "inbox", "blockedBy": [], "pillar": "core",
                  "createdAt": "2026-01-02T03:04:05.000Z",
                  "comments": [ { "id": "c2", "author": "a", "text": "second", "createdAt": "2026-01-01T00:00:00.000Z" },
                                { "id": "c1", "author": "a", "text": "first is later", "createdAt": "2026-01-03T00:00:00.000Z" } ] },
                { "id": "SB-002", "type": "issue", "title": "Blocked by an open item", "stage": "inbox", "blockedBy": ["SB-001"] },
                { "id": "SB-003", "type": "issue", "title": "Blocked by a done item", "stage": "inbox", "blockedBy": ["SB-004"] },
                { "id": "SB-004", "type": "issue", "title": "Done", "stage": "done", "sprintId": "SPRINT-001" },
                { "id": "SB-005", "type": "issue", "title": "Claimed", "stage": "inbox", "assignee": "x", "assignedAt": "{{Hour}}" },
                { "id": "TERM-001", "type": "term", "title": "Word", "stage": "inbox" }
              ],
              "designs": [ { "id": "SDD-001", "title": "Design", "stage": "sdd", "sprintId": "SPRINT-001" } ],
              "plans": [ { "id": "PLAN-001", "title": "Plan", "stage": "planned",
                "tasks": [ { "id": "TASK-001", "title": "A", "status": "done", "blockedBy": [0],
                             "progressNotes": [ { "text": "n1", "timestamp": "2026-01-04T00:00:00.000Z" } ] },
                           { "id": "TASK-002", "title": "B", "status": "pending" } ] } ],
              "sprints": [ { "id": "SPRINT-001", "name": "Sprint", "status": "active" } ],
              "milestones": [],
              "archive": { "items": [ { "id": "SB-009", "type": "issue", "title": "Old", "stage": "done" } ], "designs": [],
                           "archivedAt": { "SB-009": "2026-02-01T00:00:00.000Z" } },
              "quarantined": [],
              "sidecarTests": { "SDD-001": [ { "name": "t1" } ] },
              "notRead": []
            }
            """
        )!;
        using var scope = factory.Services.CreateScope();
        await new V0Importer(scope.ServiceProvider.GetRequiredService<BoardDb>()).ImportAsync(dump);
        return slug;
    }

    private async Task<JsonNode> Get(string path)
    {
        var res = await factory.CreateClient().GetAsync(path);
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        return JsonNode.Parse(await res.Content.ReadAsStringAsync())!;
    }

    private static string[] Ids(JsonNode list) => list.AsArray().Select(x => (string)x!["id"]!).ToArray();

    [Fact]
    public async Task An_item_comes_back_in_its_0x_shape()
    {
        var slug = await Board();
        var sb1 = await Get($"/api/boards/{slug}/items/SB-001");
        Assert.Equal("SB-001", (string)sb1["id"]!);
        Assert.Equal("issue", (string)sb1["type"]!);
        Assert.Equal("core", (string)sb1["pillar"]!);
        Assert.Equal("2026-01-02T03:04:05.000Z", (string)sb1["createdAt"]!);
        Assert.Null(sb1["sprintId"]);
        Assert.True(sb1.AsObject().ContainsKey("assignee"));
    }

    [Fact]
    public async Task Comments_keep_their_0x_order_even_when_their_times_do_not()
    {
        var slug = await Board();
        var sb1 = await Get($"/api/boards/{slug}/items/SB-001");
        Assert.Equal(["c2", "c1"], sb1["comments"]!.AsArray().Select(c => (string)c!["id"]!));
    }

    [Fact]
    public async Task The_frontier_leaves_out_done_blocked_claimed_and_non_frontier_items()
    {
        var slug = await Board();
        Assert.Equal(["SB-001", "SB-003"], Ids(await Get($"/api/boards/{slug}/items?frontier=true")));
        Assert.Equal(["SB-001", "SB-003", "SB-005"], Ids(await Get($"/api/boards/{slug}/items?frontier=true&allClaims=true")));
    }

    [Fact]
    public async Task Archived_items_are_only_on_the_archived_list()
    {
        var slug = await Board();
        Assert.DoesNotContain("SB-009", Ids(await Get($"/api/boards/{slug}/items")));
        var archived = await Get($"/api/boards/{slug}/items/archived");
        Assert.Equal(["SB-009"], Ids(archived));
        Assert.Equal("2026-02-01T00:00:00.000Z", (string)archived[0]!["archivedAt"]!);
        var res = await factory.CreateClient().GetAsync($"/api/boards/{slug}/items/SB-009");
        Assert.Equal(HttpStatusCode.NotFound, res.StatusCode);
    }

    [Fact]
    public async Task A_plan_has_its_tasks_in_order_with_progress_notes_and_original_blockers()
    {
        var slug = await Board();
        var plan = await Get($"/api/boards/{slug}/plans/PLAN-001");
        var tasks = plan["tasks"]!.AsArray();
        Assert.Equal(["TASK-001", "TASK-002"], Ids(tasks));
        Assert.Equal("n1", (string)tasks[0]!["progressNotes"]![0]!["text"]!);
        Assert.Equal("[0]", tasks[0]!["blockedBy"]!.ToJsonString());
    }

    [Fact]
    public async Task Designs_carry_their_sidecar_tests_except_inside_a_sprint_as_in_0x()
    {
        var slug = await Board();
        Assert.Equal("t1", (string)(await Get($"/api/boards/{slug}/designs/SDD-001"))["tests"]![0]!["name"]!);
        var sprint = await Get($"/api/boards/{slug}/sprints/SPRINT-001");
        Assert.Equal("Sprint", (string)sprint["name"]!);
        Assert.Equal(["SB-004"], Ids(sprint["items"]!));
        Assert.Null(sprint["designs"]![0]!["tests"]);
    }

    [Fact]
    public async Task The_board_list_and_config_include_the_imported_board()
    {
        var slug = await Board();
        Assert.Contains(slug, (await Get("/api/boards")).AsArray().Select(p => (string)p!["slug"]!));
        var cfg = await Get($"/api/boards/{slug}/config");
        Assert.Equal("Read test", (string)cfg["name"]!);
        Assert.Equal("[\"inbox\",\"done\"]", cfg["stages"]!.ToJsonString());
    }

    [Theory]
    [InlineData("/api/boards/no-such-board/items")]
    [InlineData("/api/boards/no-such-board/config")]
    public async Task An_unknown_board_is_404(string path)
    {
        var res = await factory.CreateClient().GetAsync(path);
        Assert.Equal(HttpStatusCode.NotFound, res.StatusCode);
    }
}
