using System.Security.Cryptography;
using System.Text;

namespace PmBoard.Api.Auth;

/// <summary>Makes and hashes personal access tokens (DD-003).</summary>
public static class Tokens
{
    /// <summary>The prefix tells a pm token apart from other secrets, for example in a leak scan.</summary>
    public const string Prefix = "pmb_";

    /// <summary>A new token: the prefix and 32 random bytes, base64url.</summary>
    public static string New() => Prefix + Base64Url(RandomNumberGenerator.GetBytes(32));

    public static byte[] Hash(string token) => SHA256.HashData(Encoding.UTF8.GetBytes(token));

    private static string Base64Url(byte[] bytes) =>
        Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
}
