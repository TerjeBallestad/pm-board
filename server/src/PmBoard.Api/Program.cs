using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging.Console;
using Npgsql;
using PmBoard.Api.Auth;
using PmBoard.Api.Boards;
using PmBoard.Api.Data;
using PmBoard.Api.Export;
using PmBoard.Api.Import;

var builder = WebApplication.CreateBuilder(args);

// The one-off commands (import, token) keep stdout for their own output: `token create` prints the
// token there, so `TOKEN=$(... token create ...)` gets the token alone. Logs go to stderr.
if (args is ["import" or "token" or "export", ..])
{
    builder.Services.Configure<ConsoleLoggerOptions>(o => o.LogToStandardErrorThreshold = LogLevel.Trace);
}

var connectionString =
    builder.Configuration.GetConnectionString("pmboard")
    ?? throw new InvalidOperationException("ConnectionStrings:pmboard is not set");

builder.Services.AddNpgsqlDataSource(connectionString);
builder.Services.AddDbContext<BoardDb>(o =>
    o.UseNpgsql(connectionString).UseSnakeCaseNamingConvention()
);

TokenAuth.AddTokenAuth(builder.Services);

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

// `dotnet PmBoard.Api.dll export <dir> [--board <slug> ...]` writes boards as 0.x folders and exits.
if (args is ["export", .. var exportArgs])
{
    Environment.ExitCode = await ExportCommand.RunAsync(app.Services, exportArgs);
    return;
}

// `dotnet PmBoard.Api.dll token create|list|revoke ...` manages personal access tokens and exits.
if (args is ["token", .. var tokenArgs])
{
    Environment.ExitCode = await TokenCommand.RunAsync(app.Services, tokenArgs);
    return;
}

// Before routing: a path that names a board's old slug is rewritten or redirected (DD-035).
app.UseBoardAliases();
app.UseDefaultFiles();
app.UseStaticFiles();
app.UseRouting();
app.UseAuthentication();
app.UseAuthorization();

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
app.MapWriteRoutes();
app.MapEventRoutes();

// An unknown API path is a 404, never the client's index.html.
app.Map("/api/{**rest}", () => Results.NotFound());

// Every other path without a file extension is a client route, for example
// /pm-board-cli for that repo's board.
app.MapFallbackToFile("index.html");

app.Run();

public partial class Program;
