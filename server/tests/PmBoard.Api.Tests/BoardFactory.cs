using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
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
