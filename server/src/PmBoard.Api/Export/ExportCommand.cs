using PmBoard.Api.Data;

namespace PmBoard.Api.Export;

/// <summary>
/// The `export` command: `export &lt;dir&gt; [--board &lt;slug&gt; ...]` writes every board, or the
/// ones named, as 0.x board folders under &lt;dir&gt; (DD-022). It prints one slug per line.
/// </summary>
public static class ExportCommand
{
    public static async Task<int> RunAsync(IServiceProvider services, string[] args) =>
        await RunAsync(services, args, Console.Out, Console.Error);

    public static async Task<int> RunAsync(IServiceProvider services, string[] args, TextWriter stdout, TextWriter stderr)
    {
        string? dir = null;
        var slugs = new List<string>();
        for (var i = 0; i < args.Length; i++)
        {
            if (args[i] == "--board" && i + 1 < args.Length) slugs.Add(args[++i]);
            else if (dir is null && !args[i].StartsWith("--")) dir = args[i];
            else dir = null;
        }
        if (dir is null || args.Length == 0)
        {
            await stderr.WriteLineAsync("usage: PmBoard.Api export <dir> [--board <slug> ...]");
            return 2;
        }
        using var scope = services.CreateScope();
        try
        {
            Directory.CreateDirectory(dir);
            foreach (var slug in await V0Exporter.ExportAsync(scope.ServiceProvider.GetRequiredService<BoardDb>(), dir, slugs))
            {
                await stdout.WriteLineAsync(slug);
            }
            return 0;
        }
        catch (Exception e) when (e is ExportException or IOException or UnauthorizedAccessException)
        {
            await stderr.WriteLineAsync($"export: {e.Message}");
            return 1;
        }
    }
}
