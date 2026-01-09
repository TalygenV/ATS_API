// Resume Parser Utility
// This module handles text extraction from resume files and parsing using AI
// Supports multiple file formats: PDF, DOC, DOCX, and TXT
// Uses Groq AI for resume parsing with retry logic for reliability

// const groq = require('../config/groq');
const { getGroqClient } = require('../config/groq')
const pdfParse = require('pdf-parse');
const PDFParser = require('pdf2json');
const mammoth = require('mammoth');
const fs = require('fs').promises;

// Legacy implementation - simple text extraction without fallback
// async function extractTextFromFile(filePath, mimetype) {
//   try {
//     if (mimetype === 'application/pdf') {
//       const dataBuffer = await fs.readFile(filePath);
//       const data = await pdfParse(dataBuffer);
//       return data.text;
//     } else if (
//       mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
//       mimetype === 'application/msword'
//     ) {
//       const result = await mammoth.extractRawText({ path: filePath });
//       return result.value;
//     } else if (mimetype === 'text/plain') {
//       return await fs.readFile(filePath, 'utf-8');
//     } else {
//       throw new Error('Unsupported file type');
//     }
//   } catch (error) {
//     throw new Error(`Error extracting text: ${error.message}`);
//   }
// }

/**
 * Extract text content from a resume file
 * Supports PDF, DOC, DOCX, and TXT file formats
 * 
 * @param {string} filePath - Path to the resume file
 * @param {string} mimetype - MIME type of the file
 * @returns {Promise<string>} Extracted text content from the file
 * @throws {Error} If file type is unsupported or extraction fails
 */
async function extractTextFromFile(filePath, mimetype) {
  try {
    if (mimetype === 'application/pdf') {
      const dataBuffer = await fs.readFile(filePath);
      return await extractTextFromPDF(dataBuffer);
    }
    else if (
      mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
      mimetype === 'application/msword'
    ) {
      const result = await mammoth.extractRawText({ path: filePath });
      return result.value;
    }
    else if (mimetype === 'text/plain') {
      return await fs.readFile(filePath, 'utf-8');
    }
    else {
      throw new Error('Unsupported file type');
    }

  } catch (error) {
    throw new Error(`Error extracting text: ${error.message}`);
  }
}

/**
 * Extract text from PDF file buffer
 * Uses pdf-parse as primary method, falls back to pdf2json if needed
 * This dual-approach handles various PDF formats and encoding issues
 * 
 * @param {Buffer} dataBuffer - PDF file buffer
 * @returns {Promise<string>} Extracted text from PDF
 * @throws {Error} If both parsing methods fail
 */
async function extractTextFromPDF(dataBuffer) {
  try {
    // Try pdf-parse first - faster and more reliable for most PDFs
    return (await pdfParse(dataBuffer)).text;
  } catch (err) {
    console.warn("pdf-parse failed, retrying with pdf2json...", err.message);

    // Fallback: pdf2json - handles PDFs that pdf-parse cannot process
    return new Promise((resolve, reject) => {
      const pdfParser = new PDFParser();

      pdfParser.on("pdfParser_dataError", (errData) => {
        reject(new Error(errData.parserError));
      });

      pdfParser.on("pdfParser_dataReady", (pdfData) => {
        let text = "";
        pdfData.Pages.forEach(page => {
          page.Texts.forEach(t => {
            t.R.forEach(r => {
              text += decodeURIComponent(r.T) + " ";
            });
          });
        });
        resolve(text.trim());
      });

      pdfParser.parseBuffer(dataBuffer);
    });
  }
}

/**
 * Retry function with exponential backoff
 * Retries failed API calls with increasing delays between attempts
 * Only retries on network errors, not on API errors (400, 401, 403, etc.)
 * 
 * @param {Function} fn - Async function to retry
 * @param {number} maxRetries - Maximum number of retry attempts (default: 3)
 * @param {number} baseDelay - Base delay in milliseconds (default: 1000)
 * @returns {Promise<*>} Result from the function if successful
 * @throws {Error} Last error if all retries fail
 */
async function retryWithBackoff(fn, maxRetries = 3, baseDelay = 1000) {
  let lastError;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      // Check if error is a network-related error (retryable)
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
      
      // Exponential backoff: delay doubles with each attempt
      const delay = baseDelay * Math.pow(2, attempt - 1);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}

/**
 * Parse resume text using Groq AI
 * Extracts structured data from resume text including personal info, skills, experience, education
 * Uses Groq's llama-3.1-8b-instant model for fast and accurate parsing
 * 
 * @param {string} resumeText - Full text content extracted from resume file
 * @param {string} fileName - Original filename of the resume
 * @returns {Promise<Object>} Parsed resume data with structured fields
 * @throws {Error} If resume text is invalid or parsing fails
 */
