using Microsoft.EntityFrameworkCore;

namespace PmBoard.Api.Data;

/// <summary>The shape is in server/docs/data-model.md.</summary>
public class BoardDb(DbContextOptions<BoardDb> options) : DbContext(options)
{
    public DbSet<Project> Projects => Set<Project>();
    public DbSet<IdCounter> IdCounters => Set<IdCounter>();
    public DbSet<Record> Records => Set<Record>();
    public DbSet<Comment> Comments => Set<Comment>();

    protected override void OnModelCreating(ModelBuilder b)
    {
        b.Entity<Project>(e =>
        {
            e.HasIndex(p => p.Slug).IsUnique();
            e.Property(p => p.Config).HasColumnType("jsonb");
            e.Property(p => p.CreatedAt).HasDefaultValueSql("now()");
        });

        b.Entity<IdCounter>(e =>
        {
            e.HasKey(c => new { c.ProjectId, c.Prefix });
            e.HasOne<Project>().WithMany().HasForeignKey(c => c.ProjectId).OnDelete(DeleteBehavior.Restrict);
            e.ToTable(t => t.HasCheckConstraint("ck_id_counters_next_number_positive", "next_number > 0"));
        });

        b.Entity<Record>(e =>
        {
            e.HasIndex(r => new { r.ProjectId, r.Key }).IsUnique();
            e.HasIndex(r => new { r.ProjectId, r.Kind }).HasFilter("archived_at IS NULL");
            e.HasIndex(r => r.ParentId);
            e.HasOne<Project>().WithMany().HasForeignKey(r => r.ProjectId).OnDelete(DeleteBehavior.Restrict);
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
    }
}
