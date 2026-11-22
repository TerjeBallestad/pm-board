using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Microsoft.EntityFrameworkCore;
using PmBoard.Api.Data;

namespace PmBoard.Api.Boards;

/// <summary>
/// shared/glossary.js on the server: which terms a text mentions, by the same rules, so `pm get`
/// asks for the terms of one record instead of downloading every term (DD-029). The port follows
/// the JS line by line. shared/glossary-cases.json holds texts and what the JS finds in them; the
/// JS test and GlossaryTests both check them.
/// </summary>
public static class Glossary
{
    public sealed record Term(string Id, string Title, string Kind, List<string> Targets, List<string> TargetTitles);

    public sealed record Match(int Start, int End, string Text, Term Term);

    public sealed class Index
    {
        public Regex? Re { get; set; }
        public Dictionary<string, string> BySurface { get; } = new(StringComparer.Ordinal);
        public Dictionary<string, Term> Terms { get; } = new(StringComparer.Ordinal);
    }

    public static void MapGlossaryRoutes(this RouteGroupBuilder g)
    {
        // The terms a text mentions, the first match of each, in the order of the text. A POST, as a
        // body can be long; it changes nothing, so it needs no token (DD-020).
        g.MapPost(
                "/glossary/match",
                async (string slug, HttpRequest req, BoardDb db) =>
                {
                    JsonNode? body;
                    try
                    {
                        body = await JsonNode.ParseAsync(req.Body);
                    }
                    catch (System.Text.Json.JsonException)
                    {
                        return Write.Error(400, "the body is not a JSON object");
                    }
                    if (body is not JsonObject o || o["text"] is not JsonValue v || !v.TryGetValue<string>(out var text))
                    {
                        return Write.Error(400, "text must be a string");
                    }
                    if (await ReadRoutes.Board(db, slug) is not { } p) return ReadRoutes.NotFound();
                    var terms = await ReadRoutes.Live(db, p, RecordKind.Item).Where(r => r.Type == "term").OrderBy(r => r.Key).ToListAsync();
                    var index = Build(terms.Select(r => V0Json.Record(r, [])));
                    return Results.Json(
                        new JsonArray(
                            FirstMatchPerTerm(FindTermMatches(text, index))
                                .Select(m => (JsonNode)new JsonObject
                                {
                                    ["termId"] = m.Term.Id,
                                    ["title"] = m.Term.Title,
                                    ["kind"] = m.Term.Kind,
                                    ["targets"] = new JsonArray(m.Term.Targets.Select(t => (JsonNode)t).ToArray()),
                                    ["targetTitles"] = new JsonArray(m.Term.TargetTitles.Select(t => (JsonNode)t).ToArray()),
                                    ["text"] = m.Text,
                                })
                                .ToArray()
                        )
                    );
                }
            )
            .AllowAnonymous();
    }

    /// <summary>buildTermIndex(terms), without the conflicts list: no answer prints it.</summary>
    public static Index Build(IEnumerable<JsonObject> terms, int minLength = 3)
    {
        var list = terms.Where(t => t["type"] is JsonValue v && v.TryGetValue<string>(out var s) && s == "term").ToList();
        var index = new Index();

        List<string> SurfacesOf(JsonObject t)
        {
            var aliases = t["aliases"] is JsonArray a ? a : [];
            return new[] { t["title"] }.Concat(aliases).Select(Norm).Where(s => s.Length > 0).ToList();
        }

        // Pass 1: every signpost surface. An alias may never shadow a word that is ambiguous alone.
        var signpostSurfaces = new HashSet<string>(StringComparer.Ordinal);
        foreach (var t in list.Where(t => TermKind(t) == "signpost"))
        {
            foreach (var s in SurfacesOf(t)) signpostSurfaces.Add(SurfaceKey(s));
        }

        var titleById = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var t in list) titleById[Id(t)] = Norm(t["title"]);

        // Pass 2: index every surface; the first term to claim one keeps it.
        var surfaces = new List<string>();
        foreach (var t in list)
        {
            var kind = TermKind(t);
            var targets = kind == "signpost" ? t["related"]!.AsArray().Select(x => Js.Str(x)).ToList() : [];
            index.Terms[Id(t)] = new Term(
                Id(t),
                Norm(t["title"]),
                kind,
                targets,
                targets.Select(id => titleById.TryGetValue(id, out var title) && title.Length > 0 ? title : id).ToList()
            );

            var all = SurfacesOf(t);
            for (var i = 0; i < all.Count; i++)
            {
                var surface = all[i];
                var key = SurfaceKey(surface);
                if (surface.Length < minLength) continue;
                if (i > 0 && signpostSurfaces.Contains(key)) continue;
                if (index.BySurface.ContainsKey(key)) continue;
                index.BySurface[key] = Id(t);
                surfaces.Add(surface);
            }
        }