async function parseResumeWithGroq(resumeText, fileName) {
  // Validate input - ensure we have valid text to parse
  if (!resumeText || typeof resumeText !== 'string' || resumeText.trim().length === 0) {
    throw new Error('Resume text is empty or invalid. Cannot parse empty resume.');
  }

  // Using Groq's llama-3.1-8b-instant model for fast resume parsing
  const modelName = 'llama-3.1-8b-instant';
  
  const prompt = `You are a resume parser. Parse the following resume text and extract all relevant information. You MUST return ONLY a valid JSON object with no additional text, explanations, or markdown formatting.

Required JSON fields:
{
  "name": "Full name of the person",
  "First_Name": "First name",
  "Last_Name": "Last name",
  "email": "Email address or empty string",
  "phone": "Phone number or empty string",
  "Mobile_Number": "Mobile/phone number or empty string",
  "Date_Of_Birth": "YYYY-MM-DD or YYYY-MM or empty string",
  "location": "Complete full address with all components (street, city, state, country, zip) or empty string",
  "skills": ["Array", "of", "skills"],
  "experience": [{
    "company": "Company name",
    "position": "Job title",
    "duration": "Duration string",
    "description": "Job description",
    "startDate": "YYYY-MM or YYYY-MM-DD",
    "endDate": "YYYY-MM or YYYY-MM-DD or 'Present'"
  }],
  "total_experience": 5.50,
  "education": [{
    "institution": "School/University name",
    "degree": "Degree name",
    "field": "Field of study",
    "year": "Graduation year"
  }],
  "summary": "Professional summary or empty string",
  "certifications": ["Array", "of", "certifications"],
  "fileName": "Original file name"
}

CRITICAL INSTRUCTIONS:
1. Calculate total_experience precisely from work experience dates. Sum all non-overlapping periods in decimal years (e.g., 5.50, 3.25).
2. Extract complete address for location field with all available components.
3. If information is not found, use empty string "" for strings or empty array [] for arrays.
4. Your response MUST be valid JSON only - no text before or after, no markdown, no explanations.
5. Ensure all special characters are properly escaped in JSON strings.

Resume text to parse:
${resumeText}

Return ONLY the JSON object, nothing else.`;

  let lastError = null;
  
  try {
    const groq = await getGroqClient();
    
    // Retry API call with exponential backoff
    const result = await retryWithBackoff(async () => {
      return await groq.chat.completions.create({
        messages: [
          {
            role: 'system',
            content: 'You are a resume parser. You must respond with ONLY valid JSON. Do not include any text, explanations, or markdown formatting before or after the JSON object.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        model: modelName,
        temperature: 0.3,
        max_tokens: 4096,
        response_format: { type: 'json_object' }
      });
    }, 3, 2000);
    
    const text = result.choices[0]?.message?.content || '';

    // Validate that we received a response
    if (!text || text.trim().length === 0) {
      throw new Error('Empty response from Groq API');
    }

    // Check if response looks like an error message instead of JSON
    const lowerText = text.trim().toLowerCase();
    if (lowerText.startsWith('i don\'t') || 
        lowerText.startsWith('i cannot') || 
        lowerText.startsWith('i can\'t') ||
        lowerText.startsWith('sorry') ||
        lowerText.startsWith('unable') ||
        lowerText.startsWith('error') ||
        (!text.includes('{') && !text.includes('['))) {
      console.error(`     Non-JSON response detected: ${text.substring(0, 200)}`);
      throw new Error(`Groq API returned a non-JSON response. The model may not have received valid resume text. Response preview: ${text.substring(0, 200)}`);
    }

      // Clean the response to extract JSON
      let jsonText = text.trim();
      
      // Remove null bytes and other control characters that can corrupt JSON
      // Replace null bytes (\u0000) and other problematic control characters
      jsonText = jsonText.replace(/\u0000/g, ''); // Remove null bytes
      jsonText = jsonText.replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F]/g, ''); // Remove other control chars except \n, \r, \t
      
      // Remove markdown code blocks if present
      jsonText = jsonText.replace(/```json\n?/gi, '').replace(/```\n?/g, '');
      
      // Remove any text before the first opening brace (common issue: "However, y..." or "Here is the JSON:")
      const firstBraceIndex = jsonText.indexOf('{');
      if (firstBraceIndex > 0) {
        jsonText = jsonText.substring(firstBraceIndex);
      }
      
      // If no opening brace found, try to find array start
      if (firstBraceIndex === -1) {
        const firstBracketIndex = jsonText.indexOf('[');
        if (firstBracketIndex > 0) {
          jsonText = jsonText.substring(firstBracketIndex);
        } else if (firstBracketIndex === -1) {
          throw new Error(`No JSON structure found in response. Response starts with: ${text.substring(0, 200)}`);
        }
      }
      
      // Function to extract JSON by finding matching braces
      function extractJSON(text) {
        const startIndex = text.indexOf('{');
        if (startIndex === -1) {
          return null;
        }
        
        let braceCount = 0;
        let inString = false;
        let escapeNext = false;
        
        for (let i = startIndex; i < text.length; i++) {
          const char = text[i];
          
          if (escapeNext) {
            escapeNext = false;
            continue;
          }
          
          if (char === '\\') {
            escapeNext = true;
            continue;
          }
          
          if (char === '"' && !escapeNext) {
            inString = !inString;
            continue;
          }
          
          if (!inString) {
            if (char === '{') {
              braceCount++;
            } else if (char === '}') {
              braceCount--;
              if (braceCount === 0) {
                // Found the matching closing brace
                return text.substring(startIndex, i + 1);
              }
            }
          }
        }
        
        // If we didn't find a matching brace, return the original match
        const fallbackMatch = text.match(/\{[\s\S]*\}/);
        return fallbackMatch ? fallbackMatch[0] : null;
      }
      
      // Try to extract JSON from the response
      let extractedJson = extractJSON(jsonText);
      if (extractedJson) {
        jsonText = extractedJson;
        // Clean again after extraction in case the match included some control chars
        jsonText = jsonText.replace(/\u0000/g, '').replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F]/g, '');
      } else {
        // Fallback to regex if brace matching fails
        const jsonMatch = jsonText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          jsonText = jsonMatch[0];
          jsonText = jsonText.replace(/\u0000/g, '').replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F]/g, '');
        }
      }

      // Validate that we have valid JSON text before parsing
      if (!jsonText || jsonText.trim().length === 0) {
        throw new Error('Empty or invalid JSON response from Groq API');
      }

      let parsedData;
      try {
        parsedData = JSON.parse(jsonText);
      } catch (parseError) {
        // Log the problematic JSON for debugging
        console.error(`     JSON Parse Error: ${parseError.message}`);
        console.error(`     JSON text length: ${jsonText.length}`);
        
        // Extract position from error message if available
        const positionMatch = parseError.message.match(/position (\d+)/);
        if (positionMatch) {
          const position = parseInt(positionMatch[1]);
          const start = Math.max(0, position - 100);
          const end = Math.min(jsonText.length, position + 100);
          console.error(`     Context around error position ${position}:`);
          console.error(`   ${jsonText.substring(start, end)}`);
          console.error(`   ${' '.repeat(Math.min(100, position - start))}^`);
        } else {
          console.error(`     JSON preview (first 500 chars): ${jsonText.substring(0, 500)}`);
        }
        
        // Also log the last 200 chars in case the issue is at the end
        if (jsonText.length > 500) {
          console.error(`     JSON ending (last 200 chars): ${jsonText.substring(jsonText.length - 200)}`);
        }
        
        throw new Error(`Failed to parse JSON response: ${parseError.message}. Response may contain invalid characters.`);
      }
      
      // Add fileName if not present
      if (!parsedData.fileName) {
        parsedData.fileName = fileName;
      }

    // Post-process and validate data
    parsedData = validateAndCleanData(parsedData);

    return parsedData;
  } catch (error) {
    lastError = error;
    const errorMsg = error.message || 'Unknown error';
    console.error(`     Error parsing resume with Groq: ${errorMsg}`);
    throw new Error(`Error parsing resume with Groq: ${errorMsg}. Please check your API key and network connection.`);
  }
}

