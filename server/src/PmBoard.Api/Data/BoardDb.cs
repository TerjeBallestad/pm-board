using Microsoft.EntityFrameworkCore;

namespace PmBoard.Api.Data;

/// <summary>The shape is in server/docs/data-model.md.</summary>
public class BoardDb(DbContextOptions<BoardDb> options) : DbContext(options)
{
    public DbSet<Board> Boards => Set<Board>();
    public DbSet<BoardAlias> BoardAliases => Set<BoardAlias>();
    public DbSet<IdCounter> IdCounters => Set<IdCounter>();
    public DbSet<Record> Records => Set<Record>();
    public DbSet<Comment> Comments => Set<Comment>();
    public DbSet<Attachment> Attachments => Set<Attachment>();
    public DbSet<User> Users => Set<User>();
    public DbSet<Token> Tokens => Set<Token>();

    protected override void OnModelCreating(ModelBuilder b)
    {
        b.Entity<Board>(e =>
        {
            e.HasIndex(p => p.Slug).IsUnique();
            e.Property(p => p.Config).HasColumnType("jsonb");
            e.Property(p => p.CreatedAt).HasDefaultValueSql("now()");
        });

        b.Entity<BoardAlias>(e =>
        {
            e.HasKey(a => a.Slug);
            e.HasIndex(a => a.BoardId);
            e.HasOne<Board>().WithMany().HasForeignKey(a => a.BoardId).OnDelete(DeleteBehavior.Restrict);
            e.Property(a => a.CreatedAt).HasDefaultValueSql("now()");
        });

        b.Entity<IdCounter>(e =>
        {
            e.HasKey(c => new { c.BoardId, c.Prefix });
            e.HasOne<Board>().WithMany().HasForeignKey(c => c.BoardId).OnDelete(DeleteBehavior.Restrict);
            e.ToTable(t => t.HasCheckConstraint("ck_id_counters_next_number_positive", "next_number > 0"));
        });

        b.Entity<Record>(e =>
        {
            e.HasIndex(r => new { r.BoardId, r.Key }).IsUnique();
            e.HasIndex(r => new { r.BoardId, r.Kind }).HasFilter("archived_at IS NULL");
            e.HasIndex(r => r.ParentId);
            e.HasOne<Board>().WithMany().HasForeignKey(r => r.BoardId).OnDelete(DeleteBehavior.Restrict);
            e.HasOne<Record>().WithMany().HasForeignKey(r => r.ParentId).OnDelete(DeleteBehavior.Restrict);
            e.Property(r => r.Fields).HasColumnType("jsonb");
            e.Property(r => r.BlockedBy).HasDefaultValueSql("'{}'");
            e.ToTable(t =>
            {
                t.HasCheckConstraint(
                    "ck_records_kind",
                    "kind IN ('item', 'design', 'plan', 'task', 'sprint', 'milestone')"
                );
                // A task always has a plan, and nothing else has one.
                t.HasCheckConstraint("ck_records_task_has_parent", "(kind = 'task') = (parent_id IS NOT NULL)");
                // Prefix and number come together, or neither.
                t.HasCheckConstraint("ck_records_prefix_number", "(prefix IS NULL) = (number IS NULL)");
            });
        });

        b.Entity<Comment>(e =>
        {
            e.HasIndex(c => c.RecordId);
            e.Property(c => c.Seq).UseIdentityAlwaysColumn();
            e.HasOne<Record>().WithMany().HasForeignKey(c => c.RecordId).OnDelete(DeleteBehavior.Restrict);
            e.ToTable(t => t.HasCheckConstraint("ck_comments_kind", "kind IN ('comment', 'progress')"));
        });

        b.Entity<Attachment>(e =>
        {
            e.HasIndex(a => new { a.BoardId, a.Name }).IsUnique();
            e.HasIndex(a => a.Name);
            e.HasOne<Board>().WithMany().HasForeignKey(a => a.BoardId).OnDelete(DeleteBehavior.Restrict);
            e.Property(a => a.CreatedAt).HasDefaultValueSql("now()");
        });

        b.Entity<User>(e =>
        {
            e.HasIndex(u => u.Name).IsUnique();
            e.Property(u => u.CreatedAt).HasDefaultValueSql("now()");
        });

        b.Entity<Token>(e =>
        {
            e.HasIndex(t => t.Hash).IsUnique();
            e.HasIndex(t => new { t.UserId, t.Name }).IsUnique().HasFilter("revoked_at IS NULL");
            e.HasOne<User>().WithMany().HasForeignKey(t => t.UserId).OnDelete(DeleteBehavior.Restrict);
            e.Property(t => t.CreatedAt).HasDefaultValueSql("now()");
        });
    }
}
