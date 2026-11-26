using System.Net;
using System.Net.Http.Json;
using System.Text.Json.Nodes;
using Microsoft.Extensions.DependencyInjection;
using PmBoard.Api.Boards;
using PmBoard.Api.Data;
using PmBoard.Api.Import;

namespace PmBoard.Api.Tests;

/// <summary>
/// DD-030: a body write can never lose text. Prepend and append run on the server, and a replace of
/// a body with text names the body it replaces (bodyBase) or says force.
/// </summary>
public class BodyGuardTests(BoardFactory factory) : IClassFixture<BoardFactory>, IAsyncLifetime
{
    private HttpClient _http = null!;

    public async Task InitializeAsync() => _http = await factory.Writer();

    public Task DisposeAsync() => Task.CompletedTask;

    /// <summary>SB-001 has a body, SB-002 has none. The design and the project have bodies too.</summary>
    private async Task<string> Board()
    {
        var slug = "body-" + Guid.NewGuid().ToString("N")[..8];
        var dump = JsonNode.Parse(
            $$"""
            {
              "format": "pm-v0-export",
              "board": { "slug": "{{slug}}", "name": "Body test", "config": { "stages": ["inbox", "done"] } },
              "items": [
                { "id": "SB-001", "type": "issue", "title": "Filled", "stage": "inbox", "body": "First line.\n" },
                { "id": "SB-002", "type": "issue", "title": "Empty", "stage": "inbox" }
              ],
              "designs": [ { "id": "SDD-001", "title": "Design", "stage": "sdd", "body": "Design body" } ],
              "plans": [],
              "sprints": [ { "id": "SPRINT-001", "name": "P", "status": "active", "body": "Project body", "itemIds": [] } ],
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

    private async Task<(HttpStatusCode Status, JsonNode? Body)> Send(HttpMethod method, string path, object? body = null)
    {
        using var req = new HttpRequestMessage(method, path);
        if (body is not null) req.Content = JsonContent.Create(body);
        var res = await _http.SendAsync(req);
        var text = await res.Content.ReadAsStringAsync();
        return (res.StatusCode, text.Length > 0 ? JsonNode.Parse(text) : null);
    }

    private Task<(HttpStatusCode Status, JsonNode? Body)> Patch(string slug, string path, object body) =>
        Send(HttpMethod.Patch, $"/api/boards/{slug}{path}", body);

    private async Task<string?> BodyOf(string slug, string path) => (string?)(await Send(HttpMethod.Get, $"/api/boards/{slug}{path}")).Body!["body"];

    [Theory]
    [InlineData("", "e3b0c44298fc")]
    [InlineData("Blåbær ✓", "652e8ec72474")]
    [InlineData("Blåbær\r\nline2 ✓", "5550bf7b709e")]
    [InlineData("First line.\n", "a3a433f4d36f")]
    public void The_hash_is_12_hex_characters_of_the_sha256_of_the_utf8_body(string body, string hash) =>
        Assert.Equal(hash, BodyGuard.Hash(body));

    [Fact]
    public async Task Prepend_and_append_keep_the_body_and_join_with_one_blank_line()
    {
        var slug = await Board();
        Assert.Equal(HttpStatusCode.OK, (await Patch(slug, "/items/SB-001", new { bodyPrepend = "Superseded." })).Status);
        var appended = await Patch(slug, "/items/SB-001", new { bodyAppend = "Last line." });
        Assert.Equal(HttpStatusCode.OK, appended.Status);
        Assert.Equal("Superseded.\n\nFirst line.\n\nLast line.", (string)appended.Body!["body"]!);
        Assert.Equal("Superseded.\n\nFirst line.\n\nLast line.", await BodyOf(slug, "/items/SB-001"));
    }

    [Fact]
    public async Task Prepend_and_append_on_an_empty_body_write_the_text_alone()
    {
        var slug = await Board();
        await Patch(slug, "/items/SB-002", new { bodyAppend = "Only." });
        Assert.Equal("Only.", await BodyOf(slug, "/items/SB-002"));
        var key = (string)(await Send(HttpMethod.Post, $"/api/boards/{slug}/items", new { title = "New" })).Body!["id"]!;
        await Patch(slug, $"/items/{key}", new { bodyPrepend = "Top." });
        Assert.Equal("Top.", await BodyOf(slug, $"/items/{key}"));
    }

    [Theory]
    [InlineData("/items/SB-001", "First line.\n")]
    [InlineData("/designs/SDD-001", "Design body")]
    [InlineData("/sprints/SPRINT-001", "Project body")]
    public async Task A_replace_with_no_base_is_409_with_the_hash_and_changes_nothing(string path, string body)
    {
        var slug = await Board();
        var refused = await Patch(slug, path, new { body = "New" });
        Assert.Equal(HttpStatusCode.Conflict, refused.Status);
        Assert.Equal(BodyGuard.Hash(body), (string)refused.Body!["bodyHash"]!);
        var error = (string)refused.Body!["error"]!;
        Assert.Contains("--base", error);
        Assert.Contains("--force", error);
        Assert.Contains("pm update", error);
        Assert.Equal(body, await BodyOf(slug, path));
    }

    [Fact]
    public async Task A_replace_with_a_wrong_base_is_409_and_changes_nothing()
    {
        var slug = await Board();
        var refused = await Patch(slug, "/items/SB-001", new { body = "New", bodyBase = "000000000000", title = "Renamed" });
        Assert.Equal(HttpStatusCode.Conflict, refused.Status);
        Assert.Equal(BodyGuard.Hash("First line.\n"), (string)refused.Body!["bodyHash"]!);
        Assert.Contains("changed since you read it", (string)refused.Body!["error"]!);
        var item = (await Send(HttpMethod.Get, $"/api/boards/{slug}/items/SB-001")).Body!;
        Assert.Equal("First line.\n", (string)item["body"]!);
        Assert.Equal("Filled", (string)item["title"]!);
    }

    [Theory]
    [InlineData("/items/SB-001", "First line.\n")]
    [InlineData("/designs/SDD-001", "Design body")]
    [InlineData("/sprints/SPRINT-001", "Project body")]
    public async Task A_replace_with_the_right_base_or_force_writes_the_body(string path, string body)
    {
        var slug = await Board();
        Assert.Equal(HttpStatusCode.OK, (await Patch(slug, path, new { body = "Second", bodyBase = BodyGuard.Hash(body) })).Status);
        Assert.Equal("Second", await BodyOf(slug, path));
        Assert.Equal(HttpStatusCode.OK, (await Patch(slug, path, new { body = "Third", force = true })).Status);
        Assert.Equal("Third", await BodyOf(slug, path));
    }

    [Fact]
    public async Task A_right_base_in_uppercase_writes_the_body()
    {
        var slug = await Board();
        var upper = BodyGuard.Hash("First line.\n").ToUpperInvariant();
        Assert.Equal(HttpStatusCode.OK, (await Patch(slug, "/items/SB-001", new { body = "Second", bodyBase = upper })).Status);
        Assert.Equal("Second", await BodyOf(slug, "/items/SB-001"));
    }

    [Theory]
    [InlineData("abc")]
    [InlineData("e3b0c44298fc1")]
    [InlineData("g3b0c44298fc")]
    [InlineData("")]
    public async Task A_base_that_is_not_a_hash_is_400_and_says_so(string bodyBase)
    {
        var slug = await Board();
        var refused = await Patch(slug, "/items/SB-001", new { body = "New", bodyBase });
        Assert.Equal(HttpStatusCode.BadRequest, refused.Status);
        Assert.Contains("is not a bodyHash", (string)refused.Body!["error"]!);
        Assert.Equal("First line.\n", await BodyOf(slug, "/items/SB-001"));
    }

    [Fact]
    public async Task A_replace_of_an_empty_body_needs_no_base()
    {
        var slug = await Board();
        Assert.Equal(HttpStatusCode.OK, (await Patch(slug, "/items/SB-002", new { body = "Written" })).Status);
        Assert.Equal("Written", await BodyOf(slug, "/items/SB-002"));
    }

    [Theory]
    [InlineData("""{"body":"x","bodyAppend":"y"}""")]
    [InlineData("""{"body":"x","bodyPrepend":"y","force":true}""")]
    [InlineData("""{"bodyAppend":""}""")]
    [InlineData("""{"bodyPrepend":3}""")]
    [InlineData("""{"bodyBase":"e3b0c44298fc"}""")]
    [InlineData("""{"body":"x","force":"yes"}""")]
    public async Task A_body_request_that_does_not_add_up_is_400(string json)
    {
        var slug = await Board();
        using var req = new HttpRequestMessage(HttpMethod.Patch, $"/api/boards/{slug}/items/SB-001")
        {
            Content = new StringContent(json, System.Text.Encoding.UTF8, "application/json"),
        };
        Assert.Equal(HttpStatusCode.BadRequest, (await _http.SendAsync(req)).StatusCode);
        Assert.Equal("First line.\n", await BodyOf(slug, "/items/SB-001"));
    }

    [Fact]
    public async Task Of_parallel_replaces_with_one_base_exactly_one_wins()
    {
        var slug = await Board();
        for (var round = 0; round < 5; round++)
        {
            var before = await BodyOf(slug, "/items/SB-001");
            var hash = BodyGuard.Hash(before);
            var writes = await Task.WhenAll(
                Enumerable.Range(0, 4).Select(i => Patch(slug, "/items/SB-001", new { body = $"Round {round} writer {i}", bodyBase = hash }))
            );
            Assert.Single(writes, x => x.Status == HttpStatusCode.OK);
            Assert.All(writes.Where(x => x.Status != HttpStatusCode.OK), x => Assert.Equal(HttpStatusCode.Conflict, x.Status));
            var winner = (string)writes.Single(x => x.Status == HttpStatusCode.OK).Body!["body"]!;
            Assert.Equal(winner, await BodyOf(slug, "/items/SB-001"));
            Assert.All(writes.Where(x => x.Status == HttpStatusCode.Conflict), x => Assert.Equal(BodyGuard.Hash(winner), (string)x.Body!["bodyHash"]!));
        }
    }

    [Fact]
    public async Task Parallel_appends_keep_every_block()
    {
        var slug = await Board();
        await Task.WhenAll(Enumerable.Range(0, 10).Select(i => Patch(slug, "/items/SB-001", new { bodyAppend = $"block {i}" })));
        var body = (await BodyOf(slug, "/items/SB-001"))!;
        Assert.StartsWith("First line.", body);
        Assert.All(Enumerable.Range(0, 10), i => Assert.Contains($"block {i}", body));
    }
}