/**
 * Validate and clean parsed resume data
 * Ensures data types are correct and fills in missing fields with defaults
 * Handles edge cases like array locations, missing name parts, etc.
 * 
 * @param {Object} parsedData - Raw parsed data from AI
 * @returns {Object} Validated and cleaned resume data
 */
function validateAndCleanData(parsedData) {
  // Validate and format total_experience - ensure it's a valid number
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

  // Extract First_Name and Last_Name if not explicitly provided
  if (!parsedData.First_Name || !parsedData.Last_Name) {
    if (parsedData.name) {
      const nameParts = parsedData.name.trim().split(/\s+/);
      if (nameParts.length > 0) {
        parsedData.First_Name = parsedData.First_Name || nameParts[0] || '';
        // Last name is everything after the first name
        parsedData.Last_Name = parsedData.Last_Name || (nameParts.length > 1 ? nameParts.slice(1).join(' ') : '');
      }
    } else {
      parsedData.First_Name = parsedData.First_Name || '';
      parsedData.Last_Name = parsedData.Last_Name || '';
    }
  }

  // Set Mobile_Number from phone if not explicitly provided
  if (!parsedData.Mobile_Number && parsedData.phone) {
    parsedData.Mobile_Number = parsedData.phone;
  } else if (!parsedData.Mobile_Number) {
    parsedData.Mobile_Number = '';
  }

  // Ensure Date_Of_Birth is a string (empty if not found)
  if (parsedData.Date_Of_Birth === null || parsedData.Date_Of_Birth === undefined) {
    parsedData.Date_Of_Birth = '';
  }

  // Ensure Email is set (use email field)
  if (!parsedData.Email && parsedData.email) {
    parsedData.Email = parsedData.email;
  } else if (!parsedData.Email) {
    parsedData.Email = '';
  }

  return parsedData;
}

module.exports = {
  extractTextFromFile,
  parseResumeWithGemini: parseResumeWithGroq, // Keep old name for backward compatibility
  parseResumeWithGroq
};

