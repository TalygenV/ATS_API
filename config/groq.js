// Groq API Configuration
// This module provides a function to get a Groq client instance
// The API key is retrieved from the database (ai_settings table) instead of environment variables
// This allows for dynamic API key management without requiring server restarts

// Legacy code - previously used environment variables for API key
// const Groq = require('groq-sdk');
// const dotenv = require('dotenv');
// dotenv.config();

// const apiKey = process.env.GROQ_API_KEY;

// if (!apiKey) {
//   throw new Error('Missing Groq API key. Please check your .env file.');
// }

// console.log('Groq API initialized' + (process.env.GROQ_API_KEY ? ' (using env variable)' : ' (using hardcoded key - consider using env variable)'));

// const groq = new Groq({
//   apiKey: apiKey
// });

// module.exports = groq;

const Groq = require('groq-sdk');
const { queryOne } = require('./database');

/**
 * Get a Groq client instance with API key from database
 * Retrieves the most recently modified active API key from the ai_settings table
 * 
 * @returns {Promise<Groq>} Configured Groq client instance
 * @throws {Error} If no active API key is found in the database
 */
async function getGroqClient () {
  // Query the database for the most recent active Groq API key
  const row =  await queryOne(`
    SELECT GROQ_API_Key
    FROM ai_settings
    WHERE status = 'active'
    ORDER BY Modified_at DESC
    LIMIT 1
  `);

  // Validate that an API key was found
  if (!row?.GROQ_API_Key) {
    throw new Error('No active Grok API key found');
  }

  // Create and return a new Groq client instance with the retrieved API key
  return new Groq({
    apiKey : row.GROQ_API_Key
  });
}

module.exports = { getGroqClient  };



