require('dotenv').config();
const { Pool } = require('pg');

// One shared connection pool for the whole backend
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
});

module.exports = pool;
