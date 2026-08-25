DROP TRIGGER IF EXISTS contribution_write_intents_no_update ON contribution_write_intents;
DROP FUNCTION IF EXISTS contribution_write_intents_immutable();
DROP TABLE IF EXISTS contribution_write_intents;
