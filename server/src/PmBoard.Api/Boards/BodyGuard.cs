using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using PmBoard.Api.Data;

namespace PmBoard.Api.Boards;

/// <summary>
/// DD-030: a body write can never lose text. Prepend and append run here, in the update's
/// transaction. A replace of a body with text names the body it replaces (bodyBase), or says
/// force. The caller locked the row, so the hash is of the body the write replaces.
/// </summary>
public static class BodyGuard
{
    /// <summary>The first 12 hex characters of the sha256 of the body as UTF-8. A null body hashes as "".</summary>
    public static string Hash(string? body) =>
        Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(body ?? "")))[..12];

    /// <summary>True when the body has text: a blank body needs no base.</summary>
    public static bool HasText(string? body) => !string.IsNullOrWhiteSpace(body);

    /// <summary>
    /// Applies body, bodyPrepend and bodyAppend from the request to the locked record. Returns the
    /// refusal, or null when the body is written (or the request does not touch it).
    /// </summary>
    public static IResult? Apply(Write w, Record r)
    {
        var b = w.Body;
        var replace = Js.Has(b, "body");
        var prepend = Js.Has(b, "bodyPrepend");
        var append = Js.Has(b, "bodyAppend");
        var hasBase = Js.Has(b, "bodyBase");
        var hasForce = Js.Has(b, "force");
        if (!replace && !prepend && !append)
        {
            if (hasBase || hasForce) return Write.Error(400, "bodyBase and force go with body, bodyPrepend or bodyAppend");
            return null;
        }
        if (replace && (prepend || append)) return Write.Error(400, "body replaces the body: send it without bodyPrepend or bodyAppend");
        foreach (var name in new[] { "bodyPrepend", "bodyAppend" })
        {
            if (Js.Has(b, name) && !(b[name]?.GetValueKind() == JsonValueKind.String && HasText((string)b[name]!)))
            {
                return Write.Error(400, $"{name} must be text");
            }
        }
        if (hasBase && b["bodyBase"]?.GetValueKind() != JsonValueKind.String) return Write.Error(400, "bodyBase must be the bodyHash text");
        if (hasForce && b["force"]?.GetValueKind() is not (JsonValueKind.True or JsonValueKind.False))
        {
            return Write.Error(400, "force must be true or false");
        }

        var force = b["force"]?.GetValueKind() == JsonValueKind.True;
        var current = Hash(r.Body);
        if (!force && hasBase && (string)b["bodyBase"]! != current)
        {
            return Refuse(
                $"The body of {r.Key} changed since you read it (base {(string)b["bodyBase"]!}, now {current}). "
                    + $"Nothing was written. Read it again (pm get {r.Key}), redo your change on what you read, and send --base {current}.",
                current
            );
        }
        if (!force && replace && !hasBase && HasText(r.Body))
        {
            return Refuse(
                $"{r.Key} has a body, and body replaces all of it. Send bodyBase, the bodyHash that pm get prints (--base <hash>), "
                    + "or force: true (--force) to replace it anyway. --prepend-body and --append-body add a block and need neither. "
                    + "A pm CLI older than 1.2 cannot send a base: run pm update.",
                current
            );
        }

        if (replace) r.Body = Js.Text(b["body"]);
        if (prepend) r.Body = Join((string)b["bodyPrepend"]!, r.Body);
        if (append) r.Body = Join(r.Body, (string)b["bodyAppend"]!);
        return null;
    }

    /// <summary>Two blocks with one blank line between them. On a blank side, the other side alone.</summary>
    private static string Join(string? first, string? second)
    {
        if (!HasText(first)) return second ?? "";
        if (!HasText(second)) return first!;
        return first!.TrimEnd('\r', '\n') + "\n\n" + second!.TrimStart('\r', '\n');
    }

    private static IResult Refuse(string message, string bodyHash) =>
        Write.Json(new System.Text.Json.Nodes.JsonObject { ["error"] = message, ["bodyHash"] = bodyHash }, 409);
}
