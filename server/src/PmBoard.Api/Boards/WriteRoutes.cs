namespace PmBoard.Api.Boards;

/// <summary>
/// Every 0.x write route (pm-board-cli lib/dispatch.js ROUTE_TABLE), per board, under
/// /api/boards/{slug}. Each handler ports its 0.x handler; Task 7 puts auth in front of them.
/// </summary>
public static class WriteRoutes
{
    public static void MapWriteRoutes(this WebApplication app)
    {
        var g = app.MapGroup("/api/boards/{slug}");
        g.MapItemWrites();
        g.MapDesignWrites();
        g.MapPlanWrites();
        g.MapSprintWrites();
        g.MapContextRoutes();
        app.MapFileRoutes(g);
    }
}
