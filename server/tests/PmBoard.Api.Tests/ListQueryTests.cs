using System.Net;
using System.Text.Json.Nodes;
using Microsoft.Extensions.DependencyInjection;
using PmBoard.Api.Data;
using PmBoard.Api.Import;

namespace PmBoard.Api.Tests;

/// <summary>
/// ?sort=updatedAt, ?limit=N and ?fields on the list routes (DD-029): pm list asks for the rows it
/// prints, in the order the CLI's printList sorts them.
/// </summary>
public class ListQueryTests(BoardFactory factory) : IClassFixture<BoardFactory>
{
    private async Task<string> Board()
    {
        var slug = "list-" + Guid.NewGuid().ToString("N")[..8];
        // printList sorts by updatedAt || createdAt || '', as strings. SB-001 and SB-003 tie and keep
        // key order. SB-005's updatedAt did not parse on import, so it sorts as its text.
        var dump = JsonNode.Parse(
            $$"""
            {
              "format": "pm-v0-export",
              "board": { "slug": "{{slug}}", "name": "List query test", "config": {} },
              "items": [
                { "id": "SB-001", "type": "issue", "title": "Tie, first by key", "stage": "inbox", "body": "A body",
                  "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-05T00:00:00.000Z",
                  "comments": [ { "id": "c1", "author": "a", "text": "a comment", "createdAt": "2026-01-05T00:00:00.000Z" } ] },
                { "id": "SB-002", "type": "issue", "title": "Only created", "stage": "inbox", "createdAt": "2026-01-03T00:00:00.000Z" },
                { "id": "SB-003", "type": "issue", "title": "Tie, second by key", "stage": "done",
                  "createdAt": "2026-01-02T00:00:00.000Z", "updatedAt": "2026-01-05T00:00:00.000Z" },
                { "id": "SB-004", "type": "issue", "title": "No times", "stage": "inbox" },
                { "id": "SB-005", "type": "issue", "title": "A time that did not parse", "stage": "inbox", "updatedAt": "not a time" },
                { "id": "DD-001", "type": "decision", "title": "Newest of all", "stage": "inbox", "updatedAt": "2026-02-01T00:00:00.000Z" }
              ],
              "designs": [
                { "id": "SDD-001", "title": "Newer design", "stage": "sdd", "updatedAt": "2026-01-09T00:00:00.000Z" },
                { "id": "SDD-002", "title": "Older design", "stage": "sdd", "updatedAt": "2026-01-08T00:00:00.000Z" }
              ],
              "plans": [
                { "id": "PLAN-001", "title": "Newer plan", "stage": "planned", "sprintId": "SPRINT-001", "updatedAt": "2026-01-09T00:00:00.000Z",
                  "tasks": [ { "id": "TASK-001", "title": "A", "status": "pending" } ] },
                { "id": "PLAN-002", "title": "Older plan", "stage": "planned", "sprintId": "SPRINT-001", "updatedAt": "2026-01-08T00:00:00.000Z", "tasks": [] }
              ],
              "sprints": [
                { "id": "SPRINT-001", "name": "Newer project", "status": "active", "updatedAt": "2026-01-09T00:00:00.000Z" },
                { "id": "SPRINT-002", "name": "Older project", "status": "active", "createdAt": "2026-01-08T00:00:00.000Z" }
              ],
              "milestones": [],
              "archive": { "items": [], "designs": [], "archivedAt": {} },
              "quarantined": [], "sidecarTests": {}, "notRead": [], "attachments": []
            }
            """
        )!;
        using var scope = factory.Services.CreateScope();
        await new V0Importer(scope.ServiceProvider.GetRequiredService<BoardDb>()).ImportAsync(dump);
        return slug;
    }

    private async Task<(JsonArray Rows, string? Total)> Get(string path)
    {
        var res = await factory.CreateClient().GetAsync(path);
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        var total = res.Headers.TryGetValues("X-Total-Count", out var v) ? v.Single() : null;
        return (JsonNode.Parse(await res.Content.ReadAsStringAsync())!.AsArray(), total);
    }

    private static string[] Ids(JsonArray rows) => rows.Select(x => (string)x!["id"]!).ToArray();

    [Fact]
    public async Task Sort_orders_oldest_to_newest_as_pm_list_does_and_ties_keep_key_order()
    {
        var slug = await Board();
        var (rows, total) = await Get($"/api/boards/{slug}/items?sort=updatedAt");
        Assert.Equal(["SB-004", "SB-002", "SB-001", "SB-003", "DD-001", "SB-005"], Ids(rows));
        Assert.Null(total);
    }

