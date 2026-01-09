// Gemini API Configuration
// This module initializes and exports the Google Generative AI client
// The API key is loaded from environment variables

const { GoogleGenerativeAI } = require('@google/generative-ai');
const dotenv = require('dotenv');
dotenv.config();

// Get the Gemini API key from environment variables
const apiKey = process.env.GEMINI_API_KEY;

// Validate that the API key is provided
if (!apiKey) {
  throw new Error('Missing Gemini API key. Please check your .env file.');
}

// Initialize the Google Generative AI client with the API key
const genAI = new GoogleGenerativeAI(apiKey);

module.exports = genAI;

