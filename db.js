'use strict';

require('dotenv').config();
const mysql = require('mysql2/promise');

// One shared pool for the whole app. connectionLimit is deliberately small -
// shared hosting does not appreciate a large pool per worker, and Passenger
// runs several workers.
const pool = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'lets_connect',
  waitForConnections: true,
  connectionLimit: 5,
  queueLimit: 0,
  charset: 'utf8mb4',
  // DATE columns come back as 'YYYY-MM-DD' strings rather than JS Dates, so
  // they can never take a timezone shift on the way to the browser.
  dateStrings: ['DATE'],
});

async function query(sql, params) {
  const [rows] = await pool.query(sql, params);
  return rows;
}

async function queryOne(sql, params) {
  const rows = await query(sql, params);
  return rows.length ? rows[0] : null;
}

module.exports = { pool, query, queryOne };