    [Fact]
    public async Task Limit_keeps_the_newest_rows_and_the_header_counts_every_row()
    {
        var slug = await Board();
        var (rows, total) = await Get($"/api/boards/{slug}/items?sort=updatedAt&limit=3");
        Assert.Equal(["SB-003", "DD-001", "SB-005"], Ids(rows));
        Assert.Equal("6", total);

        // The filters come first, then the cut.
        (rows, total) = await Get($"/api/boards/{slug}/items?type=issue&stage=inbox&sort=updatedAt&limit=2");
        Assert.Equal(["SB-001", "SB-005"], Ids(rows));
        Assert.Equal("4", total);
        (rows, total) = await Get($"/api/boards/{slug}/items?frontier=true&sort=updatedAt&limit=50");
        Assert.Equal(["SB-004", "SB-002", "SB-001", "DD-001", "SB-005"], Ids(rows));
        Assert.Equal("5", total);
    }

    [Fact]
    public async Task Fields_keeps_only_the_keys_asked_for()
    {
        var slug = await Board();
        var (rows, _) = await Get($"/api/boards/{slug}/items?sort=updatedAt&limit=4&fields=id,title,name,updatedAt,createdAt");
        Assert.Equal(
            """{"id":"SB-001","title":"Tie, first by key","createdAt":"2026-01-01T00:00:00.000Z","updatedAt":"2026-01-05T00:00:00.000Z"}""",
            rows[0]!.ToJsonString()
        );
        Assert.Equal("""{"id":"SB-005","title":"A time that did not parse","updatedAt":"not a time"}""", rows[3]!.ToJsonString());
    }

    [Fact]
    public async Task Designs_plans_and_projects_take_the_same_query()
    {
        var slug = await Board();
        var (rows, total) = await Get($"/api/boards/{slug}/designs?sort=updatedAt&limit=1&fields=id");
        Assert.Equal("""[{"id":"SDD-001"}]""", rows.ToJsonString());
        Assert.Equal("2", total);
        (rows, total) = await Get($"/api/boards/{slug}/plans?sprintId=SPRINT-001&sort=updatedAt&limit=1");
        Assert.Equal(["PLAN-001"], Ids(rows));
        Assert.Equal(["TASK-001"], Ids(rows[0]!["tasks"]!.AsArray()));
        Assert.Equal("2", total);
        (rows, _) = await Get($"/api/boards/{slug}/sprints?sort=updatedAt&fields=id,name");
        Assert.Equal("""[{"id":"SPRINT-002","name":"Older project"},{"id":"SPRINT-001","name":"Newer project"}]""", rows.ToJsonString());
    }

    [Fact]
    public async Task Without_the_query_a_list_answers_as_before()
    {
        var slug = await Board();
        var http = factory.CreateClient();
        foreach (var path in new[] { "items", "designs", "plans", "sprints" })
        {
            var res = await http.GetAsync($"/api/boards/{slug}/{path}");
            Assert.False(res.Headers.Contains("X-Total-Count"));
            var rows = JsonNode.Parse(await res.Content.ReadAsStringAsync())!.AsArray();
            Assert.Equal(Ids(rows).OrderBy(k => k, StringComparer.Ordinal), Ids(rows));
        }
        var (items, _) = await Get($"/api/boards/{slug}/items");
        Assert.Equal("a comment", (string)items.Single(r => (string)r!["id"]! == "SB-001")!["comments"]![0]!["text"]!);
    }

    [Theory]
    [InlineData("sort=title", "sort must be updatedAt")]
    [InlineData("sort=updatedAt&limit=0", "limit must be a whole number above 0")]
    [InlineData("sort=updatedAt&limit=-1", "limit must be a whole number above 0")]
    [InlineData("sort=updatedAt&limit=ten", "limit must be a whole number above 0")]
    [InlineData("limit=5", "limit needs sort=updatedAt: it keeps the newest rows")]
    public async Task A_bad_query_is_400(string query, string error)
    {
        var slug = await Board();
        foreach (var path in new[] { "items", "designs", "plans", "sprints" })
        {
            var res = await factory.CreateClient().GetAsync($"/api/boards/{slug}/{path}?{query}");
            Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
            Assert.Equal(error, (string)JsonNode.Parse(await res.Content.ReadAsStringAsync())!["error"]!);
        }
    }
}
