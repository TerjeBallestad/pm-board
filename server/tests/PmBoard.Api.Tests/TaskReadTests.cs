using System.Net;
using System.Net.Http.Json;
using System.Text.Json.Nodes;
using Microsoft.Extensions.DependencyInjection;
using PmBoard.Api.Data;
using PmBoard.Api.Import;

namespace PmBoard.Api.Tests;

/// <summary>GET /api/boards/{slug}/tasks/{key}: one task with its plan's key (DD-026).</summary>
public class TaskReadTests(BoardFactory factory) : IClassFixture<BoardFactory>
{
    private async Task<string> Board()
    {
        var slug = "tasks-" + Guid.NewGuid().ToString("N")[..8];
        var dump = JsonNode.Parse(
            $$"""
            {
              "format": "pm-v0-export",
              "board": { "slug": "{{slug}}", "name": "Task read test", "config": {} },
              "items": [ { "id": "SB-001", "type": "issue", "title": "Not a task", "stage": "inbox" } ],
              "designs": [], "sprints": [], "milestones": [],
              "plans": [ { "id": "PLAN-001", "title": "Plan", "stage": "planned", "tasks": [
                { "id": "TASK-001", "title": "First", "status": "done", "passes": true, "steps": ["a", "b"],
                  "progressNotes": [ { "text": "started", "timestamp": "2026-01-01T10:00:00.000Z" }, { "text": "done", "timestamp": "2026-01-02T10:00:00.000Z" } ] },
                { "id": "TASK-002", "title": "Second", "status": "pending", "blockedBy": ["TASK-001"] } ] } ],
              "archive": { "items": [], "designs": [], "archivedAt": {} },
              "quarantined": [], "sidecarTests": {}, "notRead": [], "attachments": []
            }
            """
        )!;
        using var scope = factory.Services.CreateScope();
        await new V0Importer(scope.ServiceProvider.GetRequiredService<BoardDb>()).ImportAsync(dump);
        return slug;
    }

    [Fact]
    public async Task A_task_reads_as_it_does_inside_its_plan_with_the_plan_key()
    {
        var slug = await Board();
        var http = factory.CreateClient();

        var task = (await http.GetFromJsonAsync<JsonObject>($"/api/boards/{slug}/tasks/TASK-001"))!;
        var inPlan = (await http.GetFromJsonAsync<JsonObject>($"/api/boards/{slug}/plans/PLAN-001"))!["tasks"]![0]!.AsObject();

        Assert.Equal("PLAN-001", (string)task["planId"]!);
        task.Remove("planId");
        Assert.True(JsonNode.DeepEquals(inPlan, task), task.ToJsonString());
        Assert.Equal(["started", "done"], task["progressNotes"]!.AsArray().Select(n => (string)n!["text"]!));
    }

    [Fact]
    public async Task A_key_that_is_no_task_is_404()
    {
        var slug = await Board();
        var http = factory.CreateClient();
        Assert.Equal(HttpStatusCode.NotFound, (await http.GetAsync($"/api/boards/{slug}/tasks/SB-001")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await http.GetAsync($"/api/boards/{slug}/tasks/TASK-999")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await http.GetAsync($"/api/boards/no-such-board/tasks/TASK-001")).StatusCode);
    }
}
