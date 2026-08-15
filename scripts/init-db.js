'use strict';

/**
 * Creates the database (if permitted) and applies schema.sql.
 *
 * schema.sql is CREATE TABLE IF NOT EXISTS throughout, so this is safe to run
 * against a database that already has data - it only adds what is missing.
 *
 * On a fresh Plesk install: Node.js -> Run script -> `init-db`, then `migrate`.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

const DB_NAME = process.env.DB_NAME || 'lets_connect';

/** Strip -- comments and split into individual statements. */
function splitStatements(sql) {
  return sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
}

async function main() {
  const base = {
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    charset: 'utf8mb4',
  };

  // Try to create the database. On shared hosting the app user usually cannot
  // do this - Plesk creates it for you - so a failure here is not fatal.
  try {
    const root = await mysql.createConnection(base);
    await root.query(
      `CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\` ` +
        'CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci'
    );
    await root.end();
    console.log(`✓ Database "${DB_NAME}" is present.`);
  } catch (err) {
    console.log(
      `ℹ Could not create the database (${err.code || err.message}). ` +
        'Assuming it already exists - this is normal on Plesk.'
    );
  }

  const conn = await mysql.createConnection({ ...base, database: DB_NAME });
  const sql = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8');
  const statements = splitStatements(sql);

  let created = 0;
  for (const stmt of statements) {
    await conn.query(stmt);
    const m = stmt.match(/CREATE TABLE IF NOT EXISTS\s+(\w+)/i);
    if (m) {
      const [rows] = await conn.query(
        'SELECT COUNT(*) AS n FROM information_schema.TABLES ' +
          'WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?',
        [DB_NAME, m[1]]
      );
      if (rows[0].n) {
        created += 1;
        console.log(`  ✓ ${m[1]}`);
      }
    }
  }
  await conn.end();

  console.log(`\n✅ schema.sql applied - ${created} table(s) present.`);
  console.log('   Next: npm run migrate');
}

main().catch((err) => {
  console.error('\n❌ init-db failed:', err.message);
  process.exit(1);
});
