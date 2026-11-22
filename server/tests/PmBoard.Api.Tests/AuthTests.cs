using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Routing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using PmBoard.Api.Auth;
using PmBoard.Api.Data;
using PmBoard.Api.Import;

namespace PmBoard.Api.Tests;

/// <summary>Token auth for writes (DD-003, DD-020). Reads need no token.</summary>
public class AuthTests(BoardFactory factory) : IClassFixture<BoardFactory>
{
    /// <summary>The POST routes that change nothing. They stay open, as reads (DD-020).</summary>
    private static readonly string[] OpenPosts =
    [
        "/api/boards/{slug}/sprints/{key}/suggest",
        "/api/boards/{slug}/sprints/{key}/explore",
        "/api/boards/{slug}/context/prompt",
        "/api/boards/{slug}/context/review",
        "/api/boards/{slug}/glossary/match", // DD-029
    ];

    private async Task<string> Board()
    {
        var slug = "auth-" + Guid.NewGuid().ToString("N")[..8];
        var dump = JsonNode.Parse(
            $$"""
            {
              "format": "pm-v0-export",
              "board": { "slug": "{{slug}}", "name": "Auth test", "config": { "stages": ["inbox", "done"] } },
              "items": [ { "id": "SB-001", "type": "issue", "title": "One", "stage": "inbox" } ],
              "designs": [ { "id": "SDD-001", "title": "Design", "stage": "sdd" } ], "plans": [],
              "sprints": [ { "id": "SPRINT-001", "title": "Project", "problemStatement": "One thing" } ],
              "milestones": [], "archive": { "items": [], "designs": [], "archivedAt": {} },
              "quarantined": [], "sidecarTests": {}, "notRead": [], "attachments": []
            }
            """
        )!;
        using var scope = factory.Services.CreateScope();
        await new V0Importer(scope.ServiceProvider.GetRequiredService<BoardDb>()).ImportAsync(dump);
        return slug;
    }

    private async Task<(HttpStatusCode Status, JsonNode? Body)> Send(HttpMethod method, string path, object? body, string? authorization)
    {
        using var req = new HttpRequestMessage(method, path);
        if (body is not null) req.Content = JsonContent.Create(body);
        if (authorization is not null) req.Headers.Authorization = AuthenticationHeaderValue.Parse(authorization);
        var res = await factory.CreateClient().SendAsync(req);
        var text = await res.Content.ReadAsStringAsync();
        return (res.StatusCode, text.Length > 0 && text[0] is '{' or '[' ? JsonNode.Parse(text) : null);
    }

    private static object NewItem => new { type = "issue", title = "With a token" };

    [Fact]
    public async Task A_write_with_no_token_a_wrong_token_or_a_bad_header_gets_401_and_changes_nothing()
    {
        var slug = await Board();
        var wrong = Tokens.New();
        foreach (var authorization in new string?[] { null, $"Bearer {wrong}", "Bearer", "Basic dXNlcjpwYXNz" })
        {
            var (status, body) = await Send(HttpMethod.Post, $"/api/boards/{slug}/items", NewItem, authorization);
            Assert.Equal(HttpStatusCode.Unauthorized, status);
            Assert.Contains("Bearer <token>", (string)body!["error"]!);
        }
        var items = (await Send(HttpMethod.Get, $"/api/boards/{slug}/items", null, null)).Body!.AsArray();
        Assert.Single(items);
    }

    [Fact]
    public async Task A_valid_token_passes_and_a_revoked_one_never_passes_again()
    {
        var slug = await Board();
        var token = await factory.MintToken("revoker", "laptop");

        var ok = await Send(HttpMethod.Post, $"/api/boards/{slug}/items", NewItem, $"Bearer {token}");
        Assert.Equal(HttpStatusCode.Created, ok.Status);

        var list = new StringWriter();
        await TokenCommand.RunAsync(factory.Services, ["list"], list, TextWriter.Null);
        var row = list.ToString().Split('\n').Single(l => l.Contains("revoker") && l.Contains("laptop"));
        var id = row[..36];
        Assert.NotEqual("-", row.Split("  ", StringSplitOptions.RemoveEmptyEntries)[4].Trim()); // last used

        var revoked = new StringWriter();
        Assert.Equal(0, await TokenCommand.RunAsync(factory.Services, ["revoke", id], revoked, TextWriter.Null));
        Assert.Contains("revoked token", revoked.ToString());

        var after = await Send(HttpMethod.Post, $"/api/boards/{slug}/items", NewItem, $"Bearer {token}");
        Assert.Equal(HttpStatusCode.Unauthorized, after.Status);
        Assert.Contains("unknown or revoked", (string)after.Body!["error"]!);

        // The name is free again: the machine gets a new token.
        var again = await factory.MintToken("revoker", "laptop");
        Assert.Equal(HttpStatusCode.Created, (await Send(HttpMethod.Post, $"/api/boards/{slug}/items", NewItem, $"Bearer {again}")).Status);
    }

