using System.Net.Http.Headers;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using PmBoard.Api.Auth;
using Testcontainers.PostgreSql;

namespace PmBoard.Api.Tests;

public class BoardFactory : WebApplicationFactory<Program>, IAsyncLifetime
{
    public const string IndexHtml = "<!doctype html><title>pm board test</title>";

    private readonly PostgreSqlContainer _pg = new PostgreSqlBuilder("postgres:18").Build();
    private readonly string _webRoot = Directory.CreateTempSubdirectory("pm-board-wwwroot-").FullName;

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        File.WriteAllText(Path.Combine(_webRoot, "index.html"), IndexHtml);
        builder.UseSetting("ConnectionStrings:pmboard", _pg.GetConnectionString());
        builder.UseWebRoot(_webRoot);
    }

    /// <summary>A new token from the `token` command, for a user that is made when it is new.</summary>
    public async Task<string> MintToken(string user, string? name = null)
    {
        var stdout = new StringWriter();
        var code = await TokenCommand.RunAsync(Services, ["create", "--user", user, "--name", name ?? "machine-" + Guid.NewGuid().ToString("N")[..8]], stdout, TextWriter.Null);
        if (code != 0) throw new InvalidOperationException($"token create exited with {code}");
        return stdout.ToString().Trim();
    }

    /// <summary>A client that sends a valid token for <paramref name="user"/> with every request.</summary>
    public async Task<HttpClient> Writer(string user = "test")
    {
        var http = CreateClient();
        http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", await MintToken(user));
        return http;
    }

    public async Task InitializeAsync()
    {
        await _pg.StartAsync();
        _ = Services; // start the host, which runs the migrations
    }

    async Task IAsyncLifetime.DisposeAsync()
    {
        await _pg.DisposeAsync();
        Directory.Delete(_webRoot, recursive: true);
    }
}
