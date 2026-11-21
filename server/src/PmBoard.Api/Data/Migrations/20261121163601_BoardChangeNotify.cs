using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace PmBoard.Api.Data.Migrations
{
    /// <summary>
    /// Every change to a record or a comment sends a notification on the channel board_changes, as
    /// {"board": uuid, "entity": "item", "id": "SB-042", "action": "update"}, the event 0.x sent to
    /// the dashboard. A task's change is its plan's update. The trigger catches every writer, also a
    /// fix made by hand in psql, so the dashboard never shows stale data.
    /// </summary>
    public partial class BoardChangeNotify : Migration
    {
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.Sql(
                """
                CREATE FUNCTION notify_board_change(p_board uuid, p_record records, p_action text)
                RETURNS void LANGUAGE plpgsql AS $$
                DECLARE
                  v_entity text := p_record.kind;
                  v_key text := p_record.key;
                  v_action text := p_action;
                BEGIN
                  IF p_record.kind = 'task' THEN
                    SELECT 'plan', r.key INTO v_entity, v_key FROM records r WHERE r.id = p_record.parent_id;
                    v_action := 'update';
                  END IF;
                  IF v_key IS NULL THEN
                    RETURN;
                  END IF;
                  PERFORM pg_notify(
                    'board_changes',
                    json_build_object('board', p_board, 'entity', v_entity, 'id', v_key, 'action', v_action)::text
                  );
                END $$;

                CREATE FUNCTION records_changed() RETURNS trigger LANGUAGE plpgsql AS $$
                BEGIN
                  IF TG_OP = 'INSERT' THEN
                    PERFORM notify_board_change(NEW.board_id, NEW, 'create');
                  ELSIF TG_OP = 'DELETE' THEN
                    PERFORM notify_board_change(OLD.board_id, OLD, 'delete');
                  ELSIF OLD.archived_at IS NULL AND NEW.archived_at IS NOT NULL THEN
                    PERFORM notify_board_change(NEW.board_id, NEW, 'archive');
                  ELSE
                    PERFORM notify_board_change(NEW.board_id, NEW, 'update');
                  END IF;
                  RETURN NULL;
                END $$;

                CREATE TRIGGER records_changed AFTER INSERT OR UPDATE OR DELETE ON records
                  FOR EACH ROW EXECUTE FUNCTION records_changed();

                CREATE FUNCTION comments_changed() RETURNS trigger LANGUAGE plpgsql AS $$
                DECLARE
                  r records;
                BEGIN
                  SELECT * INTO r FROM records WHERE id = COALESCE(NEW.record_id, OLD.record_id);
                  IF FOUND THEN
                    PERFORM notify_board_change(r.board_id, r, 'update');
                  END IF;
                  RETURN NULL;
                END $$;

                CREATE TRIGGER comments_changed AFTER INSERT OR UPDATE OR DELETE ON comments
                  FOR EACH ROW EXECUTE FUNCTION comments_changed();
                """
            );
        }

        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.Sql(
                """
                DROP TRIGGER comments_changed ON comments;
                DROP FUNCTION comments_changed();
                DROP TRIGGER records_changed ON records;
                DROP FUNCTION records_changed();
                DROP FUNCTION notify_board_change(uuid, records, text);
                """
            );
        }
    }
}
