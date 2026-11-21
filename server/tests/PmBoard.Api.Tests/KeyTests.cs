using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Npgsql;
using PmBoard.Api.Data;
using PmBoard.Api.Keys;
using Record = PmBoard.Api.Data.Record;

namespace PmBoard.Api.Tests;

public class KeyTests(BoardFactory factory) : IClassFixture<BoardFactory>
{
    private async Task<Guid> NewProject()
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<BoardDb>();
        var p = new Project { Slug = "p-" + Guid.NewGuid().ToString("N")[..8], Name = "Test" };
        db.Add(p);
        await db.SaveChangesAsync();
        return p.Id;
    }

    private async Task<string> CreateItem(Guid projectId, string prefix, TimeSpan holdLock = default)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<BoardDb>();
        await using var tx = await db.Database.BeginTransactionAsync();
        var (key, number) = await KeyAllocator.NextAsync(db, projectId, prefix);
        if (holdLock > TimeSpan.Zero)
        {
            await Task.Delay(holdLock);
        }
        db.Add(new Record { ProjectId = projectId, Key = key, Prefix = prefix, Number = number, Kind = RecordKind.Item, Title = key });
        await db.SaveChangesAsync();
        await tx.CommitAsync();
        return key;
    }

    [Fact]
    public async Task Forty_creates_at_the_same_moment_get_forty_different_keys_with_no_gap()
    {
        var project = await NewProject();
        var keys = await Task.WhenAll(
            Enumerable.Range(0, 40).Select(_ => Task.Run(() => CreateItem(project, "SB", TimeSpan.FromMilliseconds(5))))
        );
        var expected = Enumerable.Range(1, 40).Select(n => KeyAllocator.Format("SB", n));
        Assert.Equal(expected.OrderBy(k => k), keys.OrderBy(k => k));
    }

    [Fact]
    public async Task Each_prefix_and_each_project_counts_on_its_own()
    {
        var a = await NewProject();
        var b = await NewProject();
        Assert.Equal("SB-001", await CreateItem(a, "SB"));
        Assert.Equal("SB-002", await CreateItem(a, "SB"));
        Assert.Equal("DD-001", await CreateItem(a, "DD"));
        Assert.Equal("SB-001", await CreateItem(b, "SB"));
    }

    [Fact]
    public async Task A_rolled_back_create_gives_its_number_back()
    {
        var project = await NewProject();
        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<BoardDb>();
            await using var tx = await db.Database.BeginTransactionAsync();
            var (key, _) = await KeyAllocator.NextAsync(db, project, "SB");
            Assert.Equal("SB-001", key);
            await tx.RollbackAsync();
        }
        Assert.Equal("SB-001", await CreateItem(project, "SB"));
    }

    [Fact]
    public async Task Allocating_outside_a_transaction_is_refused()
    {
        var project = await NewProject();
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<BoardDb>();
        await Assert.ThrowsAsync<InvalidOperationException>(() => KeyAllocator.NextAsync(db, project, "SB"));
    }

    [Fact]
    public async Task Postgres_refuses_one_key_twice_in_a_project_even_across_kinds_and_archive()
    {
        var project = await NewProject();
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<BoardDb>();
        db.Add(new Record { ProjectId = project, Key = "SB-416", Prefix = "SB", Number = 416, Kind = RecordKind.Item, ArchivedAt = DateTimeOffset.UtcNow });
        await db.SaveChangesAsync();
        db.ChangeTracker.Clear();
        db.Add(new Record { ProjectId = project, Key = "SB-416", Prefix = "SB", Number = 416, Kind = RecordKind.Design });
        var ex = await Assert.ThrowsAsync<DbUpdateException>(() => db.SaveChangesAsync());
        Assert.Equal(PostgresErrorCodes.UniqueViolation, ((PostgresException)ex.InnerException!).SqlState);
    }

    [Theory]
    [InlineData("SB", 7, "SB-007")]
    [InlineData("SB", 42, "SB-042")]
    [InlineData("SB", 1000, "SB-1000")]
    public void Keys_have_at_least_three_digits(string prefix, int n, string key) =>
        Assert.Equal(key, KeyAllocator.Format(prefix, n));

    [Theory]
    [InlineData("SB-042", "SB", 42)]
    [InlineData("DC-NEW-7", "DC-NEW", 7)]
    [InlineData("SDD-flow-resonance", null, null)]
    [InlineData("v0.1", null, null)]
    [InlineData("SB-", null, null)]
    public void A_key_splits_into_prefix_and_number_only_when_it_ends_in_digits(string key, string? prefix, int? n) =>
        Assert.Equal((prefix, n), KeyAllocator.Parse(key));
}
