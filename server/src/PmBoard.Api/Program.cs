using Microsoft.EntityFrameworkCore;
using Npgsql;
using PmBoard.Api.Data;

var builder = WebApplication.CreateBuilder(args);

var connectionString =
    builder.Configuration.GetConnectionString("pmboard")
    ?? throw new InvalidOperationException("ConnectionStrings:pmboard is not set");

builder.Services.AddNpgsqlDataSource(connectionString);
builder.Services.AddDbContext<BoardDb>(o =>
    o.UseNpgsql(connectionString).UseSnakeCaseNamingConvention()
);

var app = builder.Build();

using (var scope = app.Services.CreateScope())
{
    await scope.ServiceProvider.GetRequiredService<BoardDb>().Database.MigrateAsync();
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

// An unknown API path is a 404, never the client's index.html.
app.Map("/api/{**rest}", () => Results.NotFound());

// Every other path without a file extension is a client route, for example
// /pm-board-cli for that project's board.
app.MapFallbackToFile("index.html");

app.Run();

public partial class Program;
