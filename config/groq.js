// const Groq = require('groq-sdk');
// const dotenv = require('dotenv');
// dotenv.config();

// const apiKey = process.env.GROQ_API_KEY;

// if (!apiKey) {
//   throw new Error('Missing Groq API key. Please check your .env file.');
// }

// console.log('🔑 Groq API initialized' + (process.env.GROQ_API_KEY ? ' (using env variable)' : ' (using hardcoded key - consider using env variable)'));

// const groq = new Groq({
//   apiKey: apiKey
// });

// module.exports = groq;


const Groq = require('groq-sdk');
const { queryOne } = require('./database');

async function getGroqClient () {
  const row =  await queryOne(`
    SELECT GROQ_API_Key
    FROM ai_settings
    WHERE status = 'active'
    ORDER BY Modified_at DESC
    LIMIT 1
  `);

  if (!row?.GROQ_API_Key) {
    throw new Error('No active Grok API key found');
  }

  return new Groq({
    apiKey : row.GROQ_API_Key
  });
}

module.exports = { getGroqClient  };



