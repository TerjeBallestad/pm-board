using System.Reflection;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace PmBoard.Api.Boards;

/// <summary>
/// pm-board-cli lib/templates.js: the prompt templates and the blobs that fill them. The built-in
/// templates in Boards/Templates are 0.x's defaults/templates, unchanged. Values are the records'
/// 0.x JSON, so a missing field prints as it did in 0.x.
/// </summary>
public static partial class Templates
{
    public static string? BuiltIn(string name)
    {
        using var s = Assembly.GetExecutingAssembly().GetManifestResourceStream($"templates.{name}.md");
        if (s is null) return null;
        using var r = new StreamReader(s);
        return r.ReadToEnd();
    }

    /// <summary>render: {{a.b}} becomes the value at that path; a missing value or null prints nothing.</summary>
    public static string Render(string template, JsonObject vars) =>
        Placeholder().Replace(
            template,
            m =>
            {
                JsonNode? current = vars;
                foreach (var part in m.Groups[1].Value.Split('.'))
                {
                    if (current is not JsonObject o || !o.ContainsKey(part)) return "";
                    current = o[part];
                }
                return current is null ? "" : Js.Str(current);
            }
        );

    public static string RenderTemplate(BoardConfig cfg, string name, JsonObject vars, string fallback) =>
        cfg.Template(name) is { } t ? Render(t, vars) : fallback;

    public static string ItemsBlob(IEnumerable<JsonObject> items)
    {
        var list = items.ToList();
        if (list.Count == 0) return "(none)";
        return string.Join(
            "\n\n",
            list.Select(item =>
            {
                var s = $"### {Js.Str(item, "id")}: {Js.Str(item, "title")}\n";
                s += $"**Type:** {Js.Str(item, "type")} | **Priority:** {Js.Or(item["priority"], "unset")}";
                if (Js.Truthy(item["body"])) s += $"\n{Js.Slice(Js.Str(item["body"]), 500)}";
                return s;
            })
        );
    }

    public static string CommentsBlob(JsonNode? comments)
    {
        if (comments is not JsonArray a || a.Count == 0) return "(no comments)";
        return string.Join(
            "\n\n",
            a.Select(c => c as JsonObject).Select(c => $"**{Js.Str(c, "author")}** ({Js.Str(c, "createdAt")}):\n{Js.Str(c, "text")}")
        );
    }

    public static string TasksBlob(JsonNode? tasks)
    {
        if (tasks is not JsonArray a || a.Count == 0) return "(no tasks)";
        return string.Join(
            "\n",
            a.OfType<JsonObject>().Select(t =>
            {
                var status = Js.Truthy(t["passes"]) ? "[x]" : "[ ]";
                var blocked = t["blockedBy"] is JsonArray b && b.Count > 0
                    ? $" (blocked by: {string.Join(", ", b.Select(x => x is null ? "" : Js.Str(x)))})"
                    : "";
                var s = $"- {status} **{Js.Str(t, "id")}**: {Js.Str(t, "title")}{blocked}";
                if (Js.Truthy(t["description"])) s += $"\n  {Js.Str(t["description"])}";
                if (Js.Truthy(t["verification"])) s += $"\n  Verify: {Js.Str(t["verification"])}";
                return s;
            })
        );
    }

    public static string RelatedBlob(IEnumerable<JsonObject> items)
    {
        var list = items.ToList();
        if (list.Count == 0) return "(none)";
        return string.Join(
            "\n\n",
            list.Select(r =>
            {
                var body = r["body"] is { } b && b.GetValueKind() == JsonValueKind.String ? Js.Slice((string)b!, 200) : null;
                return $"### {Js.Str(r, "id")}: {Js.Str(r, "title")}\n{(string.IsNullOrEmpty(body) ? "(no description)" : body)}...";
            })
        );
    }

    public static string FilesBlob(JsonNode? files)
    {
        if (files is not JsonArray a || a.Count == 0) return "(none)";
        return string.Join("\n", a.Select(f => $"- `{(f is null ? "null" : Js.Str(f))}`"));
    }

    public static string DecisionsBlob(IEnumerable<JsonObject> decisions)
    {
        var list = decisions.ToList();
        if (list.Count == 0) return "(none)";
        return string.Join(
            "\n",
            list.Select(dd =>
            {
                var s = $"- **{Js.Str(dd, "id")}: {Js.Str(dd, "title")}**";
                if (Js.Truthy(dd["body"])) s += $" — {Js.Slice(Js.Str(dd["body"]).Split('\n')[0], 150)}";
                return s;
            })
        );
    }

    /// <summary>JavaScript's \w is ASCII only.</summary>
    [GeneratedRegex(@"\{\{([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*)\}\}")]
    private static partial Regex Placeholder();
}
