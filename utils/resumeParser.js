const genAI = require('../config/gemini');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const fs = require('fs').promises;

async function extractTextFromFile(filePath, mimetype) {
  try {
    if (mimetype === 'application/pdf') {
      const dataBuffer = await fs.readFile(filePath);
      const data = await pdfParse(dataBuffer);
      return data.text;
    } else if (
      mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
      mimetype === 'application/msword'
    ) {
      const result = await mammoth.extractRawText({ path: filePath });
      return result.value;
    } else if (mimetype === 'text/plain') {
      return await fs.readFile(filePath, 'utf-8');
    } else {
      throw new Error('Unsupported file type');
    }
  } catch (error) {
    throw new Error(`Error extracting text: ${error.message}`);
  }
}

// Helper function to retry API calls with exponential backoff
async function retryWithBackoff(fn, maxRetries = 3, baseDelay = 1000) {
  let lastError;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const isNetworkError = error.message && (
        error.message.includes('fetch failed') ||
        error.message.includes('ECONNRESET') ||
        error.message.includes('ETIMEDOUT') ||
        error.message.includes('network') ||
        error.message.includes('timeout')
      );
      
      // Only retry on network errors, not on API errors (400, 401, 403, etc.)
      if (!isNetworkError || attempt === maxRetries) {
        throw error;
      }
      
      const delay = baseDelay * Math.pow(2, attempt - 1);
      console.log(`   ⚠️  Attempt ${attempt}/${maxRetries} failed, retrying in ${delay}ms...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}

async function parseResumeWithGemini(resumeText, fileName) {
  // List of models to try in order (using available models)
  // Note: gemini-2.0-flash might have network issues, so we try alternatives
  const modelsToTry = ['gemini-2.5-flash-lite'];
  
  const prompt = `Parse the following resume and extract all relevant information. Return the data in a structured JSON format with the following fields:

    - name: Full name of the person
    - email: Email address
    - phone: Phone number
    - location: COMPLETE FULL ADDRESS including street address, city, state/province, country, and zip/postal code if available. Include all address components mentioned in the resume. If only city/state is mentioned, include that but try to get the full address.
    - skills: Array of technical skills, programming languages, tools, frameworks, and soft skills (e.g., "JavaScript", "Project Management", "React", "Communication")
    - experience: Array of work experience objects, each with: company, position, duration, description, startDate (format: YYYY-MM or YYYY-MM-DD), endDate (format: YYYY-MM or YYYY-MM-DD or "Present" if current job)
    - total_experience: Calculate the EXACT total number of years of professional work experience. CRITICAL INSTRUCTIONS:
      * Extract startDate and endDate for EACH work experience entry
      * For current jobs, use today's date as endDate
      * Calculate the duration in years for EACH job: (endDate - startDate) in years (as decimal)
      * If dates overlap between jobs, DO NOT double-count. Use the earliest start date to the latest end date
      * If no dates but duration is mentioned (e.g., "2 years"), use that duration
      * Sum all unique, non-overlapping periods
      * Convert to decimal years: 1 year = 1.0, 6 months = 0.5, 3 months = 0.25, etc.
      * Return as a decimal number with 2 decimal places (e.g., 5.50, 3.00, 7.25)
      * Example: Job 1: Jan 2020 - Dec 2022 (3.0 years), Job 2: Jan 2023 - Present (1.5 years) = Total: 4.50 years
    - education: Array of education objects, each with: institution, degree, field, year
    - summary: Professional summary or objective
    - certifications: Array of certifications
    - fileName: The original file name
    
    IMPORTANT RULES:
    1. For total_experience: Calculate precisely from dates. If dates are missing, use duration strings. Ensure no double-counting of overlapping periods.
    2. For location: Extract the COMPLETE address with all available components (street, city, state, country, zip code).
    
    Resume text:
    ${resumeText}
    
    Return ONLY valid JSON, no additional text or markdown formatting.`;

  let lastError = null;
  
  // Try each model until one works
  for (const modelName of modelsToTry) {
    try {
      console.log(`   🔄 Trying model: ${modelName}`);
      
      const model = genAI.getGenerativeModel({ model: modelName });
      
      // Retry API call with exponential backoff
      const result = await retryWithBackoff(async () => {
        return await model.generateContent(prompt);
      }, 3, 2000);
      
      const response = await result.response;
      const text = response.text();
      console.log(`   ✅ Got response from ${modelName}`);

      // Clean the response to extract JSON
      let jsonText = text.trim();
      
      // Remove null bytes and other control characters that can corrupt JSON
      // Replace null bytes (\u0000) and other problematic control characters
      jsonText = jsonText.replace(/\u0000/g, ''); // Remove null bytes
      jsonText = jsonText.replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F]/g, ''); // Remove other control chars except \n, \r, \t
      
      // Remove markdown code blocks if present
      jsonText = jsonText.replace(/```json\n?/g, '').replace(/```\n?/g, '');
      
      // Try to extract JSON from the response
      const jsonMatch = jsonText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        jsonText = jsonMatch[0];
        // Clean again after extraction in case the match included some control chars
        jsonText = jsonText.replace(/\u0000/g, '').replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F]/g, '');
      }

      // Validate that we have valid JSON text before parsing
      if (!jsonText || jsonText.trim().length === 0) {
        throw new Error('Empty or invalid JSON response from Gemini API');
      }

      let parsedData;
      try {
        parsedData = JSON.parse(jsonText);
      } catch (parseError) {
        // Log the problematic JSON for debugging
        console.error(`   ❌ JSON Parse Error: ${parseError.message}`);
        console.error(`   ❌ JSON text length: ${jsonText.length}`);
        console.error(`   ❌ JSON preview (first 500 chars): ${jsonText.substring(0, 500)}`);
        throw new Error(`Failed to parse JSON response: ${parseError.message}. Response may contain invalid characters.`);
      }
      
      // Add fileName if not present
      if (!parsedData.fileName) {
        parsedData.fileName = fileName;
      }

      // Post-process and validate data
      parsedData = validateAndCleanData(parsedData);
      
      console.log(`   ✅ Successfully parsed resume with ${modelName}`);

      return parsedData;
    } catch (error) {
      lastError = error;
      const errorMsg = error.message || 'Unknown error';
      
      // If it's a 404 (model not found), try the next model
      if (errorMsg.includes('404') || errorMsg.includes('not found')) {
        console.log(`   ⚠️  Model ${modelName} not available, trying next model...`);
        continue;
      }
      
      // If it's a network error, try the next model
      if (errorMsg.includes('fetch failed') || errorMsg.includes('network') || errorMsg.includes('ECONNRESET') || errorMsg.includes('ETIMEDOUT')) {
        console.log(`   ⚠️  Network error with ${modelName}: ${errorMsg}, trying next model...`);
        continue;
      }
      
      // For API errors (401, 403, etc.), log and try next model
      if (errorMsg.includes('401') || errorMsg.includes('403') || errorMsg.includes('429')) {
        console.log(`   ⚠️  API error with ${modelName}: ${errorMsg}, trying next model...`);
        continue;
      }
      
      // For other errors, log and try next model
      console.log(`   ⚠️  Error with ${modelName}: ${errorMsg}, trying next model...`);
      continue;
    }
  }
  
  // If all models failed, throw the last error with more context
  const errorDetails = lastError?.message || 'Unknown error';
  console.error(`   ❌ All models failed. Last error: ${errorDetails}`);
  throw new Error(`Error parsing resume with Gemini: All models failed. Last error: ${errorDetails}. Please check your API key and network connection.`);
}

/**
 * Validate and clean parsed resume data
 */
function validateAndCleanData(parsedData) {
  // Validate and format total_experience
  if (parsedData.total_experience !== null && parsedData.total_experience !== undefined) {
    const exp = parseFloat(parsedData.total_experience);
    if (!isNaN(exp) && exp >= 0) {
      parsedData.total_experience = Math.round(exp * 100) / 100; // Round to 2 decimal places
    } else {
      parsedData.total_experience = null;
    }
  }

  // Ensure location is a string (not array)
  if (parsedData.location && Array.isArray(parsedData.location)) {
    parsedData.location = parsedData.location.join(', ');
  }

  return parsedData;
}

module.exports = {
  extractTextFromFile,
  parseResumeWithGemini
};

