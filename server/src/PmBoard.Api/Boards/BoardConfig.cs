using System.Text.Json;
using System.Text.Json.Nodes;
using PmBoard.Api.Data;

namespace PmBoard.Api.Boards;

/// <summary>
/// A board's config, with 0.x's defaults (DEFAULT_CONFIG in pm-board-cli lib/config.js) merged in
/// the way 0.x merges them. An imported board already holds the merged config.
/// </summary>
public sealed class BoardConfig
{
    private static readonly JsonObject Defaults = JsonNode.Parse(
        """
        {
          "claimTtlHours": 4,
          "stages": ["inbox", "exploring", "sdd", "planned", "done"],
          "entityTypes": {
            "SB": { "label": "Issue", "color": "#66d9ef" },
            "DD": { "label": "Decision", "color": "#ae81ff", "sweep": false },
            "DC": { "label": "Concern", "color": "#e6db74" },
            "GAP": { "label": "Gap", "color": "#f92672" },
            "TERM": { "label": "Term", "color": "#a6e22e", "frontier": false, "sweep": false },
            "SDD": { "label": "Design" },
            "PLAN": { "label": "Plan" },
            "SPRINT": { "label": "Sprint" },
            "TASK": { "label": "Task" },
            "MILESTONE": { "label": "Milestone" }
          },
          "knowledgeBase": { "command": "qmd query", "scope": null },
          "templates": null
        }
        """
    )!.AsObject();

    public string Name { get; }
    public JsonObject Merged { get; }

    public BoardConfig(Board board)
    {
        Name = board.Name;
        Merged = MergeDeep(Defaults.DeepClone().AsObject(), JsonNode.Parse(board.Config.RootElement.GetRawText())!.AsObject());
    }

    public List<string> Stages => Js.Strings(Merged["stages"]);

    public JsonObject EntityTypes => Merged["entityTypes"] as JsonObject ?? [];

    /// <summary>getTypePrefix: an item type (the lowercased label) to its key prefix.</summary>
    public Dictionary<string, string> TypePrefix()
    {
        var map = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var (prefix, meta) in EntityTypes)
        {
            map[Label(prefix, meta)] = prefix;
        }
        return map;
    }

    /// <summary>Types with frontier: false (never claimable work).</summary>
    public HashSet<string> NonFrontier() => FlagOff("frontier");

    /// <summary>Types with sweep: false (never swept to the archive).</summary>
    public HashSet<string> NonSweep() => FlagOff("sweep");

    /// <summary>
    /// claimTtlHours, or null when claims never expire (0, a negative number or not a number, as in
    /// isClaimLive).
    /// </summary>
    public double? ClaimTtlHours =>
        Merged["claimTtlHours"] is { } n && n.GetValueKind() == JsonValueKind.Number && Js.Num(n) is var h && h > 0
            ? h
            : null;

    public bool ClaimLive(Record r, DateTimeOffset now) =>
        r.Assignee is not null && r.AssignedAt is { } at && (ClaimTtlHours is not { } ttl || now - at < TimeSpan.FromHours(ttl));

    /// <summary>buildQmdCommand: the knowledge-base command line for a query, or null when none is set.</summary>
    public string? QmdCommand(string query)
    {
        var kb = Merged["knowledgeBase"] as JsonObject;
        if (kb is null || !Js.Truthy(kb["command"])) return null;
        var cmd = $"{Js.Str(kb["command"])} \"{query.Replace("\"", "\\\"")}\"";
        if (Js.Truthy(kb["scope"])) cmd += $" -c {Js.Str(kb["scope"])}";
        return cmd;
    }

    /// <summary>
    /// A prompt template: the board's own (templateFiles, copied from its templates folder at
    /// export), else the built-in one, else null. 0.x looks per file in the same order.
    /// </summary>
    public string? Template(string name)
    {
        if (Js.Truthy(Merged["templates"]) && (Merged["templateFiles"] as JsonObject)?[name] is { } own && own.GetValueKind() == JsonValueKind.String)
        {
            return (string)own!;
        }
        return Templates.BuiltIn(name);
    }

    private HashSet<string> FlagOff(string flag)
    {
        var off = new HashSet<string>(StringComparer.Ordinal);
        foreach (var (prefix, meta) in EntityTypes)
        {
            if ((meta as JsonObject)?[flag]?.GetValueKind() == JsonValueKind.False) off.Add(Label(prefix, meta));
        }
        return off;
    }

    private static string Label(string prefix, JsonNode? meta) =>
        (meta is JsonObject m && Js.Truthy(m["label"]) ? Js.Str(m["label"]) : prefix).ToLowerInvariant();

    /// <summary>0.x's mergeDeep: objects merge, everything else (arrays too) is replaced.</summary>
    private static JsonObject MergeDeep(JsonObject target, JsonObject source)
    {
        foreach (var (key, value) in source)
        {
            if (value is JsonObject s && target[key] is JsonObject t)
            {
                MergeDeep(t, s);
            }
            else
            {
                target[key] = value?.DeepClone();
            }
        }
        return target;
    }
}
