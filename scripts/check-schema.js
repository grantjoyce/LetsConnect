'use strict';

/**
 * Reports drift between schema.sql (the fresh-install DDL) and the live
 * database, in both directions.
 *
 * Nothing else enforces this. `npm run migrate` does NOT apply schema.sql, so
 * a column added by a migration and never mirrored into schema.sql will exist
 * on every migrated database and on none of the fresh ones - and the gap stays
 * invisible until someone reads schema.sql and believes it.
 *
 *   npm run check-schema              what has drifted
 *   npm run check-schema -- --emit    the DDL to close it
 *
 * This is a WARNING tool. It exits 0 even when it finds drift: schema.sql
 * lagging only makes the *next* fresh install wrong, not this database. It
 * exits non-zero only when the check itself could not run.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

const DB_NAME = process.env.DB_NAME || 'lets_connect';
const EMIT = process.argv.includes('--emit');

// Tables the app creates for itself at runtime, which deliberately do not
// belong in schema.sql.
const RUNTIME_TABLES = new Set(['sessions']);

/**
 * A line inside CREATE TABLE is a column only if its second token is a real
 * column type.
 *
 * Recognising types is deliberately used INSTEAD of blocklisting constraint
 * keywords. A blocklist reads every line it does not recognise as a column, so
 * the moment a constraint wraps onto a second line - which every multi-line
 * `CONSTRAINT ... FOREIGN KEY (...)\n REFERENCES other (id)` does - it invents
 * a column called "references" and reports drift that does not exist. An
 * allowlist of types fails the other way: an unrecognised line is ignored.
 */
const COLUMN_TYPES = new RegExp(
  '^(tinyint|smallint|mediumint|bigint|int|integer|decimal|numeric|float|double|real|bit|' +
    'boolean|bool|serial|date|datetime|timestamp|time|year|char|varchar|binary|varbinary|' +
    'tinyblob|blob|mediumblob|longblob|tinytext|text|mediumtext|longtext|enum|set|json|uuid|inet6)\\b',
  'i'
);

/** Pull table -> Set(column) out of schema.sql. */
function parseSchemaSql() {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8');
  const clean = sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');

  const tables = new Map();
  const re = /CREATE TABLE(?:\s+IF NOT EXISTS)?\s+`?(\w+)`?\s*\(([\s\S]*?)\n\)/gi;
  let m;
  while ((m = re.exec(clean)) !== null) {
    const [, table, body] = m;
    const cols = new Set();
    for (const rawLine of body.split('\n')) {
      const line = rawLine.trim().replace(/,$/, '');
      if (!line) continue;
      const parts = line.match(/^`?(\w+)`?\s+(.*)$/);
      if (!parts) continue;
      if (!COLUMN_TYPES.test(parts[2].trim())) continue;
      cols.add(parts[1].toLowerCase());
    }
    tables.set(table.toLowerCase(), cols);
  }
  return tables;
}

/** One column's DDL fragment, built from INFORMATION_SCHEMA. */
function columnDdl(col) {
  // COLUMN_TYPE is used VERBATIM and is never upper-cased: it carries the
  // literal values for enum/set, so `enum('all','none')` would silently become
  // `ENUM('ALL','NONE')` and change what the column can hold.
  let ddl = `\`${col.COLUMN_NAME}\` ${col.COLUMN_TYPE}`;
  if (col.IS_NULLABLE === 'NO') ddl += ' NOT NULL';

  if (col.COLUMN_DEFAULT !== null && col.COLUMN_DEFAULT !== undefined) {
    // MariaDB returns string defaults ALREADY quoted ('internal') but
    // expressions bare (current_timestamp(), 0). Emit verbatim - re-quoting
    // gives you '''internal'''.
    ddl += ` DEFAULT ${col.COLUMN_DEFAULT}`;
  } else if (col.IS_NULLABLE === 'YES') {
    ddl += ' DEFAULT NULL';
  }

  const extra = (col.EXTRA || '').trim();
  if (extra && extra.toLowerCase() !== 'auto_increment') ddl += ` ${extra.toUpperCase()}`;
  if (extra.toLowerCase() === 'auto_increment') ddl += ' AUTO_INCREMENT';
  return ddl;
}

/**
 * Order tables so a child never precedes the parent its foreign key points at.
 * Alphabetical order fails outright with "Foreign key constraint is
 * incorrectly formed".
 */
function dependencyOrder(tables, deps) {
  const done = new Set();
  const out = [];
  const visit = (t, seen = new Set()) => {
    if (done.has(t) || seen.has(t)) return;
    seen.add(t);
    for (const parent of deps.get(t) || []) {
      if (tables.includes(parent)) visit(parent, seen);
    }
    if (!done.has(t)) {
      done.add(t);
      out.push(t);
    }
  };
  tables.forEach((t) => visit(t));
  return out;
}

