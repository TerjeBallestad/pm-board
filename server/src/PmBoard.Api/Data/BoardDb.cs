using Microsoft.EntityFrameworkCore;

namespace PmBoard.Api.Data;

// The tables come in PLAN-001 Task 4 (projects, id counters, items, plan tasks).
public class BoardDb(DbContextOptions<BoardDb> options) : DbContext(options);
