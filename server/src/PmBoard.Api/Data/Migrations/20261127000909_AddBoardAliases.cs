using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace PmBoard.Api.Data.Migrations
{
    /// <inheritdoc />
    public partial class AddBoardAliases : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "board_aliases",
                columns: table => new
                {
                    slug = table.Column<string>(type: "text", nullable: false),
                    board_id = table.Column<Guid>(type: "uuid", nullable: false),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false, defaultValueSql: "now()")
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_board_aliases", x => x.slug);
                    table.ForeignKey(
                        name: "fk_board_aliases_boards_board_id",
                        column: x => x.board_id,
                        principalTable: "boards",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateIndex(
                name: "ix_board_aliases_board_id",
                table: "board_aliases",
                column: "board_id");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "board_aliases");
        }
    }
}
