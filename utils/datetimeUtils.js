/**
 * UTC DateTime Utility Functions
 * 
 * This module provides utilities for handling datetime operations in UTC
 * to ensure consistency across the application.
 */

/**
 * Converts a date to UTC format for database storage
 * Accepts: Date object, ISO string, or MySQL datetime string
 * Returns: MySQL datetime string in UTC (YYYY-MM-DD HH:mm:ss)
 */
function toUTCString(date) {
  if (!date) {
    return null;
  }

  let dateObj;
  
  if (date instanceof Date) {
    dateObj = date;
  } else if (typeof date === 'string') {
    // Handle ISO string or MySQL datetime string
    dateObj = new Date(date);
  } else {
    return null;
  }

  // Check if date is valid
  if (isNaN(dateObj.getTime())) {
    return null;
  }

  // Convert to UTC and format as MySQL datetime string
  const year = dateObj.getUTCFullYear();
  const month = String(dateObj.getUTCMonth() + 1).padStart(2, '0');
  const day = String(dateObj.getUTCDate()).padStart(2, '0');
  const hours = String(dateObj.getUTCHours()).padStart(2, '0');
  const minutes = String(dateObj.getUTCMinutes()).padStart(2, '0');
  const seconds = String(dateObj.getUTCSeconds()).padStart(2, '0');

  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

/**
 * Converts a database datetime value to UTC Date object
 * Accepts: MySQL datetime string or Date object
 * Returns: Date object in UTC
 */
function fromUTCString(dateString) {
  if (!dateString) {
    return null;
  }

  // If already a Date object, return it
  if (dateString instanceof Date) {
    return new Date(dateString.toISOString());
  }

  // If it's a string, parse it
  if (typeof dateString === 'string') {
    // Handle MySQL datetime format (YYYY-MM-DD HH:mm:ss)
    // or ISO format
    let dateObj;
    
    if (dateString.includes('T')) {
      // ISO format
      dateObj = new Date(dateString);
    } else {
      // MySQL datetime format - treat as UTC
      dateObj = new Date(dateString + 'Z');
    }

    if (isNaN(dateObj.getTime())) {
      return null;
    }

    return dateObj;
  }

  return null;
}

/**
 * Gets current UTC datetime as MySQL datetime string
 * Returns: MySQL datetime string in UTC (YYYY-MM-DD HH:mm:ss)
 */
function getCurrentUTCString() {
  return toUTCString(new Date());
}

/**
 * Gets current UTC datetime as Date object
 * Returns: Date object in UTC
 */
function getCurrentUTCDate() {
  return new Date();
}

/**
 * Converts a date to UTC ISO string
 * Accepts: Date object, ISO string, or MySQL datetime string
 * Returns: ISO string in UTC
 */
function toUTCISOString(date) {
  const dateObj = fromUTCString(date);
  if (!dateObj) {
    return null;
  }
  return dateObj.toISOString();
}

/**
 * Converts database result objects to have UTC datetime strings
 * Recursively processes objects and converts datetime fields
 */
function convertResultToUTC(result) {
  if (!result) {
    return result;
  }

  // List of common datetime field names in the database
  const datetimeFields = [
    'created_at',
    'updated_at',
    'expires_at',
    'start_time',
    'end_time',
    'interview_date',
    'timestamp'
  ];

  if (Array.isArray(result)) {
    return result.map(item => convertResultToUTC(item));
  }

  if (typeof result === 'object') {
    const converted = { ...result };
    
    for (const key in converted) {
      // Check if this is a datetime field
      if (datetimeFields.includes(key) && converted[key]) {
        const dateObj = fromUTCString(converted[key]);
        if (dateObj) {
          // Convert to UTC ISO string for API responses
          converted[key] = dateObj.toISOString();
        }
      } else if (typeof converted[key] === 'object' && converted[key] !== null) {
        // Recursively process nested objects
        converted[key] = convertResultToUTC(converted[key]);
      }
    }

    return converted;
  }

  return result;
}

module.exports = {
  toUTCString,
  fromUTCString,
  getCurrentUTCString,
  getCurrentUTCDate,
  toUTCISOString,
  convertResultToUTC
};

