using Microsoft.EntityFrameworkCore;
using Npgsql;
using PmBoard.Api.Board;
using PmBoard.Api.Data;
using PmBoard.Api.Import;

var builder = WebApplication.CreateBuilder(args);

var connectionString =
    builder.Configuration.GetConnectionString("pmboard")
    ?? throw new InvalidOperationException("ConnectionStrings:pmboard is not set");

builder.Services.AddNpgsqlDataSource(connectionString);
builder.Services.AddDbContext<BoardDb>(o =>
    o.UseNpgsql(connectionString).UseSnakeCaseNamingConvention()
);

builder.Services.AddSingleton<BoardEvents>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<BoardEvents>());

var app = builder.Build();

using (var scope = app.Services.CreateScope())
{
    await scope.ServiceProvider.GetRequiredService<BoardDb>().Database.MigrateAsync();
}

// `dotnet PmBoard.Api.dll import <dump.json> ...` loads 0.x boards (tools/export-v0.mjs) and exits.
if (args is ["import", .. var dumps])
{
    Environment.ExitCode = await ImportCommand.RunAsync(app.Services, dumps);
    return;
}

app.UseDefaultFiles();
app.UseStaticFiles();

app.MapGet(
    "/api/health",
    async (NpgsqlDataSource db) =>
    {
        try
        {
            await using var cmd = db.CreateCommand("SELECT 1");
            await cmd.ExecuteScalarAsync();
            return Results.Ok(new { ok = true });
        }
        catch (NpgsqlException ex) when (ex.IsTransient)
        {
            return Results.Json(new { ok = false }, statusCode: 503);
        }
    }
);

app.MapReadRoutes();
app.MapEventRoutes();

// An unknown API path is a 404, never the client's index.html.
app.Map("/api/{**rest}", () => Results.NotFound());

// Every other path without a file extension is a client route, for example
// /pm-board-cli for that project's board.
app.MapFallbackToFile("index.html");

app.Run();

public partial class Program;
