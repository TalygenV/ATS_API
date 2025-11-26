const { GoogleGenerativeAI } = require('@google/generative-ai');
const dotenv = require('dotenv');
dotenv.config();
//const apiKey = process.env.GEMINI_API_KEY;
const apiKey = process.env.GEMINI_API_KEY ;
debugger;
if (!apiKey) {
  throw new Error('Missing Gemini API key. Please check your .env file.');
}

console.log('🔑 Gemini API initialized' + (process.env.GEMINI_API_KEY ? ' (using env variable)' : ' (using hardcoded key - consider using env variable)'));

const genAI = new GoogleGenerativeAI(apiKey);

module.exports = genAI;

