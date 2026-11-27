using System.Net;
using System.Net.Http.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Mvc.Testing;
using PmBoard.Api.Boards;

namespace PmBoard.Api.Tests;

/// <summary>PATCH /api/boards/{slug}: a board can be renamed, and its old slug stays an alias (DD-035).</summary>
public class BoardRenameTests(BoardFactory factory) : IClassFixture<BoardFactory>
{
    private static string NewSlug() => "rn-" + Guid.NewGuid().ToString("N")[..8];

    private async Task<(HttpClient Http, string Slug)> NewBoard(string name = "Old Name")
    {
        var http = await factory.Writer();
        var slug = NewSlug();
        Assert.Equal(HttpStatusCode.Created, (await http.PostAsJsonAsync("/api/boards", new { slug, name })).StatusCode);
        return (http, slug);
    }

    private static async Task<(HttpStatusCode Status, JsonNode? Body, string? Header)> Rename(HttpClient http, string slug, object body)
    {
        var res = await http.PatchAsJsonAsync($"/api/boards/{slug}", body);
        var text = await res.Content.ReadAsStringAsync();
        return (res.StatusCode, text.Length > 0 ? JsonNode.Parse(text) : null, Header(res));
    }

    private static string? Header(HttpResponseMessage res) =>
        res.Headers.TryGetValues(BoardAliases.Header, out var v) ? string.Join(",", v) : null;

    private static List<string> Aliases(JsonNode? body) => body!["aliases"]!.AsArray().Select(a => (string)a!).ToList();

    [Fact]
    public async Task A_new_slug_answers_and_the_old_one_answers_as_an_alias_with_the_header()
    {
        var (http, old) = await NewBoard();
        await http.PostAsJsonAsync($"/api/boards/{old}/items", new { type = "issue", title = "Kept" });
        var slug = NewSlug();

        var (status, body, _) = await Rename(http, old, new { slug });
        Assert.Equal(HttpStatusCode.OK, status);
        Assert.Equal(slug, (string)body!["slug"]!);
        Assert.Equal("Old Name", (string)body["name"]!);
        Assert.Equal([old], Aliases(body));

        var viaNew = await http.GetAsync($"/api/boards/{slug}/items/SB-001");
        Assert.Equal(HttpStatusCode.OK, viaNew.StatusCode);
        Assert.Null(Header(viaNew));
        var viaOld = await http.GetAsync($"/api/boards/{old}/items/SB-001");
        Assert.Equal(HttpStatusCode.OK, viaOld.StatusCode);
        Assert.Equal(slug, Header(viaOld));
        Assert.Equal("Kept", (string)(await viaOld.Content.ReadFromJsonAsync<JsonObject>())!["title"]!);

        var boards = (await http.GetFromJsonAsync<JsonArray>("/api/boards"))!.Select(b => (string)b!["slug"]!).ToList();
        Assert.Contains(slug, boards);
        Assert.DoesNotContain(old, boards);
    }

    [Fact]
    public async Task A_name_only_rename_keeps_the_slug_and_makes_no_alias()
    {
        var (http, slug) = await NewBoard();
        var (status, body, header) = await Rename(http, slug, new { name = "  Makron " });
        Assert.Equal(HttpStatusCode.OK, status);
        Assert.Equal(slug, (string)body!["slug"]!);
        Assert.Equal("Makron", (string)body["name"]!);
        Assert.Empty(Aliases(body));
        Assert.Null(header);
        Assert.Equal("Makron", (string)(await http.GetFromJsonAsync<JsonObject>($"/api/boards/{slug}/config"))!["name"]!);
    }

    [Fact]
    public async Task Slug_and_name_change_in_one_write()
    {
        var (http, old) = await NewBoard();
        var slug = NewSlug();
        var (status, body, _) = await Rename(http, old, new { slug, name = "Makron" });
        Assert.Equal(HttpStatusCode.OK, status);
        Assert.Equal("Makron", (string)(await http.GetFromJsonAsync<JsonObject>($"/api/boards/{old}/config"))!["name"]!);
        Assert.Equal(slug, (string)body!["slug"]!);
    }

    [Fact]
    public async Task A_write_through_the_alias_lands_on_the_board()
    {
        var (http, old) = await NewBoard();
        var slug = NewSlug();
        await Rename(http, old, new { slug });

        var created = await http.PostAsJsonAsync($"/api/boards/{old}/items", new { type = "issue", title = "Through the alias" });
        Assert.Equal(HttpStatusCode.Created, created.StatusCode);
        Assert.Equal(slug, Header(created));
        var patched = await http.PatchAsJsonAsync($"/api/boards/{old}/items/SB-001", new { stage = "done" });
        Assert.Equal(HttpStatusCode.OK, patched.StatusCode);

        var item = await http.GetFromJsonAsync<JsonObject>($"/api/boards/{slug}/items/SB-001");
        Assert.Equal("Through the alias", (string)item!["title"]!);
        Assert.Equal("done", (string)item["stage"]!);
    }

    [Fact]
    public async Task Every_old_slug_of_a_board_leads_to_its_slug_now()
    {
        var (http, a) = await NewBoard();
        var b = NewSlug();
        var c = NewSlug();
        await Rename(http, a, new { slug = b });
        var (_, body, header) = await Rename(http, a, new { slug = c });
        Assert.Equal(c, header); // renamed through an alias: the header names the slug after the rename
        Assert.Equal(new[] { a, b }.Order(StringComparer.Ordinal), Aliases(body));
        foreach (var old in new[] { a, b })
        {
            Assert.Equal(c, Header(await http.GetAsync($"/api/boards/{old}/config")));
        }
    }

