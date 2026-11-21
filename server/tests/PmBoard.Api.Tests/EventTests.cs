using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using PmBoard.Api.Boards;
using PmBoard.Api.Data;
using PmBoard.Api.Import;

namespace PmBoard.Api.Tests;

public class EventTests(BoardFactory factory) : IClassFixture<BoardFactory>
{
    private async Task<string> Board()
    {
        var slug = "events-" + Guid.NewGuid().ToString("N")[..8];
        var dump = JsonNode.Parse(
            $$"""
            { "format": "pm-v0-export", "board": { "slug": "{{slug}}", "name": "E", "config": {} },
              "items": [ { "id": "SB-001", "type": "issue", "title": "One", "stage": "inbox" } ],
              "designs": [], "sprints": [], "milestones": [],
              "plans": [ { "id": "PLAN-001", "title": "P", "tasks": [ { "id": "TASK-001", "title": "T", "status": "pending" } ] } ],
              "archive": { "items": [], "designs": [], "archivedAt": {} }, "quarantined": [], "notRead": [] }
            """
        )!;
        using var scope = factory.Services.CreateScope();
        await new V0Importer(scope.ServiceProvider.GetRequiredService<BoardDb>()).ImportAsync(dump);
        return slug;
    }

    /// <summary>Opens the board's event stream and returns a reader for its data lines.</summary>
    private async Task<(StreamReader Reader, HttpResponseMessage Res)> Open(string slug)
    {
        var events = factory.Services.GetRequiredService<BoardEvents>();
        for (var i = 0; i < 100 && !events.Listening; i++) await Task.Delay(50);
        Assert.True(events.Listening);
        var client = factory.CreateClient();
        var res = await client.SendAsync(
            new HttpRequestMessage(HttpMethod.Get, $"/api/boards/{slug}/events"),
            HttpCompletionOption.ResponseHeadersRead
        );
        Assert.Equal("text/event-stream", res.Content.Headers.ContentType?.MediaType);
        var reader = new StreamReader(await res.Content.ReadAsStreamAsync());
        Assert.Equal(": connected", await reader.ReadLineAsync());
        return (reader, res);
    }

    /// <summary>
    /// The next event. The import's own create events can reach a stream opened right after it (the
    /// listener gets them a moment after the commit), and no test here makes a record, so they are
    /// passed over.
    /// </summary>
    private static async Task<JsonNode> Next(StreamReader reader)
    {
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        while (true)
        {
            var line = await reader.ReadLineAsync(cts.Token);
            if (line is null || !line.StartsWith("data: ")) continue;
            var e = JsonNode.Parse(line["data: ".Length..])!;
            if ((string?)e["action"] != "create") return e;
        }
    }

    private async Task Sql(string sql, params object[] args)
    {
        using var scope = factory.Services.CreateScope();
        await scope.ServiceProvider.GetRequiredService<BoardDb>().Database.ExecuteSqlRawAsync(sql, args);
    }

    private static string Event(JsonNode e) => $"{e["entity"]} {e["id"]} {e["action"]}";

    [Fact]
    public async Task A_change_made_anywhere_in_the_database_reaches_the_stream_in_0x_shape()
    {
        var slug = await Board();
        var (reader, res) = await Open(slug);
        using (res)
        {
            await Sql("UPDATE records SET title = 'Renamed' WHERE key = 'SB-001' AND board_id = (SELECT id FROM boards WHERE slug = {0})", slug);
            Assert.Equal("item SB-001 update", Event(await Next(reader)));
        }
    }

    [Fact]
    public async Task A_task_change_is_its_plan_update_and_archiving_is_archive()
    {
        var slug = await Board();
        var (reader, res) = await Open(slug);
        using (res)
        {
            await Sql("UPDATE records SET status = 'done' WHERE key = 'TASK-001' AND board_id = (SELECT id FROM boards WHERE slug = {0})", slug);
            Assert.Equal("plan PLAN-001 update", Event(await Next(reader)));
            await Sql("UPDATE records SET archived_at = now() WHERE key = 'SB-001' AND board_id = (SELECT id FROM boards WHERE slug = {0})", slug);
            Assert.Equal("item SB-001 archive", Event(await Next(reader)));
        }
    }

    [Fact]
    public async Task A_new_comment_is_an_update_of_its_record()
    {
        var slug = await Board();
        var (reader, res) = await Open(slug);
        using (res)
        {
            await Sql(
                "INSERT INTO comments (id, record_id, kind, text, position) SELECT gen_random_uuid(), id, 'comment', 'hi', 0 FROM records WHERE key = 'SB-001' AND board_id = (SELECT id FROM boards WHERE slug = {0})",
                slug
            );
            Assert.Equal("item SB-001 update", Event(await Next(reader)));
        }
    }

    [Fact]
    public async Task A_stream_hears_only_its_own_board()
    {
        var mine = await Board();
        var other = await Board();
        var (reader, res) = await Open(mine);
        using (res)
        {
            await Sql("UPDATE records SET title = 'x' WHERE key = 'SB-001' AND board_id = (SELECT id FROM boards WHERE slug = {0})", other);
            await Sql("UPDATE records SET title = 'y' WHERE key = 'PLAN-001' AND board_id = (SELECT id FROM boards WHERE slug = {0})", mine);
            Assert.Equal("plan PLAN-001 update", Event(await Next(reader)));
        }
    }

    [Fact]
    public async Task An_unknown_board_has_no_stream()
    {
        var res = await factory.CreateClient().GetAsync("/api/boards/no-such-board/events");
        Assert.Equal(System.Net.HttpStatusCode.NotFound, res.StatusCode);
    }
}
