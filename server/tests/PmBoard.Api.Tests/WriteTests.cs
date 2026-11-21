using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using PmBoard.Api.Data;
using PmBoard.Api.Import;

namespace PmBoard.Api.Tests;

/// <summary>
/// The write API. tools/compare-write.mjs checks every route against 0.x on a fixture board; these
/// tests cover what one script in one process cannot show: writers at the same moment, rollbacks,
/// and the routes 0.x had outside its dispatcher (sidecar tests, attachments).
/// </summary>
public class WriteTests(BoardFactory factory) : IClassFixture<BoardFactory>, IAsyncLifetime
{
    private HttpClient _http = null!;

    public async Task InitializeAsync() => _http = await factory.Writer();

    public Task DisposeAsync() => Task.CompletedTask;

    private async Task<string> Board()
    {
        var slug = "write-" + Guid.NewGuid().ToString("N")[..8];
        var dump = JsonNode.Parse(
            $$"""
            {
              "format": "pm-v0-export",
              "board": { "slug": "{{slug}}", "name": "Write test", "config": { "stages": ["inbox", "done"], "claimTtlHours": 4 } },
              "items": [
                { "id": "SB-001", "type": "issue", "title": "One", "stage": "inbox" },
                { "id": "DD-001", "type": "decision", "title": "A decision", "stage": "inbox" },
                { "id": "DD-002", "type": "decision", "title": "Had tests", "stage": "inbox" }
              ],
              "designs": [ { "id": "SDD-001", "title": "Design", "stage": "sdd" } ],
              "plans": [
                { "id": "PLAN-001", "title": "Plan", "stage": "planned", "tasks": [ { "id": "TASK-001", "title": "A", "status": "pending" } ] },
                { "id": "PLAN-002", "title": "Other", "stage": "planned", "tasks": [ { "id": "TASK-002", "title": "B", "status": "pending" } ] }
              ],
              "sprints": [], "milestones": [],
              "archive": { "items": [ { "id": "DD-009", "type": "decision", "title": "Archived", "stage": "done" } ], "designs": [], "archivedAt": {} },
              "quarantined": [], "sidecarTests": { "DD-002": [ { "name": "old" } ] }, "notRead": [],
              "attachments": [ { "name": "0123456789ab.png", "data": "{{Convert.ToBase64String("png bytes"u8.ToArray())}}" } ]
            }
            """
        )!;
        using var scope = factory.Services.CreateScope();
        await new V0Importer(scope.ServiceProvider.GetRequiredService<BoardDb>()).ImportAsync(dump);
        return slug;
    }

    private async Task<(HttpStatusCode Status, JsonNode? Body)> Send(HttpMethod method, string path, object? body = null)
    {
        using var req = new HttpRequestMessage(method, path);
        if (body is not null) req.Content = JsonContent.Create(body);
        var res = await _http.SendAsync(req);
        var text = await res.Content.ReadAsStringAsync();
        return (res.StatusCode, text.Length > 0 ? JsonNode.Parse(text) : null);
    }

    [Fact]
    public async Task Thirty_creates_at_once_get_thirty_different_keys_with_no_gap()
    {
        var slug = await Board();
        var results = await Task.WhenAll(
            Enumerable.Range(0, 30).Select(i => Send(HttpMethod.Post, $"/api/boards/{slug}/items", new { type = "issue", title = $"Parallel {i}" }))
        );
        Assert.All(results, r => Assert.Equal(HttpStatusCode.Created, r.Status));
        var keys = results.Select(r => (string)r.Body!["id"]!).Order().ToList();
        Assert.Equal(Enumerable.Range(2, 30).Select(n => $"SB-{n:D3}"), keys);
    }

    [Fact]
    public async Task Of_two_claims_at_once_exactly_one_wins()
    {
        var slug = await Board();
        for (var round = 0; round < 5; round++)
        {
            var key = (string)(await Send(HttpMethod.Post, $"/api/boards/{slug}/items", new { title = $"Claim me {round}" })).Body!["id"]!;
            var claims = await Task.WhenAll(
                Send(HttpMethod.Post, $"/api/boards/{slug}/items/{key}/claim", new { assignee = "a" }),
                Send(HttpMethod.Post, $"/api/boards/{slug}/items/{key}/claim", new { assignee = "b" })
            );
            Assert.Equal([HttpStatusCode.OK, HttpStatusCode.Conflict], claims.Select(c => c.Status).Order());
            var winner = (string)claims.Single(c => c.Status == HttpStatusCode.OK).Body!["assignee"]!;
            Assert.Equal(winner, (string)(await Send(HttpMethod.Get, $"/api/boards/{slug}/items/{key}")).Body!["assignee"]!);
        }
    }

