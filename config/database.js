const mysql = require('mysql2/promise');

// MySQL type constants
const MYSQL_TYPE_JSON = 0xf5; // 245 - JSON type
const MYSQL_TYPE_BLOB = 252;  // BLOB type (JSON_OBJECT can return this)

// Database configuration
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
  typeCast: function (field, next) {
    // Handle JSON fields - return as strings with UTF-8 encoding so we can parse them ourselves
    // JSON_OBJECT() results may come back as BLOB type, so we check both JSON columnType and known JSON column names
    const jsonColumnNames = ['resume', 'job_description', 'skills', 'experience', 'education', 'certifications', 'api_response'];
    
    // Check if it's a JSON column type, BLOB type (for JSON_OBJECT results), or a known JSON column name
    const isJsonType = field.columnType === MYSQL_TYPE_JSON || 
                       field.columnType === MYSQL_TYPE_BLOB ||
                       field.type === 'JSON' ||
                       jsonColumnNames.includes(field.name);
    
    if (isJsonType) {
      return field.string('utf8');
    }
    return next();
  }
};



// Create connection pool
const pool = mysql.createPool(dbConfig);

// Set timezone to UTC for all connections
pool.on('connection', (connection) => {
  connection.query("SET time_zone = '+00:00'", (err) => {
    if (err) {
      console.error('Error setting timezone to UTC:', err);
    }
  });
});

// Test connection with retry
const testConnection = async (retries = 3, delay = 2000) => {
  for (let i = 0; i < retries; i++) {
    try {
      const connection = await pool.getConnection();
      console.log('MySQL database connected successfully');
      connection.release();
      return true;
    } catch (error) {
      console.error(`Connection attempt ${i + 1} failed:`, error.message);
      if (i < retries - 1) {
        console.log(`Retrying in ${delay}ms...`);
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

// Test connection on startup
testConnection();

// Helper function to execute queries
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

// Helper function to get a single row
const queryOne = async (sql, params = []) => {
  const results = await query(sql, params);
  return results.length > 0 ? results[0] : null;
};

module.exports = {
  pool,
  query,
  queryOne
};
