using System.Net;
using System.Net.Http.Json;
using System.Text.Json.Nodes;
using Microsoft.Extensions.DependencyInjection;
using PmBoard.Api.Boards;
using PmBoard.Api.Data;
using PmBoard.Api.Import;

namespace PmBoard.Api.Tests;

/// <summary>
/// Boards/Glossary.cs finds what shared/glossary.js finds (DD-029). shared/glossary-cases.json holds
/// the JS answers; shared/glossary.test.mjs checks that the JS still gives them.
/// </summary>
public class GlossaryTests(BoardFactory factory) : IClassFixture<BoardFactory>
{
    private static JsonObject Cases() =>
        JsonNode.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "glossary-cases.json")))!.AsObject();

    private static JsonObject Shape(Glossary.Match m) =>
        new()
        {
            ["start"] = m.Start,
            ["end"] = m.End,
            ["text"] = m.Text,
            ["termId"] = m.Term.Id,
            ["title"] = m.Term.Title,
            ["kind"] = m.Term.Kind,
            ["targets"] = new JsonArray(m.Term.Targets.Select(t => (JsonNode)t).ToArray()),
            ["targetTitles"] = new JsonArray(m.Term.TargetTitles.Select(t => (JsonNode)t).ToArray()),
        };

    public static TheoryData<int> CaseNumbers() => [.. Enumerable.Range(0, Cases()["cases"]!.AsArray().Count)];

    [Theory]
    [MemberData(nameof(CaseNumbers))]
    public void Every_case_matches_as_the_js_does(int n)
    {
        var cases = Cases();
        var index = Glossary.Build(cases["terms"]!.AsArray().Select(t => t!.AsObject()));
        var c = cases["cases"]![n]!;
        var found = new JsonArray(Glossary.FindTermMatches((string)c["text"]!, index).Select(m => (JsonNode)Shape(m)).ToArray());
        Assert.True(JsonNode.DeepEquals(c["expect"], found), $"{(string)c["text"]!}\nJS: {c["expect"]!.ToJsonString()}\nC#: {found.ToJsonString()}");
    }

    private async Task<string> Board()
    {
        var slug = "glossary-" + Guid.NewGuid().ToString("N")[..8];
        var dump = JsonNode.Parse(
            $$"""
            {
              "format": "pm-v0-export",
              "board": { "slug": "{{slug}}", "name": "Glossary test", "config": {} },
              "items": [
                { "id": "TERM-001", "type": "term", "title": "board", "stage": "inbox", "body": "One repo's whole board.", "aliases": ["boards"] },
                { "id": "TERM-002", "type": "term", "title": "project", "stage": "inbox", "body": "A SPRINT-NNN record." },
                { "id": "TERM-003", "type": "term", "title": "workspace", "stage": "inbox", "related": ["TERM-001", "TERM-002"] },
                { "id": "TERM-004", "type": "term", "title": "archived word", "stage": "done" },
                { "id": "SB-001", "type": "issue", "title": "board", "stage": "inbox" }
              ],
              "designs": [], "plans": [], "sprints": [], "milestones": [],
              "archive": { "items": [ { "id": "TERM-005", "type": "term", "title": "gone", "stage": "done" } ], "designs": [],
                           "archivedAt": { "TERM-005": "2026-02-01T00:00:00.000Z" } },
              "quarantined": [], "sidecarTests": {}, "notRead": [], "attachments": []
            }
            """
        )!;
        using var scope = factory.Services.CreateScope();
        await new V0Importer(scope.ServiceProvider.GetRequiredService<BoardDb>()).ImportAsync(dump);
        return slug;
    }

    [Fact]
    public async Task The_route_answers_the_first_match_of_each_term_in_text_order_with_no_token()
    {
        var slug = await Board();
        var res = await factory.CreateClient()
            .PostAsJsonAsync($"/api/boards/{slug}/glossary/match", new { text = "A workspace holds boards; each board has a project. Nothing is gone." });
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        var found = JsonNode.Parse(await res.Content.ReadAsStringAsync())!.AsArray();
        Assert.Equal(
            """[{"termId":"TERM-003","title":"workspace","kind":"signpost","targets":["TERM-001","TERM-002"],"targetTitles":["board","project"],"text":"workspace"},"""
                + """{"termId":"TERM-001","title":"board","kind":"term","targets":[],"targetTitles":[],"text":"boards"},"""
                + """{"termId":"TERM-002","title":"project","kind":"term","targets":[],"targetTitles":[],"text":"project"}]""",
            found.ToJsonString()
        );
    }

    [Fact]
    public async Task A_text_with_no_terms_is_an_empty_list()
    {
        var slug = await Board();
        var res = await factory.CreateClient().PostAsJsonAsync($"/api/boards/{slug}/glossary/match", new { text = "" });
        Assert.Equal("[]", await res.Content.ReadAsStringAsync());
    }

    [Theory]
    [InlineData("""{"text": 5}""")]
    [InlineData("""{}""")]
    [InlineData("""[]""")]
    [InlineData("""not json""")]
    public async Task A_body_without_a_text_is_400(string body)
    {
        var slug = await Board();
        var res = await factory.CreateClient()
            .PostAsync($"/api/boards/{slug}/glossary/match", new StringContent(body, System.Text.Encoding.UTF8, "application/json"));
        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
    }

    [Fact]
    public async Task An_unknown_board_is_404()
    {
        var res = await factory.CreateClient().PostAsJsonAsync("/api/boards/no-such-board/glossary/match", new { text = "board" });
        Assert.Equal(HttpStatusCode.NotFound, res.StatusCode);
    }
}