    [Fact]
    public async Task Twenty_comments_at_once_are_all_kept_in_their_own_places()
    {
        var slug = await Board();
        await Task.WhenAll(
            Enumerable.Range(0, 20).Select(i => Send(HttpMethod.Post, $"/api/boards/{slug}/items/SB-001/comments", new { text = $"c{i}" }))
        );
        var comments = (await Send(HttpMethod.Get, $"/api/boards/{slug}/items/SB-001")).Body!["comments"]!.AsArray();
        Assert.Equal(20, comments.Count);
        Assert.Equal(Enumerable.Range(0, 20).Select(i => $"c{i}").Order(), comments.Select(c => (string)c!["text"]!).Order());

        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<BoardDb>();
        var positions = await db.Comments.Where(c => db.Records.Any(r => r.Id == c.RecordId && r.Key == "SB-001" && db.Boards.Any(b => b.Id == r.BoardId && b.Slug == slug)))
            .Select(c => c.Position)
            .ToListAsync();
        Assert.Equal(Enumerable.Range(0, 20), positions.Order());
    }

    [Fact]
    public async Task A_refused_plan_gives_its_task_keys_back()
    {
        var slug = await Board();
        var refused = await Send(HttpMethod.Post, $"/api/boards/{slug}/plans", new { title = "Bad", tasks = new[] { new { title = "x", blockedBy = new[] { "Task 9" } } } });
        Assert.Equal(HttpStatusCode.BadRequest, refused.Status);
        Assert.Equal("unresolved blockedBy refs", (string)refused.Body!["error"]!);
        var plan = await Send(HttpMethod.Post, $"/api/boards/{slug}/plans", new { title = "Good", tasks = new[] { new { title = "x" } } });
        Assert.Equal("PLAN-003", (string)plan.Body!["id"]!);
        Assert.Equal("TASK-003", (string)plan.Body!["tasks"]![0]!["id"]!);
    }

    [Fact]
    public async Task A_task_list_cannot_take_another_records_key_or_one_key_twice()
    {
        var slug = await Board();
        var stolen = await Send(HttpMethod.Patch, $"/api/boards/{slug}/plans/PLAN-001", new { tasks = new[] { new { id = "TASK-002", title = "x" } } });
        Assert.Equal(HttpStatusCode.BadRequest, stolen.Status);
        Assert.Contains("a task of PLAN-002", (string)stolen.Body!["error"]!);
        var twice = await Send(HttpMethod.Patch, $"/api/boards/{slug}/plans/PLAN-001", new { tasks = new[] { new { id = "TASK-001" }, new { id = "TASK-001" } } });
        Assert.Equal(HttpStatusCode.BadRequest, twice.Status);
        Assert.Equal("TASK-001 is in the tasks list twice", (string)twice.Body!["error"]!);
    }

    [Fact]
    public async Task A_task_key_given_by_hand_never_comes_out_of_the_counter()
    {
        var slug = await Board();
        var patched = await Send(
            HttpMethod.Patch,
            $"/api/boards/{slug}/plans/PLAN-001",
            new { tasks = new object[] { new { id = "TASK-001", title = "A" }, new { id = "TASK-050", title = "By hand" } } }
        );
        Assert.Equal(HttpStatusCode.OK, patched.Status);
        var added = await Send(HttpMethod.Post, $"/api/boards/{slug}/plans/PLAN-001/tasks", new { tasks = new[] { new { title = "Next" } } });
        Assert.Equal("TASK-051", (string)added.Body!["added"]![0]!["id"]!);
    }

    [Fact]
    public async Task A_deleted_key_is_never_given_out_again()
    {
        var slug = await Board();
        var key = (string)(await Send(HttpMethod.Post, $"/api/boards/{slug}/items", new { title = "Short-lived" })).Body!["id"]!;
        Assert.Equal(HttpStatusCode.NoContent, (await Send(HttpMethod.Delete, $"/api/boards/{slug}/items/{key}")).Status);
        var next = (string)(await Send(HttpMethod.Post, $"/api/boards/{slug}/items", new { title = "After" })).Body!["id"]!;
        Assert.Equal("SB-002", key);
        Assert.Equal("SB-003", next);
    }

    [Theory]
    [InlineData("PATCH", "/items/SB-001", """{"prioritty":"high"}""", "Unknown field \"prioritty\" for an item")]
    [InlineData("PATCH", "/designs/SDD-001", """{"stage":"x","owner":"y"}""", "Unknown field \"owner\" for a design")]
    [InlineData("PATCH", "/plans/PLAN-001", """{"tasks":[],"notes":"x"}""", "Unknown field \"notes\" for a plan")]
    [InlineData("PATCH", "/plans/PLAN-001/tasks/TASK-001", """{"title":"x"}""", "Unknown field \"title\" for a task")]
    public async Task A_patch_with_an_unknown_field_changes_nothing(string method, string path, string body, string error)
    {
        var slug = await Board();
        var before = (await Send(HttpMethod.Get, $"/api/boards/{slug}{path.Split("/tasks/")[0]}")).Body!.ToJsonString();
        using var req = new HttpRequestMessage(new HttpMethod(method), $"/api/boards/{slug}{path}")
        {
            Content = new StringContent(body, Encoding.UTF8, "application/json"),
        };
        var res = await _http.SendAsync(req);
        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
        Assert.StartsWith(error, (string)JsonNode.Parse(await res.Content.ReadAsStringAsync())!["error"]!);
        Assert.Equal(before, (await Send(HttpMethod.Get, $"/api/boards/{slug}{path.Split("/tasks/")[0]}")).Body!.ToJsonString());
    }

