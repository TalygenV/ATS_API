// Database Configuration and Connection Pool
// This module manages MySQL database connections using a connection pool
// Handles JSON field parsing and timezone configuration

const mysql = require('mysql2/promise');

// MySQL type constants for field type detection
const MYSQL_TYPE_JSON = 0xf5; // 245 - JSON type
const MYSQL_TYPE_BLOB = 252;  // BLOB type (JSON_OBJECT can return this)

// Database connection configuration
// Uses environment variables with fallback defaults
const dbConfig = {
  host: process.env.DB_HOST || '174.127.114.194',
  user: process.env.DB_USER || 'seth',
  password: process.env.DB_PASSWORD || '@Password1#',
  database: process.env.DB_NAME || 'ats_system_stage',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  charset: 'utf8mb4',
  timezone: '+00:00', // Set timezone to UTC
  connectTimeout: 60000, // 60 seconds
  acquireTimeout: 60000, // 60 seconds
  timeout: 60000, // 60 seconds
  enableKeepAlive: true,
  keepAliveInitialDelay: 0,
  /**
   * Custom type casting function for MySQL fields
   * Handles JSON fields by returning them as UTF-8 strings for manual parsing
   * This is necessary because JSON_OBJECT() results may come back as BLOB type
   * 
   * @param {Object} field - MySQL field metadata
   * @param {Function} next - Default type casting function
   * @returns {string|*} UTF-8 string for JSON fields, default casting for others
   */
  typeCast: function (field, next) {
    // Handle JSON fields - return as strings with UTF-8 encoding so we can parse them ourselves
    // JSON_OBJECT() results may come back as BLOB type, so we check both JSON columnType and known JSON column names
    const jsonColumnNames = ['resume', 'job_description', 'skills', 'experience', 'education', 'certifications', 'api_response'];
    
    // Check if it's a JSON column type, BLOB type (for JSON_OBJECT results), or a known JSON column name
    const isJsonType = field.columnType === MYSQL_TYPE_JSON || 
                       field.columnType === MYSQL_TYPE_BLOB ||
                       field.type === 'JSON' ||
                       jsonColumnNames.includes(field.name);
    
    // Return JSON fields as UTF-8 strings for manual parsing
    if (isJsonType) {
      return field.string('utf8');
    }
    // Use default type casting for non-JSON fields
    return next();
  }
};



// Create MySQL connection pool
// Connection pool manages multiple database connections efficiently
const pool = mysql.createPool(dbConfig);

// Set timezone to UTC for all new connections
// Ensures consistent datetime handling across the application
pool.on('connection', (connection) => {
  connection.query("SET time_zone = '+00:00'", (err) => {
    if (err) {
      console.error('Error setting timezone to UTC:', err);
    }
  });
});

/**
 * Test database connection with retry logic
 * Attempts to connect to the database with exponential backoff
 * 
 * @param {number} retries - Maximum number of connection attempts (default: 3)
 * @param {number} delay - Initial delay between retries in milliseconds (default: 2000)
 * @returns {Promise<boolean>} True if connection successful, false otherwise
 */
const testConnection = async (retries = 3, delay = 2000) => {
  for (let i = 0; i < retries; i++) {
    try {
      const connection = await pool.getConnection();
      connection.release();
      return true;
    } catch (error) {
      if (i < retries - 1) {
        await new Promise(resolve => setTimeout(resolve, delay));
      } else {
        console.error('Failed to connect to MySQL database after', retries, 'attempts');
        console.error('Please check:');
        console.error('1. Database server is running and accessible');
        console.error('2. Database credentials are correct');
        console.error('3. Network connectivity to', dbConfig.host);
        console.error('4. Firewall allows connections on MySQL port (usually 3306)');
      }
    }
  }
  return false;
};

// Test database connection on application startup
testConnection();

/**
 * Execute a SQL query with parameters
 * Uses prepared statements to prevent SQL injection
 * 
 * @param {string} sql - SQL query string with placeholders (?)
 * @param {Array} params - Array of parameter values to bind to placeholders
 * @returns {Promise<Array>} Query results array
 * @throws {Error} If query execution fails
 */
const query = async (sql, params = []) => {
  try {
    const [results] = await pool.execute(sql, params);
    return results;
  } catch (error) {
    console.error('Database query error:', error);
    if (error.code === 'ETIMEDOUT' || error.code === 'ECONNREFUSED') {
      console.error('Database connection timeout or refused. Please check:');
      console.error('1. Database server is running');
      console.error('2. Network connectivity');
      console.error('3. Database credentials are correct');
      console.error('4. Firewall allows connections');
    }
    throw error;
  }
};

/**
 * Execute a SQL query and return a single row
 * Convenience function for queries that expect exactly one result
 * 
 * @param {string} sql - SQL query string with placeholders (?)
 * @param {Array} params - Array of parameter values to bind to placeholders
 * @returns {Promise<Object|null>} First row from results, or null if no results
 * @throws {Error} If query execution fails
 */
const queryOne = async (sql, params = []) => {
  const results = await query(sql, params);
  return results.length > 0 ? results[0] : null;
};

module.exports = {
  pool,
  query,
  queryOne
};
