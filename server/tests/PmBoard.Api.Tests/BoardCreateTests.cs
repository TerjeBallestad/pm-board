using System.Net;
using System.Net.Http.Json;
using System.Text.Json.Nodes;

namespace PmBoard.Api.Tests;

/// <summary>POST /api/boards, for `pm init &lt;slug&gt;` (DD-021).</summary>
public class BoardCreateTests(BoardFactory factory) : IClassFixture<BoardFactory>
{
    private static string NewSlug() => "init-" + Guid.NewGuid().ToString("N")[..8];

    private static async Task<(HttpStatusCode Status, JsonNode? Body)> Post(HttpClient http, object body)
    {
        var res = await http.PostAsJsonAsync("/api/boards", body);
        var text = await res.Content.ReadAsStringAsync();
        return (res.StatusCode, text.Length > 0 ? JsonNode.Parse(text) : null);
    }

    [Fact]
    public async Task A_new_board_has_0x_default_config_and_its_first_item_is_SB_001()
    {
        var http = await factory.Writer();
        var slug = NewSlug();

        var (status, body) = await Post(http, new { slug, name = "My Repo" });
        Assert.Equal(HttpStatusCode.Created, status);
        Assert.Equal(slug, (string)body!["slug"]!);
        Assert.Equal("My Repo", (string)body["name"]!);

        var cfg = await http.GetFromJsonAsync<JsonObject>($"/api/boards/{slug}/config");
        Assert.Equal("My Repo", (string)cfg!["name"]!);
        Assert.Equal(["inbox", "exploring", "sdd", "planned", "done"], cfg["stages"]!.AsArray().Select(s => (string)s!));
        Assert.Equal("Work the PM ticket {id}: {title}", (string)cfg["commands"]!["ticket"]!["default"]!);
        Assert.Equal("qmd query", (string)cfg["knowledgeBase"]!["command"]!);
        Assert.Contains(slug, (await http.GetFromJsonAsync<JsonArray>("/api/boards"))!.Select(b => (string)b!["slug"]!));

        var item = await http.PostAsJsonAsync($"/api/boards/{slug}/items", new { type = "issue", title = "First" });
        Assert.Equal(HttpStatusCode.Created, item.StatusCode);
        Assert.Equal("SB-001", (string)(await item.Content.ReadFromJsonAsync<JsonObject>())!["id"]!);
    }

    [Fact]
    public async Task A_board_with_no_name_is_named_after_its_slug()
    {
        var slug = NewSlug();
        var (status, body) = await Post(await factory.Writer(), new { slug });
        Assert.Equal(HttpStatusCode.Created, status);
        Assert.Equal(slug, (string)body!["name"]!);
    }

    [Fact]
    public async Task A_taken_slug_is_409_and_the_board_is_unchanged()
    {
        var http = await factory.Writer();
        var slug = NewSlug();
        await Post(http, new { slug, name = "First" });

        var (status, body) = await Post(http, new { slug, name = "Second" });
        Assert.Equal(HttpStatusCode.Conflict, status);
        Assert.Equal($"board {slug} already exists", (string)body!["error"]!);
        Assert.Equal("First", (string)(await http.GetFromJsonAsync<JsonObject>($"/api/boards/{slug}/config"))!["name"]!);
    }

    [Theory]
    [InlineData("")]
    [InlineData("Upper")]
    [InlineData("-dash-first")]
    [InlineData("has space")]
    [InlineData("api")]
    [InlineData("attachments")]
    public async Task A_bad_or_reserved_slug_is_400(string slug)
    {
        var (status, body) = await Post(await factory.Writer(), new { slug });
        Assert.Equal(HttpStatusCode.BadRequest, status);
        Assert.StartsWith("slug must be", (string)body!["error"]!);
    }

    [Fact]
    public async Task An_unknown_field_or_a_missing_slug_is_400()
    {
        var http = await factory.Writer();
        Assert.Equal(HttpStatusCode.BadRequest, (await Post(http, new { slug = NewSlug(), stages = new[] { "a" } })).Status);
        Assert.Equal(HttpStatusCode.BadRequest, (await Post(http, new { name = "No slug" })).Status);
    }

    [Fact]
    public async Task A_board_create_with_no_token_is_401()
    {
        var res = await factory.CreateClient().PostAsJsonAsync("/api/boards", new { slug = NewSlug() });
        Assert.Equal(HttpStatusCode.Unauthorized, res.StatusCode);
    }
}
