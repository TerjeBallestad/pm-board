using System.Security.Claims;
using System.Text.Encodings.Web;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authorization;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using PmBoard.Api.Data;

namespace PmBoard.Api.Auth;

/// <summary>
/// `Authorization: Bearer &lt;token&gt;`. Every request that is not a GET or HEAD needs a token that
/// is not revoked (DD-003, DD-020). Reads stay open on the tailnet, so the read-only dashboard needs
/// none. The rule is the fallback policy, so a route added later needs a token unless it says
/// otherwise with AllowAnonymous.
/// </summary>
public sealed class TokenAuth(IOptionsMonitor<AuthenticationSchemeOptions> options, ILoggerFactory logger, UrlEncoder encoder, BoardDb db)
    : AuthenticationHandler<AuthenticationSchemeOptions>(options, logger, encoder)
{
    public const string Scheme = "Bearer";

    /// <summary>The token's row id, as a claim, for logs and for `token list`.</summary>
    public const string TokenIdClaim = "pm_token_id";

    public static void AddTokenAuth(IServiceCollection services)
    {
        services.AddAuthentication(Scheme).AddScheme<AuthenticationSchemeOptions, TokenAuth>(Scheme, null);
        services.AddAuthorization(o =>
            o.FallbackPolicy = new AuthorizationPolicyBuilder()
                .RequireAssertion(ctx =>
                    ctx.User.Identity?.IsAuthenticated == true
                    || (ctx.Resource is HttpContext http && (HttpMethods.IsGet(http.Request.Method) || HttpMethods.IsHead(http.Request.Method)))
                )
                .Build()
        );
    }

    protected override async Task<AuthenticateResult> HandleAuthenticateAsync()
    {
        string? header = Request.Headers.Authorization;
        if (string.IsNullOrEmpty(header)) return AuthenticateResult.NoResult();
        if (!header.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase))
        {
            return AuthenticateResult.Fail("the Authorization header is not \"Bearer <token>\"");
        }

        var hash = Tokens.Hash(header["Bearer ".Length..].Trim());
        var found = await db.Tokens
            .Where(t => t.Hash == hash && t.RevokedAt == null)
            .Join(db.Users, t => t.UserId, u => u.Id, (t, u) => new { t.Id, UserId = u.Id, u.Name })
            .SingleOrDefaultAsync(Context.RequestAborted);
        if (found is null) return AuthenticateResult.Fail("the token is unknown or revoked");

        await db.Tokens.Where(t => t.Id == found.Id)
            .ExecuteUpdateAsync(s => s.SetProperty(t => t.LastUsedAt, DateTimeOffset.UtcNow), Context.RequestAborted);

        var identity = new ClaimsIdentity(
            [
                new Claim(ClaimTypes.NameIdentifier, found.UserId.ToString()),
                new Claim(ClaimTypes.Name, found.Name),
                new Claim(TokenIdClaim, found.Id.ToString()),
            ],
            Scheme
        );
        return AuthenticateResult.Success(new AuthenticationTicket(new ClaimsPrincipal(identity), Scheme));
    }

    /// <summary>401 with 0.x's error shape, and what to send.</summary>
    protected override async Task HandleChallengeAsync(AuthenticationProperties properties)
    {
        var failure = (await HandleAuthenticateOnceSafeAsync()).Failure?.Message;
        Response.StatusCode = StatusCodes.Status401Unauthorized;
        Response.Headers.WWWAuthenticate = Scheme;
        await Response.WriteAsJsonAsync(
            new JsonObject
            {
                ["error"] = failure is null
                    ? "a write needs a token: send \"Authorization: Bearer <token>\" (see the pm-board README, Tokens)"
                    : $"{failure}: send \"Authorization: Bearer <token>\" with a token that is not revoked",
            }
        );
    }
}
