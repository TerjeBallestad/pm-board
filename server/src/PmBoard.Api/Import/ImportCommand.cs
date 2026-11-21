using System.Text.Json;
using System.Text.Json.Nodes;
using PmBoard.Api.Data;

namespace PmBoard.Api.Import;

/// <summary>
/// The `import` command. Each dump is one board and one transaction. A report with every clash,
/// skipped file and dangling reference is written next to the dump as &lt;dump&gt;.report.json.
/// </summary>
public static class ImportCommand
{
    private static readonly JsonSerializerOptions Pretty = new() { WriteIndented = true };

    public static async Task<int> RunAsync(IServiceProvider services, string[] dumps)
    {
        if (dumps.Length == 0)
        {
            Console.Error.WriteLine("usage: PmBoard.Api import <dump.json> [<dump.json> ...]");
            return 2;
        }
        var failed = 0;
        foreach (var path in dumps)
        {
            using var scope = services.CreateScope();
            var importer = new V0Importer(scope.ServiceProvider.GetRequiredService<BoardDb>());
            try
            {
                var dump = JsonNode.Parse(await File.ReadAllTextAsync(path))!;
                var report = await importer.ImportAsync(dump);
                var reportPath = path + ".report.json";
                await File.WriteAllTextAsync(reportPath, JsonSerializer.Serialize(report, Pretty));
                Console.WriteLine(
                    $"{report.Board}: {string.Join(", ", report.Records.OrderBy(k => k.Key).Select(k => $"{k.Value} {k.Key}"))}"
                        + $" ({report.Archived} archived), {report.Comments} comments, {report.ProgressNotes} progress notes."
                        + $" Clashes {report.Clashes.Count}, skipped {report.Skipped.Count}, not read {report.NotRead.Count},"
                        + $" dangling references {report.Dangling.Count}, unreadable times {report.UnreadableTimes.Count}."
                        + $" Report: {reportPath}"
                );
                foreach (var c in report.Clashes)
                {
                    Console.WriteLine($"  clash {c.Key}: kept the {c.Kept}; the {c.Second}: {c.Action}");
                }
            }
            catch (Exception e) when (e is ImportException or JsonException or IOException)
            {
                Console.Error.WriteLine($"{path}: {e.Message}");
                failed++;
            }
        }
        return failed == 0 ? 0 : 1;
    }
}
