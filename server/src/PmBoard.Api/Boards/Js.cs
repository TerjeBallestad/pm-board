using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace PmBoard.Api.Boards;

/// <summary>
/// The JavaScript rules that the 0.x handlers depend on, for JSON values: what is truthy, and what
/// a value prints as in a template string. The write routes port 0.x code line by line with these.
/// </summary>
public static class Js
{
    /// <summary>JavaScript truthiness. A missing value and null are both false.</summary>
    public static bool Truthy(JsonNode? n) =>
        n is not null
        && n.GetValueKind() switch
        {
            JsonValueKind.False or JsonValueKind.Null or JsonValueKind.Undefined => false,
            JsonValueKind.String => ((string?)n)!.Length > 0,
            JsonValueKind.Number => Num(n) is var d && d != 0 && !double.IsNaN(d),
            _ => true,
        };

    /// <summary><c>body[key] !== undefined</c>: the key is in the JSON, null included.</summary>
    public static bool Has(JsonObject o, string key) => o.ContainsKey(key);

    /// <summary>A JSON value as a text column holds it: a string as it is, anything else as JSON.</summary>
    public static string? Text(JsonNode? n) =>
        n is null ? null
        : n.GetValueKind() == JsonValueKind.String ? (string?)n
        : n.ToJsonString();

    /// <summary><c>`${o[key]}`</c>: a missing key prints "undefined", null prints "null".</summary>
    public static string Str(JsonObject? o, string key) => o is null || !o.ContainsKey(key) ? "undefined" : Str(o[key]);

    /// <summary><c>String(value)</c> for a value that is there.</summary>
    public static string Str(JsonNode? n) =>
        n is null ? "null"
        : n.GetValueKind() switch
        {
            JsonValueKind.String => (string)n!,
            JsonValueKind.True => "true",
            JsonValueKind.False => "false",
            JsonValueKind.Number => Number(Num(n)),
            JsonValueKind.Array => string.Join(",", n.AsArray().Select(x => x is null ? "" : Str(x))),
            _ => "[object Object]",
        };

    /// <summary><c>a || b</c> for printing: the value when truthy, else the fallback.</summary>
    public static string Or(JsonNode? n, string fallback) => Truthy(n) ? Str(n) : fallback;

    /// <summary>Strings of a JSON array; nothing when it is not an array.</summary>
    public static List<string> Strings(JsonNode? n) =>
        n is JsonArray a ? a.Select(x => x is null ? "null" : Str(x)).ToList() : [];

    /// <summary>
    /// lib/coerce.js: a field that must be an array. "" and null become [], a string is split on
    /// commas and trimmed. Anything else stays as it is.
    /// </summary>
    public static void CoerceArray(JsonObject body, string key)
    {
        if (!body.ContainsKey(key)) return;
        var v = body[key];
        if (v is null || (v.GetValueKind() == JsonValueKind.String && (string)v! == ""))
        {
            body[key] = new JsonArray();
        }
        else if (v.GetValueKind() == JsonValueKind.String)
        {
            body[key] = new JsonArray(
                ((string)v!).Split(',').Select(s => s.Trim()).Where(s => s.Length > 0).Select(s => (JsonNode)s).ToArray()
            );
        }
    }

    /// <summary>A JSON number as a double, whatever it was made from.</summary>
    public static double Num(JsonNode n) => double.Parse(n.ToJsonString(), CultureInfo.InvariantCulture);

    /// <summary><c>String.prototype.slice(0, n)</c>.</summary>
    public static string Slice(string s, int n) => s.Length <= n ? s : s[..n];

    private static string Number(double d) =>
        d == Math.Floor(d) && Math.Abs(d) < 1e21 ? ((long)d).ToString(CultureInfo.InvariantCulture) : d.ToString("R", CultureInfo.InvariantCulture);
}
