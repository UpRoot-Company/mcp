import Database from "better-sqlite3";
import { MIGRATIONS } from "./Migrations.js";

export class MigrationRunner {
    constructor(private readonly db: Database.Database) {}

    public run(): void {
        const current = this.getCurrentVersion();
        const pending = MIGRATIONS.filter(m => m.version > current).sort((a, b) => a.version - b.version);
        if (pending.length === 0) {
            return;
        }

        const tx = this.db.transaction(() => {
            for (const migration of pending) {
                migration.up(this.db);
                this.setCurrentVersion(migration.version);
            }
        });
        tx();
    }

    private getCurrentVersion(): number {
        try {
            const row = this.db
                .prepare(`SELECT value FROM metadata WHERE key = 'schema_version'`)
                .get() as { value?: string } | undefined;
            const parsed = row?.value ? parseInt(row.value, 10) : 0;
            return Number.isFinite(parsed) ? parsed : 0;
        } catch {
            return 0;
        }
    }

    private setCurrentVersion(version: number): void {
        this.db.prepare(
            `INSERT OR REPLACE INTO metadata(key, value) VALUES ('schema_version', ?)`
        ).run(String(version));
    }
}

