using System.Text.Json.Nodes;
using Microsoft.Extensions.DependencyInjection;
using PmBoard.Api.Data;
using PmBoard.Api.Export;
using PmBoard.Api.Import;

namespace PmBoard.Api.Tests;

/// <summary>
/// The `export` command (DD-022). tools/compare-export.mjs proves that 0.x reads the export as the
/// board the server serves; these tests cover the command around it.
/// </summary>
public class ExportTests(BoardFactory factory) : IClassFixture<BoardFactory>
{
    private async Task<string> Board()
    {
        var slug = "export-" + Guid.NewGuid().ToString("N")[..8];
        var dump = JsonNode.Parse(
            $$"""
            {
              "format": "pm-v0-export",
              "board": { "slug": "{{slug}}", "name": "Export test", "config": { "stages": ["inbox", "done"], "templates": "t", "templateFiles": { "prompt-item": "Own {{"{{item.id}}"}}" } } },
              "items": [ { "id": "SB-001", "type": "issue", "title": "null", "stage": "inbox", "body": "---\nnot: yaml\n" },
                         { "id": "DD-001", "type": "decision", "title": "Tested", "stage": "inbox" } ],
              "designs": [], "plans": [ { "id": "PLAN-001", "title": "Plan", "stage": "planned", "tasks": [ { "id": "TASK-001", "title": "A", "status": "pending" } ] } ],
              "sprints": [], "milestones": [],
              "archive": { "items": [ { "id": "SB-002", "type": "issue", "title": "Old", "stage": "done" } ], "designs": [], "archivedAt": { "SB-002": "2026-01-02T00:00:00.000Z" } },
              "quarantined": [], "sidecarTests": { "DD-001": [ { "name": "t" } ] }, "notRead": [], "attachments": []
            }
            """
        )!;
        using var scope = factory.Services.CreateScope();
        await new V0Importer(scope.ServiceProvider.GetRequiredService<BoardDb>()).ImportAsync(dump);
        return slug;
    }

    private async Task<(int Code, string Out, string Err)> Run(params string[] args)
    {
        var (o, e) = (new StringWriter(), new StringWriter());
        var code = await ExportCommand.RunAsync(factory.Services, args, o, e);
        return (code, o.ToString(), e.ToString());
    }

    [Fact]
    public async Task A_board_is_written_in_0x_layout_with_its_sidecars_archive_and_templates()
    {
        var slug = await Board();
        var dir = Directory.CreateTempSubdirectory("pm-export-test-").FullName;

        var (code, stdout, _) = await Run(dir, "--board", slug);
        Assert.Equal(0, code);
        Assert.Equal(slug, stdout.Trim());

        var root = Path.Combine(dir, slug);
        var md = await File.ReadAllTextAsync(Path.Combine(root, "data", "items", "SB-001.md"));
        Assert.StartsWith("---\nid: \"SB-001\"\ntype: \"issue\"\ntitle: \"null\"\n", md);
        Assert.EndsWith("---\n---\nnot: yaml\n", md);
        Assert.Contains("\"name\": \"t\"", await File.ReadAllTextAsync(Path.Combine(root, "data", "items", "DD-001.tests.json")));
        Assert.DoesNotContain("tests", await File.ReadAllTextAsync(Path.Combine(root, "data", "items", "DD-001.md")));
        Assert.Contains("archivedAt: \"2026-01-02T00:00:00.000Z\"", await File.ReadAllTextAsync(Path.Combine(root, "data", "archive", "SB-002.md")));
        Assert.Equal("TASK-001", (string)JsonNode.Parse(await File.ReadAllTextAsync(Path.Combine(root, "data", "plans", "PLAN-001.json")))!["tasks"]![0]!["id"]!);
        Assert.Equal("Own {{item.id}}", await File.ReadAllTextAsync(Path.Combine(root, "templates", "prompt-item.md")));
        var config = JsonNode.Parse(await File.ReadAllTextAsync(Path.Combine(root, "pm.config.json")))!;
        Assert.Equal("Export test", (string)config["name"]!);
        Assert.Equal("data", (string)config["dataDir"]!);
        Assert.Equal("templates", (string)config["templates"]!);
        Assert.Null(config["templateFiles"]);
    }

    [Fact]
    public async Task An_export_never_writes_over_a_folder_that_exists()
    {
        var slug = await Board();
        var dir = Directory.CreateTempSubdirectory("pm-export-test-").FullName;
        Directory.CreateDirectory(Path.Combine(dir, slug));
        await File.WriteAllTextAsync(Path.Combine(dir, slug, "keep.txt"), "mine");

        var (code, _, stderr) = await Run(dir, "--board", slug);
        Assert.Equal(1, code);
        Assert.Contains("exists", stderr);
        Assert.Equal(["keep.txt"], Directory.GetFiles(Path.Combine(dir, slug)).Select(Path.GetFileName));
    }

    [Fact]
    public async Task An_unknown_board_or_no_folder_is_an_error()
    {
        var dir = Directory.CreateTempSubdirectory("pm-export-test-").FullName;
        Assert.Equal(1, (await Run(dir, "--board", "no-such-board")).Code);
        Assert.Empty(Directory.GetFileSystemEntries(dir));
        Assert.Equal(2, (await Run()).Code);
    }
}
