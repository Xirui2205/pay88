package com.telebirr.gateway.agent.db

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase

@Database(
    entities = [
        SpoolEventEntity::class,
        JobExecutionEntity::class,
        SimFenceEntity::class,
        FinancialCommitGuardEntity::class,
        SmsEvidenceEntity::class,
        BalanceSnapshotEntity::class,
        SimIdentityEntity::class,
        BalanceQueryLeaseEntity::class,
    ],
    version = 4,
    exportSchema = true,
)
abstract class AgentDatabase : RoomDatabase() {
    abstract fun agentDao(): AgentDao

    companion object {
        @Volatile private var instance: AgentDatabase? = null

        fun get(context: Context): AgentDatabase = instance ?: synchronized(this) {
            instance ?: Room.databaseBuilder(
                context.applicationContext,
                AgentDatabase::class.java,
                "telebirr-agent-v1.db",
            )
                .addMigrations(MIGRATION_1_2, MIGRATION_2_3, MIGRATION_3_4)
                .build()
                .also { instance = it }
        }

        val MIGRATION_1_2 = object : Migration(1, 2) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("ALTER TABLE sms_evidence ADD COLUMN spoolEventId TEXT")
                db.execSQL("CREATE UNIQUE INDEX IF NOT EXISTS index_sms_evidence_spoolEventId ON sms_evidence(spoolEventId)")
            }
        }

        val MIGRATION_2_3 = object : Migration(2, 3) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL(
                    """
                    CREATE TABLE IF NOT EXISTS `spool_events_new` (
                        `id` TEXT NOT NULL,
                        `kind` TEXT NOT NULL,
                        `payloadIv` BLOB NOT NULL,
                        `payloadCiphertext` BLOB NOT NULL,
                        `createdAtMs` INTEGER NOT NULL,
                        `attemptCount` INTEGER NOT NULL,
                        `nextAttemptAtMs` INTEGER NOT NULL,
                        `acknowledgedAtMs` INTEGER,
                        `sequence` INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL
                    )
                    """.trimIndent(),
                )
                // Preserve the best causal order available in the legacy DB;
                // every new insert is ordered by the monotonic SQLite key.
                db.execSQL(
                    """
                    INSERT INTO `spool_events_new`
                        (`id`, `kind`, `payloadIv`, `payloadCiphertext`, `createdAtMs`,
                         `attemptCount`, `nextAttemptAtMs`, `acknowledgedAtMs`)
                    SELECT `id`, `kind`, `payloadIv`, `payloadCiphertext`, `createdAtMs`,
                           `attemptCount`, `nextAttemptAtMs`, `acknowledgedAtMs`
                    FROM `spool_events`
                    ORDER BY `createdAtMs`, `rowid`
                    """.trimIndent(),
                )
                db.execSQL("DROP TABLE `spool_events`")
                db.execSQL("ALTER TABLE `spool_events_new` RENAME TO `spool_events`")
                db.execSQL("CREATE UNIQUE INDEX IF NOT EXISTS `index_spool_events_id` ON `spool_events` (`id`)")
                db.execSQL("CREATE INDEX IF NOT EXISTS `index_spool_events_nextAttemptAtMs` ON `spool_events` (`nextAttemptAtMs`)")
                db.execSQL("CREATE INDEX IF NOT EXISTS `index_spool_events_acknowledgedAtMs` ON `spool_events` (`acknowledgedAtMs`)")
            }
        }

        val MIGRATION_3_4 = object : Migration(3, 4) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("ALTER TABLE `spool_events` ADD COLUMN `corruptAtMs` INTEGER")
                db.execSQL("ALTER TABLE `spool_events` ADD COLUMN `corruptReason` TEXT")
            }
        }
    }
}