    [Fact]
    public async Task A_slug_another_board_has_is_409_and_nothing_changes()
    {
        var (http, slug) = await NewBoard();
        var (_, other) = await NewBoard();

        var (status, body, _) = await Rename(http, slug, new { slug = other, name = "Changed" });
        Assert.Equal(HttpStatusCode.Conflict, status);
        Assert.Equal($"board {other} already exists", (string)body!["error"]!);
        Assert.Equal("Old Name", (string)(await http.GetFromJsonAsync<JsonObject>($"/api/boards/{slug}/config"))!["name"]!);
    }

    [Fact]
    public async Task A_slug_that_is_another_boards_alias_is_409()
    {
        var (http, slug) = await NewBoard();
        var (_, otherOld) = await NewBoard();
        var otherNew = NewSlug();
        await Rename(http, otherOld, new { slug = otherNew });

        var (status, body, _) = await Rename(http, slug, new { slug = otherOld });
        Assert.Equal(HttpStatusCode.Conflict, status);
        Assert.Equal($"{otherOld} is an old slug of board {otherNew}, and it still leads there", (string)body!["error"]!);
        Assert.Equal(otherNew, Header(await http.GetAsync($"/api/boards/{otherOld}/config")));
        Assert.Equal(HttpStatusCode.OK, (await http.GetAsync($"/api/boards/{slug}/config")).StatusCode);
    }

    [Fact]
    public async Task A_rename_back_to_an_old_slug_moves_the_alias()
    {
        var (http, a) = await NewBoard();
        var b = NewSlug();
        await Rename(http, a, new { slug = b });

        var (status, body, _) = await Rename(http, b, new { slug = a });
        Assert.Equal(HttpStatusCode.OK, status);
        Assert.Equal(a, (string)body!["slug"]!);
        Assert.Equal([b], Aliases(body));
        Assert.Null(Header(await http.GetAsync($"/api/boards/{a}/config")));
        Assert.Equal(a, Header(await http.GetAsync($"/api/boards/{b}/config")));
    }

    [Fact]
    public async Task A_new_board_cannot_take_an_alias()
    {
        var (http, old) = await NewBoard();
        var slug = NewSlug();
        await Rename(http, old, new { slug });

        var res = await http.PostAsJsonAsync("/api/boards", new { slug = old, name = "Second" });
        Assert.Equal(HttpStatusCode.Conflict, res.StatusCode);
        Assert.Equal($"{old} is an old slug of board {slug}, and it still leads there", (string)(await res.Content.ReadFromJsonAsync<JsonObject>())!["error"]!);
        Assert.Equal("Old Name", (string)(await http.GetFromJsonAsync<JsonObject>($"/api/boards/{old}/config"))!["name"]!);
    }

    [Theory]
    [InlineData("""{"slug":"x-ok","stages":["a"]}""", "unknown field \"stages\"; a rename takes slug and name")]
    [InlineData("{}", "a rename takes slug, name or both")]
    [InlineData("""{"slug":"Upper"}""", "slug must be")]
    [InlineData("""{"slug":"api"}""", "slug must be")]
    [InlineData("""{"slug":null}""", "slug must be")]
    [InlineData("""{"name":"  "}""", "name must be text that is not blank")]
    [InlineData("[]", "the body is not a JSON object")]
    public async Task A_bad_rename_is_400_and_nothing_changes(string json, string error)
    {
        var (http, slug) = await NewBoard();
        var res = await http.PatchAsync($"/api/boards/{slug}", new StringContent(json, System.Text.Encoding.UTF8, "application/json"));
        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
        Assert.StartsWith(error, (string)(await res.Content.ReadFromJsonAsync<JsonObject>())!["error"]!);
        Assert.Equal("Old Name", (string)(await http.GetFromJsonAsync<JsonObject>($"/api/boards/{slug}/config"))!["name"]!);
    }

    [Fact]
    public async Task A_rename_of_a_board_that_does_not_exist_is_404()
    {
        var (status, _, _) = await Rename(await factory.Writer(), NewSlug(), new { name = "X" });
        Assert.Equal(HttpStatusCode.NotFound, status);
    }

    [Fact]
    public async Task A_rename_with_no_token_is_401()
    {
        var (http, slug) = await NewBoard();
        var res = await factory.CreateClient().PatchAsJsonAsync($"/api/boards/{slug}", new { name = "X" });
        Assert.Equal(HttpStatusCode.Unauthorized, res.StatusCode);
        Assert.Equal("Old Name", (string)(await http.GetFromJsonAsync<JsonObject>($"/api/boards/{slug}/config"))!["name"]!);
    }

    [Fact]
    public async Task The_dashboard_at_an_old_slug_redirects_to_the_slug_now()
    {
        var (http, old) = await NewBoard();
        var slug = NewSlug();
        await Rename(http, old, new { slug });
        var browser = factory.CreateClient(new WebApplicationFactoryClientOptions { AllowAutoRedirect = false });

        foreach (var (path, to) in new[] { ($"/{old}", $"/{slug}"), ($"/{old}/PLAN-004?x=1", $"/{slug}/PLAN-004?x=1") })
        {
            var res = await browser.GetAsync(path);
            Assert.Equal(HttpStatusCode.Found, res.StatusCode);
            Assert.Equal(to, res.Headers.Location!.OriginalString);
        }
        var page = await browser.GetAsync($"/{slug}");
        Assert.Equal(HttpStatusCode.OK, page.StatusCode);
        Assert.Equal(BoardFactory.IndexHtml, await page.Content.ReadAsStringAsync());
    }
}
