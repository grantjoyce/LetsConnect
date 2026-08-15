'use strict';

/**
 * Adds the audit_log table - who did what, in the admin area.
 *
 * WHY actor_email IS DENORMALISED
 * -------------------------------
 * The actor's email is copied in at write time and kept even after the user
 * row is gone. This app can now delete accounts outright (right to erasure),
 * and a foreign key alone would blank the actor on every historic entry the
 * moment somebody left - turning the log into a list of anonymous events at
 * exactly the point you most want to know who did them.
 *
 * The FK is still there and set to ON DELETE SET NULL, so `actor_user_id`
 * degrades to null while the readable record survives.
 *
 * Idempotent.
 */

const { pool, query, queryOne } = require('../db');

async function run() {
  const dbName = process.env.DB_NAME || 'lets_connect';

  const table = await queryOne(
    `SELECT TABLE_NAME FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'audit_log'`,
    [dbName]
  );
  if (table) return 'already present';

  await query(
    `CREATE TABLE audit_log (
       id            INT AUTO_INCREMENT PRIMARY KEY,
       actor_user_id INT NULL,
       actor_email   VARCHAR(191) NULL,
       action        VARCHAR(60) NOT NULL,
       target_type   VARCHAR(40) NULL,
       target_id     INT NULL,
       target_label  VARCHAR(255) NULL,
       detail        TEXT NULL,
       ip            VARCHAR(64) NULL,
       created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
       KEY idx_audit_created (created_at),
       KEY idx_audit_action (action),
       KEY idx_audit_actor (actor_user_id),
       CONSTRAINT fk_audit_actor FOREIGN KEY (actor_user_id)
         REFERENCES users (id) ON DELETE SET NULL
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
  );

  return 'audit_log created';
}

module.exports = { run };

if (require.main === module) {
  run()
    .then((s) => {
      console.log(`✅ ${s}`);
      return pool.end();
    })
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('❌', err.message);
      process.exit(1);
    });
}
