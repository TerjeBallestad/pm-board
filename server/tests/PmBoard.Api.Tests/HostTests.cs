using System.Net;
using System.Net.Http.Json;

namespace PmBoard.Api.Tests;

public class HostTests(BoardFactory factory) : IClassFixture<BoardFactory>
{
    [Fact]
    public async Task Health_answers_ok_when_postgres_answers()
    {
        var res = await factory.CreateClient().GetAsync("/api/health");
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        var body = await res.Content.ReadFromJsonAsync<HealthBody>();
        Assert.True(body!.Ok);
    }

    [Theory]
    [InlineData("/")]
    [InlineData("/pm-board-cli")]
    [InlineData("/lifelines-tycoon/PLAN-004")]
    public async Task A_client_route_serves_the_client(string path)
    {
        var res = await factory.CreateClient().GetAsync(path);
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        Assert.Equal(BoardFactory.IndexHtml, await res.Content.ReadAsStringAsync());
    }

    [Theory]
    [InlineData("/api/nope")]
    [InlineData("/api/items/SB-001")]
    public async Task An_unknown_api_path_is_404_and_never_the_client(string path)
    {
        var res = await factory.CreateClient().GetAsync(path);
        Assert.Equal(HttpStatusCode.NotFound, res.StatusCode);
    }

    private record HealthBody(bool Ok);
}
