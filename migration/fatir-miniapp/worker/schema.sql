-- Staging only: Workflow replay protection. Additional discussion tables require migration.
CREATE TABLE IF NOT EXISTS workflow_nonces (
  nonce TEXT PRIMARY KEY NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_workflow_nonces_created ON workflow_nonces(created_at);