    [Fact]
    public async Task The_server_keeps_only_a_hash_and_two_live_tokens_cannot_share_a_name()
    {
        var token = await factory.MintToken("hasher", "mac-mini");
        Assert.StartsWith(Tokens.Prefix, token);

        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<BoardDb>();
        var stored = await db.Tokens.SingleAsync(t => t.Name == "mac-mini" && db.Users.Any(u => u.Id == t.UserId && u.Name == "hasher"));
        Assert.Equal(Tokens.Hash(token), stored.Hash);
        Assert.DoesNotContain(token, System.Text.Encoding.UTF8.GetString(stored.Hash));

        var err = new StringWriter();
        Assert.Equal(1, await TokenCommand.RunAsync(factory.Services, ["create", "--user", "hasher", "--name", "mac-mini"], TextWriter.Null, err));
        Assert.Contains("already has a token named mac-mini", err.ToString());
    }

    [Fact]
    public async Task Reads_need_no_token()
    {
        var slug = await Board();
        foreach (var path in new[] { "/api/health", "/api/boards", $"/api/boards/{slug}/items", $"/api/boards/{slug}/items/SB-001", $"/{slug}" })
        {
            Assert.Equal(HttpStatusCode.OK, (await Send(HttpMethod.Get, path, null, null)).Status);
        }
        foreach (var path in OpenPosts)
        {
            var real = path.Replace("{slug}", slug).Replace("{key}", "SPRINT-001");
            object body = path.EndsWith("prompt") ? new { entityType = "item", entityId = "SB-001" }
                : path.EndsWith("review") ? new { entityType = "sdd", entityId = "SDD-001" }
                : path.EndsWith("match") ? new { text = "Any text" }
                : new { };
            var (status, answer) = await Send(HttpMethod.Post, real, body, null);
            Assert.True(status == HttpStatusCode.OK, $"{path}: {(int)status} {answer}");
        }
    }

    /// <summary>
    /// Every route the server maps that is not a GET, sent with no token. A route added later is in
    /// this list by itself, so it cannot be left open by mistake.
    /// </summary>
    [Fact]
    public async Task Every_route_that_is_not_a_read_refuses_a_request_with_no_token()
    {
        var slug = await Board();
        var routes = factory.Services.GetRequiredService<EndpointDataSource>()
            .Endpoints.OfType<RouteEndpoint>()
            .SelectMany(e => (e.Metadata.GetMetadata<HttpMethodMetadata>()?.HttpMethods ?? ["POST"]).Select(m => (Method: m, Path: "/" + e.RoutePattern.RawText!.TrimStart('/'))))
            .Where(r => r.Method is not ("GET" or "HEAD") && !OpenPosts.Contains(r.Path))
            .ToList();
        Assert.True(routes.Count >= 23, $"only {routes.Count} write routes found");

        foreach (var (method, path) in routes)
        {
            var real = path.Replace("{slug}", slug).Replace("{key}", "SB-001").Replace("{task}", "TASK-001").Replace("{**rest}", "nope");
            var (status, _) = await Send(new HttpMethod(method), real, new { title = "x" }, null);
            Assert.True(status == HttpStatusCode.Unauthorized, $"{method} {path}: {(int)status}");
        }
        Assert.Single((await Send(HttpMethod.Get, $"/api/boards/{slug}/items", null, null)).Body!.AsArray());
    }

    [Fact]
    public async Task A_comment_or_claim_that_names_nobody_records_the_tokens_user()
    {
        var slug = await Board();
        var token = $"Bearer {await factory.MintToken("terje")}";

        var named = await Send(HttpMethod.Post, $"/api/boards/{slug}/items/SB-001/comments", new { text = "Named", author = "claude" }, token);
        Assert.Equal("claude", (string)named.Body!["author"]!);
        var unnamed = await Send(HttpMethod.Post, $"/api/boards/{slug}/items/SB-001/comments", new { text = "Unnamed" }, token);
        Assert.Equal(HttpStatusCode.Created, unnamed.Status);
        Assert.Equal("terje", (string)unnamed.Body!["author"]!);

        var claim = await Send(HttpMethod.Post, $"/api/boards/{slug}/items/SB-001/claim", new { }, token);
        Assert.Equal(HttpStatusCode.OK, claim.Status);
        Assert.Equal("terje", (string)claim.Body!["assignee"]!);
        var other = await Send(HttpMethod.Post, $"/api/boards/{slug}/items/SB-001/claim", new { assignee = "session-b" }, token);
        Assert.Equal(HttpStatusCode.Conflict, other.Status);
    }
}
