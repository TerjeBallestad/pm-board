using System.Collections.Concurrent;
using System.Text.Json;
using System.Threading.Channels;
using Microsoft.EntityFrameworkCore;
using Npgsql;
using PmBoard.Api.Data;

namespace PmBoard.Api.Boards;

/// <summary>A change on a board, in 0.x's event shape: entity item|design|plan|sprint|milestone, the key, and the action.</summary>
public record BoardEvent(Guid Board, string Entity, string Id, string Action);

/// <summary>
/// Listens on the Postgres channel board_changes (the triggers in migration BoardChangeNotify) and
/// hands each change to the browsers that watch that board. One connection for the whole server.
/// If it drops, it reconnects, and each watcher gets a "resync" so it loads the board again.
/// </summary>
public sealed class BoardEvents(NpgsqlDataSource dataSource, ILogger<BoardEvents> log) : BackgroundService
{
    private readonly ConcurrentDictionary<Guid, Channel<BoardEvent>> _watchers = new();

    /// <summary>A watcher's queue. Bounded: a browser that stops reading loses old events, never the server's memory.</summary>
    public (Guid Id, ChannelReader<BoardEvent> Reader) Watch()
    {
        var ch = Channel.CreateBounded<BoardEvent>(new BoundedChannelOptions(256) { FullMode = BoundedChannelFullMode.DropOldest });
        var id = Guid.NewGuid();
        _watchers[id] = ch;
        return (id, ch.Reader);
    }

    public void Unwatch(Guid id)
    {
        if (_watchers.TryRemove(id, out var ch)) ch.Writer.TryComplete();
    }

    /// <summary>True once the LISTEN is in place. Tests wait for it.</summary>
    public bool Listening { get; private set; }

    private void Publish(BoardEvent e)
    {
        foreach (var ch in _watchers.Values) ch.Writer.TryWrite(e);
    }

    protected override async Task ExecuteAsync(CancellationToken stop)
    {
        var first = true;
        while (!stop.IsCancellationRequested)
        {
            try
            {
                await using var conn = await dataSource.OpenConnectionAsync(stop);
                conn.Notification += (_, n) =>
                {
                    try
                    {
                        var e = JsonSerializer.Deserialize<NotifyPayload>(n.Payload);
                        if (e is not null) Publish(new BoardEvent(e.board, e.entity, e.id, e.action));
                    }
                    catch (JsonException ex)
                    {
                        log.LogWarning(ex, "Unreadable board_changes payload {Payload}", n.Payload);
                    }
                };
                await using (var cmd = new NpgsqlCommand("LISTEN board_changes", conn))
                {
                    await cmd.ExecuteNonQueryAsync(stop);
                }
                Listening = true;
                if (!first)
                {
                    // Changes may have happened while the connection was down.
                    Publish(new BoardEvent(Guid.Empty, "board", "", "resync"));
                }
                first = false;
                while (!stop.IsCancellationRequested)
                {
                    await conn.WaitAsync(stop);
                }
            }
            catch (OperationCanceledException) when (stop.IsCancellationRequested)
            {
                return;
            }
            catch (Exception ex)
            {
                Listening = false;
                log.LogWarning(ex, "Lost the board_changes listener, reconnecting in 2 s");
                await Task.Delay(TimeSpan.FromSeconds(2), stop).ContinueWith(_ => { });
            }
        }
    }

    private sealed record NotifyPayload(Guid board, string entity, string id, string action);
}

public static class EventRoutes
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    /// <summary>
    /// GET /api/boards/{slug}/events: a server-sent event stream with 0.x's payload,
    /// data: {"entity":"item","id":"SB-042","action":"update"}. A "resync" event asks the client to load
    /// the whole board again. A comment line every 30 s keeps proxies from closing the stream.
    /// </summary>
    public static void MapEventRoutes(this WebApplication app)
    {
        app.MapGet(
            "/api/boards/{slug}/events",
            async (string slug, HttpContext http, BoardDb db, BoardEvents events) =>
            {
                var board = await db.Boards.AsNoTracking().Where(p => p.Slug == slug).Select(p => (Guid?)p.Id).SingleOrDefaultAsync();
                if (board is null)
                {
                    http.Response.StatusCode = 404;
                    return;
                }
                var ct = http.RequestAborted;
                http.Response.Headers.ContentType = "text/event-stream";
                http.Response.Headers.CacheControl = "no-cache";
                http.Response.Headers["X-Accel-Buffering"] = "no";
                var (id, reader) = events.Watch();
                try
                {
                    await http.Response.WriteAsync(": connected\n\n", ct);
                    await http.Response.Body.FlushAsync(ct);
                    while (!ct.IsCancellationRequested)
                    {
                        using var tick = CancellationTokenSource.CreateLinkedTokenSource(ct);
                        tick.CancelAfter(TimeSpan.FromSeconds(30));
                        string line;
                        try
                        {
                            var e = await reader.ReadAsync(tick.Token);
                            if (e.Board != board && e.Action != "resync") continue;
                            line = "data: " + JsonSerializer.Serialize(new { entity = e.Entity, id = e.Id, action = e.Action }, Json) + "\n\n";
                        }
                        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
                        {
                            line = ": keepalive\n\n";
                        }
                        await http.Response.WriteAsync(line, ct);
                        await http.Response.Body.FlushAsync(ct);
                    }
                }
                catch (OperationCanceledException) { }
                catch (ChannelClosedException) { }
                finally
                {
                    events.Unwatch(id);
                }
            }
        );
    }
}
