using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using PmBoard.Api.Data;

namespace PmBoard.Api.Boards;

/// <summary>
/// The two kinds of board data that 0.x kept as files outside the store: sidecar tests
/// (*.tests.json, written by a repo's own tool) and image attachments.
/// </summary>
public static class FileRoutes
{
    /// <summary>The image types 0.x accepted (ALLOWED_ATTACHMENT_EXT in lib/app.js), with the type served.</summary>
    private static readonly Dictionary<string, string> ImageTypes = new(StringComparer.Ordinal)
    {
        [".png"] = "image/png",
        [".jpg"] = "image/jpeg",
        [".jpeg"] = "image/jpeg",
        [".gif"] = "image/gif",
        [".webp"] = "image/webp",
        [".svg"] = "image/svg+xml",
        [".bmp"] = "image/bmp",
    };

    /// <summary>0.x's upload limit.</summary>
    private const int MaxAttachmentBytes = 20 * 1024 * 1024;

    public static void MapFileRoutes(this WebApplication app, RouteGroupBuilder g)
    {
        g.MapPut("/tests", (string slug, HttpRequest req, BoardDb db) => Write.Run(req, db, slug, PutTests));

        g.MapPost("/attachments", UploadAttachment);
        g.MapGet(
            "/attachments",
            async (string slug, BoardDb db) =>
            {
                if (await ReadRoutes.Board(db, slug) is not { } board) return ReadRoutes.NotFound();
                var names = await db.Attachments.Where(a => a.BoardId == board.Id).Select(a => a.Name).ToListAsync();
                return Results.Json(names.Where(n => ImageTypes.ContainsKey(Path.GetExtension(n).ToLowerInvariant())).Order(StringComparer.Ordinal));
            }
        );

        // 0.x served /attachments/<file>, and markdown bodies link there. The names are random, so the
        // path needs no board; on the rare clash the oldest file wins.
        app.MapGet(
            "/attachments/{name}",
            async (string name, BoardDb db, HttpResponse res) =>
            {
                var a = await db.Attachments.AsNoTracking().Where(x => x.Name == name).OrderBy(x => x.CreatedAt).FirstOrDefaultAsync();
                if (a is null) return Results.NotFound();
                // An SVG can hold script: serve it as an image only.
                res.Headers.ContentSecurityPolicy = "default-src 'none'; style-src 'unsafe-inline'; sandbox";
                return Results.File(a.Data, a.ContentType);
            }
        );
    }

    /// <summary>
    /// PUT /tests (DD-019): every sidecar tests list of the board at once, as a repo's catalogue tool writes
    /// them (lifelines-core-loop scripts/generate-test-catalogue.js). Body: {"tests": {"DD-003": [...]}}.
    /// A live decision (DD-) or design (SDD-) gets its list; every other record that had one loses it,
    /// as the tool deletes orphan sidecar files. One transaction.
    /// </summary>
    private static async Task<IResult> PutTests(Write w)
    {
        if (w.Body["tests"] is not JsonObject map)
        {
            return Write.Error(400, "tests object required: {\"tests\": {\"DD-003\": [...], \"SDD-012\": [...]}}");
        }
        if (map.FirstOrDefault(kv => kv.Value is not JsonArray) is { Key: { } bad })
        {
            return Write.Error(400, $"tests for {bad} must be an array");
        }

        var updated = new List<string>();
        var unchanged = new List<string>();
        var skipped = new List<string>();
        foreach (var (key, list) in map)
        {
            var kind = key.StartsWith("DD-", StringComparison.Ordinal) ? RecordKind.Item
                : key.StartsWith("SDD-", StringComparison.Ordinal) ? RecordKind.Design
                : null;
            var r = kind is null ? null : await w.Lock(kind, key);
            if (r is null)
            {
                // The tool writes no sidecar for an archived record, and 0.x reads none for an unknown one.
                skipped.Add(key);
                continue;
            }
            var fields = Write.Fields(r);
            if (JsonNode.DeepEquals(fields["tests"], list))
            {
                unchanged.Add(key);
                continue;
            }
            fields["tests"] = list!.DeepClone();
            Write.SetFields(r, fields);
            updated.Add(key);
        }

        var cleared = new List<string>();
        var withTests = await w.Db.Records.FromSql(
                $"SELECT * FROM records WHERE board_id = {w.Board.Id} AND kind IN ('item', 'design') AND archived_at IS NULL AND jsonb_exists(fields, 'tests') FOR UPDATE"
            )
            .AsAsyncEnumerable()
            .ToListAsync();
        foreach (var r in withTests.Where(r => !map.ContainsKey(r.Key)))
        {
            var fields = Write.Fields(r);
            fields.Remove("tests");
            Write.SetFields(r, fields);
            cleared.Add(r.Key);
        }

        return Write.Json(
            new JsonObject
            {
                ["updated"] = Keys(updated),
                ["unchanged"] = Keys(unchanged),
                ["cleared"] = Keys(cleared.Order(StringComparer.Ordinal)),
                ["skipped"] = Keys(skipped),
            }
        );
    }

    /// <summary>POST /attachments?name=shot.png with the image as the body: 0.x's upload, per board.</summary>
    private static async Task<IResult> UploadAttachment(string slug, string? name, HttpRequest req, BoardDb db)
    {
        if (await ReadRoutes.Board(db, slug) is not { } board) return ReadRoutes.NotFound();
        var ext = Path.GetExtension(name ?? "upload.png").ToLowerInvariant();
        if (!ImageTypes.TryGetValue(ext, out var type)) return Write.Error(400, $"Unsupported file type: {ext}");

        using var ms = new MemoryStream();
        await req.Body.CopyToAsync(ms);
        if (ms.Length > MaxAttachmentBytes) return Write.Error(413, "attachment is larger than 20 MB");

        var filename = Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(6)) + ext;
        db.Attachments.Add(new Attachment { Id = Guid.CreateVersion7(), BoardId = board.Id, Name = filename, ContentType = type, Data = ms.ToArray() });
        await db.SaveChangesAsync();
        return Results.Json(new JsonObject { ["filename"] = filename, ["url"] = $"/attachments/{filename}" }, statusCode: 201);
    }

    /// <summary>The content type for a file name, or null for a type 0.x did not accept.</summary>
    public static string? ImageType(string name) => ImageTypes.GetValueOrDefault(Path.GetExtension(name).ToLowerInvariant());

    private static JsonArray Keys(IEnumerable<string> keys) => new(keys.Select(k => (JsonNode)k).ToArray());
}