    [Fact]
    public async Task A_write_to_an_unknown_board_is_404_and_a_body_that_is_not_an_object_is_400()
    {
        Assert.Equal(HttpStatusCode.NotFound, (await Send(HttpMethod.Post, "/api/boards/no-such-board/items", new { title = "x" })).Status);
        var slug = await Board();
        var res = await _http.PostAsync($"/api/boards/{slug}/items", new StringContent("[1]", Encoding.UTF8, "application/json"));
        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
    }

    [Fact]
    public async Task Put_tests_sets_each_list_and_clears_the_lists_that_are_gone()
    {
        var slug = await Board();
        var res = await Send(
            HttpMethod.Put,
            $"/api/boards/{slug}/tests",
            new Dictionary<string, object>
            {
                ["tests"] = new Dictionary<string, object[]>
                {
                    ["DD-001"] = [new { name = "t1" }],
                    ["SDD-001"] = [new { name = "t2" }],
                    ["DD-009"] = [new { name = "archived" }],
                    ["SB-001"] = [new { name = "not a decision" }],
                },
            }
        );
        Assert.Equal(HttpStatusCode.OK, res.Status);
        Assert.Equal("""["DD-001","SDD-001"]""", res.Body!["updated"]!.ToJsonString());
        Assert.Equal("""["DD-002"]""", res.Body!["cleared"]!.ToJsonString());
        Assert.Equal("""["DD-009","SB-001"]""", res.Body!["skipped"]!.ToJsonString());
        Assert.Equal("t1", (string)(await Send(HttpMethod.Get, $"/api/boards/{slug}/items/DD-001")).Body!["tests"]![0]!["name"]!);
        Assert.Equal("t2", (string)(await Send(HttpMethod.Get, $"/api/boards/{slug}/designs/SDD-001")).Body!["tests"]![0]!["name"]!);
        Assert.Null((await Send(HttpMethod.Get, $"/api/boards/{slug}/items/DD-002")).Body!["tests"]);
        Assert.Null((await Send(HttpMethod.Get, $"/api/boards/{slug}/items/SB-001")).Body!["tests"]);

        var again = await Send(HttpMethod.Put, $"/api/boards/{slug}/tests", new { tests = new Dictionary<string, object[]> { ["DD-001"] = [new { name = "t1" }] } });
        Assert.Equal("""["DD-001"]""", again.Body!["unchanged"]!.ToJsonString());
        Assert.Equal("""["SDD-001"]""", again.Body!["cleared"]!.ToJsonString());
    }

    [Fact]
    public async Task An_attachment_uploads_lists_and_serves_at_the_0x_path()
    {
        var slug = await Board();
        var imported = await _http.GetAsync("/attachments/0123456789ab.png");
        Assert.Equal("image/png", imported.Content.Headers.ContentType!.MediaType);
        Assert.Equal("png bytes", await imported.Content.ReadAsStringAsync());

        var up = await _http.PostAsync($"/api/boards/{slug}/attachments?name=Shot.PNG", new ByteArrayContent([1, 2, 3]));
        Assert.Equal(HttpStatusCode.Created, up.StatusCode);
        var body = JsonNode.Parse(await up.Content.ReadAsStringAsync())!;
        var filename = (string)body["filename"]!;
        Assert.Matches("^[0-9a-f]{12}\\.png$", filename);
        Assert.Equal($"/attachments/{filename}", (string)body["url"]!);
        Assert.Equal([1, 2, 3], await _http.GetByteArrayAsync((string)body["url"]!));

        var list = JsonNode.Parse(await _http.GetStringAsync($"/api/boards/{slug}/attachments"))!.AsArray().Select(x => (string)x!).ToList();
        Assert.Equal(new[] { "0123456789ab.png", filename }.Order(StringComparer.Ordinal), list);

        var refused = await _http.PostAsync($"/api/boards/{slug}/attachments?name=notes.txt", new ByteArrayContent([1]));
        Assert.Equal(HttpStatusCode.BadRequest, refused.StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await _http.GetAsync("/attachments/ffffffffffff.png")).StatusCode);
    }

    [Fact]
    public async Task Completing_a_project_closes_its_open_items_and_records_when()
    {
        var slug = await Board();
        var sprint = (string)(await Send(HttpMethod.Post, $"/api/boards/{slug}/sprints", new { name = "P" })).Body!["id"]!;
        await Send(HttpMethod.Post, $"/api/boards/{slug}/sprints/{sprint}/items", new { itemIds = new[] { "SB-001" } });
        var done = await Send(HttpMethod.Patch, $"/api/boards/{slug}/sprints/{sprint}", new { status = "completed" });
        Assert.NotNull((string?)done.Body!["completedAt"]);
        var item = (await Send(HttpMethod.Get, $"/api/boards/{slug}/items/SB-001")).Body!;
        Assert.Equal("done", (string)item["stage"]!);
        Assert.NotNull((string?)item["doneAt"]);
    }
}
