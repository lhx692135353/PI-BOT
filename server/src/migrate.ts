import { readFile } from "node:fs/promises";
import { Database } from "./db.js";
import { settings } from "./config.js";
const versions = ["0001-baseline", "0002-message-progress", "0003-main-bot", "0004-agent-tasks", "0005-bot-skills", "0006-message-ui", "0007-async-tasks", "0008-memory-observability", "0009-always-on", "0010-multi-device", "0011-windows-devices", "0011-message-images", "0012-voice", "0013-goals", "0014-model-provider", "0015-provider-search", "0016-remote-environments", "0017-replies-conversations", "0018-runtime-reports", "0019-task-routing"];
export async function migrate(db: Database) {
  await db.tx(async (tx) => {
    await tx.rows("SELECT pg_advisory_xact_lock(7420261011)");
    await tx.rows(
      "CREATE TABLE IF NOT EXISTS schema_migrations(version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    for (const version of [...versions, "0017-push", "0020-saved-authorizations"]) {
      if (await tx.one("SELECT 1 FROM schema_migrations WHERE version=$1", [version]))
        continue;
      await tx.rows(
        await readFile(
          new URL(`../migrations/${version}.sql`, import.meta.url),
          "utf8",
        ),
      );
      await tx.rows("INSERT INTO schema_migrations(version) VALUES($1)", [
        version,
      ]);
    }
  });
}
if (process.argv[1]?.endsWith("/migrate.ts")) {
  const db = new Database(settings().databaseUrl);
  try {
    await migrate(db);
  } finally {
    await db.close();
  }
}
