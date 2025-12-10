const Groq = require('groq-sdk');
const dotenv = require('dotenv');
dotenv.config();

const apiKey = process.env.GROQ_API_KEY;

if (!apiKey) {
  throw new Error('Missing Groq API key. Please check your .env file.');
}

console.log('🔑 Groq API initialized' + (process.env.GROQ_API_KEY ? ' (using env variable)' : ' (using hardcoded key - consider using env variable)'));

const groq = new Groq({
  apiKey: apiKey
});

module.exports = groq;