        if (surfaces.Count > 0)
        {
            // JS alternation is leftmost-first, as .NET's is: the longest surface goes first, so
            // "merge conflict" wins over "merge".
            var alt = string.Join("|", surfaces.OrderByDescending(s => s.Length).ThenBy(s => s, StringComparer.Ordinal).Select(Pattern));
            // '-' counts as a word character, so "git-merge" never matches inside "re-git-merge".
            index.Re = new Regex($"(?<![A-Za-z0-9_-])(?:{alt})(?![A-Za-z0-9_-])", RegexOptions.CultureInvariant);
        }
        return index;
    }

    /// <summary>findTermMatches(text, index): every occurrence of every term, in the order of the text.</summary>
    public static List<Match> FindTermMatches(string text, Index index)
    {
        var output = new List<Match>();
        if (string.IsNullOrEmpty(text) || index.Re is null) return output;
        foreach (System.Text.RegularExpressions.Match m in index.Re.Matches(text))
        {
            if (m.Length == 0) continue;
            if (!index.BySurface.TryGetValue(SurfaceKey(m.Value), out var termId)) continue;
            if (!index.Terms.TryGetValue(termId, out var term)) continue;
            output.Add(new Match(m.Index, m.Index + m.Length, m.Value, term));
        }
        return output;
    }

    /// <summary>firstMatchPerTerm(matches): the first occurrence of each term.</summary>
    public static List<Match> FirstMatchPerTerm(List<Match> matches)
    {
        var seen = new HashSet<string>(StringComparer.Ordinal);
        return matches.Where(m => seen.Add(m.Term.Id)).ToList();
    }

    private static string Id(JsonObject t) => Js.Str(t["id"]);

    /// <summary>A term with no definition and somewhere to point is a signpost.</summary>
    private static string TermKind(JsonObject t)
    {
        var defined = Js.Truthy(t["body"]) && Trim(Js.Str(t["body"])).Length > 0;
        var targets = t["related"] is JsonArray a ? a.Count : 0;
        return !defined && targets > 0 ? "signpost" : "term";
    }

    /// <summary><c>String(s == null ? '' : s).trim()</c>.</summary>
    private static string Norm(JsonNode? n) => n is null ? "" : Trim(Js.Str(n));

    /// <summary><c>s.toLowerCase().replace(/\s+/g, ' ')</c>.</summary>
    private static string SurfaceKey(string s)
    {
        var lower = s.ToLowerInvariant();
        var sb = new StringBuilder(lower.Length);
        for (var i = 0; i < lower.Length; i++)
        {
            if (!IsSpace(lower[i]))
            {
                sb.Append(lower[i]);
                continue;
            }
            sb.Append(' ');
            while (i + 1 < lower.Length && IsSpace(lower[i + 1])) i++;
        }
        return sb.ToString();
    }

    /// <summary>
    /// One surface as a pattern: escapeRegExp, then each run of whitespace as [ \t]+, with the JS
    /// 'i' flag written out per character (Fold), as .NET's IgnoreCase knows more equivalents.
    /// </summary>
    private static string Pattern(string surface)
    {
        var sb = new StringBuilder();
        for (var i = 0; i < surface.Length; i++)
        {
            var c = surface[i];
            if (IsSpace(c))
            {
                sb.Append(@"[ \t]+");
                while (i + 1 < surface.Length && IsSpace(surface[i + 1])) i++;
                continue;
            }
            var same = Fold.Value[Canonicalize(c)];
            if (same.Length == 1) sb.Append(Regex.Escape(c.ToString()));
            else sb.Append('[').Append(string.Concat(same.Select(x => $"\\u{(int)x:X4}"))).Append(']');
        }
        return sb.ToString();
    }

    /// <summary>
    /// The JS 'i' flag without 'u' (ECMAScript Canonicalize): a character's upper case, unless that is
    /// not one character, or it would map a non-ASCII character to ASCII.
    /// </summary>
    private static char Canonicalize(char c)
    {
        var upper = char.ToUpperInvariant(c);
        return c >= 128 && upper < 128 ? c : upper;
    }

    /// <summary>Every UTF-16 code unit, grouped by its canonical form.</summary>
    private static readonly Lazy<Dictionary<char, char[]>> Fold = new(() =>
        Enumerable.Range(0, 0x10000)
            .Select(i => (char)i)
            .GroupBy(Canonicalize)
            .ToDictionary(group => group.Key, group => group.ToArray())
    );

    /// <summary>String.prototype.trim(): JS whitespace and line terminators.</summary>
    private static string Trim(string s)
    {
        var start = 0;
        var end = s.Length;
        while (start < end && IsSpace(s[start])) start++;
        while (end > start && IsSpace(s[end - 1])) end--;
        return s[start..end];
    }

    /// <summary>JS \s: WhiteSpace and LineTerminator.</summary>
    private static bool IsSpace(char c) =>
        c is '\t' or '\n' or '\v' or '\f' or '\r' or ' ' or '\u00a0' or '\u1680' or (>= '\u2000' and <= '\u200a')
            or '\u2028' or '\u2029' or '\u202f' or '\u205f' or '\u3000' or '\ufeff';
}