async function main() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: DB_NAME,
    charset: 'utf8mb4',
  });

  const declared = parseSchemaSql();

  const [dbCols] = await conn.query(
    `SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, EXTRA, ORDINAL_POSITION
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ?
      ORDER BY TABLE_NAME, ORDINAL_POSITION`,
    [DB_NAME]
  );

  const [fks] = await conn.query(
    `SELECT TABLE_NAME, REFERENCED_TABLE_NAME
       FROM information_schema.KEY_COLUMN_USAGE
      WHERE TABLE_SCHEMA = ? AND REFERENCED_TABLE_NAME IS NOT NULL`,
    [DB_NAME]
  );

  const live = new Map();
  for (const c of dbCols) {
    const t = c.TABLE_NAME.toLowerCase();
    if (RUNTIME_TABLES.has(t)) continue;
    if (!live.has(t)) live.set(t, []);
    live.get(t).push(c);
  }

  const deps = new Map();
  for (const fk of fks) {
    const t = fk.TABLE_NAME.toLowerCase();
    if (!deps.has(t)) deps.set(t, new Set());
    deps.get(t).add(fk.REFERENCED_TABLE_NAME.toLowerCase());
  }

  const missingTables = [...live.keys()].filter((t) => !declared.has(t));
  const phantomTables = [...declared.keys()].filter((t) => !live.has(t));

  const missingCols = []; // in the DB, absent from schema.sql
  const phantomCols = []; // in schema.sql, absent from the DB
  for (const [table, cols] of live) {
    if (!declared.has(table)) continue;
    const declaredCols = declared.get(table);
    for (const c of cols) {
      if (!declaredCols.has(c.COLUMN_NAME.toLowerCase())) missingCols.push({ table, col: c });
    }
    const liveNames = new Set(cols.map((c) => c.COLUMN_NAME.toLowerCase()));
    for (const name of declaredCols) {
      if (!liveNames.has(name)) phantomCols.push({ table, name });
    }
  }

  const clean =
    !missingTables.length && !phantomTables.length && !missingCols.length && !phantomCols.length;

  if (clean) {
    console.log('✅ schema.sql matches the database.');
    await conn.end();
    return;
  }

  if (EMIT) {
    console.log('-- Append to schema.sql to close the gap.\n');

    for (const table of dependencyOrder(missingTables, deps)) {
      const [rows] = await conn.query(`SHOW CREATE TABLE \`${table}\``);
      const ddl = String(rows[0]['Create Table']).replace(
        /^CREATE TABLE/i,
        'CREATE TABLE IF NOT EXISTS'
      );
      console.log(`${ddl};\n`);
    }

    const byTable = new Map();
    for (const { table, col } of missingCols) {
      if (!byTable.has(table)) byTable.set(table, []);
      byTable.get(table).push(col);
    }
    for (const [table, cols] of byTable) {
      console.log(`-- ${table}: add these column definitions to its CREATE TABLE block`);
      cols.forEach((c) => console.log(`  ${columnDdl(c)},`));
      console.log('');
    }

    if (phantomCols.length || phantomTables.length) {
      console.log('-- Present in schema.sql but NOT in this database. Either a migration');
      console.log('-- has not run here, or these were removed and schema.sql kept them:');
      phantomTables.forEach((t) => console.log(`--   table  ${t}`));
      phantomCols.forEach((c) => console.log(`--   column ${c.table}.${c.name}`));
    }

    await conn.end();
    return;
  }

  if (missingTables.length) {
    console.log(`⚠  schema.sql is missing ${missingTables.length} table(s) that the database has.`);
    missingTables.forEach((t) => console.log(`     ${t}`));
  }
  if (missingCols.length) {
    console.log(`⚠  schema.sql is missing ${missingCols.length} column(s) that the database has.`);
    missingCols.forEach(({ table, col }) => console.log(`     ${table}.${col.COLUMN_NAME}`));
  }
  if (phantomTables.length || phantomCols.length) {
    console.log(
      `⚠  schema.sql declares ${phantomTables.length} table(s) and ${phantomCols.length} column(s) ` +
        'this database does not have.'
    );
    phantomTables.forEach((t) => console.log(`     table  ${t}`));
    phantomCols.forEach(({ table, name }) => console.log(`     column ${table}.${name}`));
    console.log('     (Usually means a migration has not been run against this database.)');
  }

  console.log('\n   Fresh installs rely on schema.sql, so it should be brought back in line.');
  console.log('   Get the DDL: npm run check-schema -- --emit');

  await conn.end();
}

main().catch((err) => {
  console.error('ℹ Skipped the schema.sql check -', err.message);
  process.exit(1);
});
