const groq = require('../config/groq');
const pdfParse = require('pdf-parse');
const PDFParser = require('pdf2json');
const mammoth = require('mammoth');
const fs = require('fs').promises;

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

async function extractTextFromPDF(dataBuffer) {
  try {
    // Try pdf-parse first
    return (await pdfParse(dataBuffer)).text;
  } catch (err) {
    console.warn("pdf-parse failed, retrying with pdf2json...", err.message);

    // Fallback: pdf2json
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

async function parseResumeWithGroq(resumeText, fileName) {
  // Using Groq's llama-3.1-8b-instant model
  const modelName = 'llama-3.1-8b-instant';
  
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
    3. CRITICAL OUTPUT FORMAT: Your response MUST start with the opening brace { and end with the closing brace }. Do NOT include any text, explanations, comments, or markdown before or after the JSON object. Do NOT use code blocks (\`\`\`json or \`\`\`). Do NOT add any prefix like "Here is the JSON:" or "The parsed data is:". Your ENTIRE response must be ONLY the JSON object itself, nothing else.
    4. Ensure all special characters in string values are properly escaped (e.g., quotes, newlines, backslashes). Use \\n for newlines, \\" for quotes, \\\\ for backslashes.
    5. All string values must be properly quoted and escaped. Do not include unescaped control characters or invalid JSON characters.
    
    Resume text:
    ${resumeText}
    
    Remember: Your response must be ONLY valid JSON starting with { and ending with }. No other text whatsoever.`;

  let lastError = null;
  
  try {
    console.log(`   🔄 Using Groq model: ${modelName}`);
    
    // Retry API call with exponential backoff
    const result = await retryWithBackoff(async () => {
      return await groq.chat.completions.create({
        messages: [
          {
            role: 'user',
            content: prompt
          }
        ],
        model: modelName,
        temperature: 0.3,
        max_tokens: 4096
      });
    }, 3, 2000);
    
    const text = result.choices[0]?.message?.content || '';
    console.log(`   ✅ Got response from ${modelName}`);

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
        console.error(`   ❌ JSON Parse Error: ${parseError.message}`);
        console.error(`   ❌ JSON text length: ${jsonText.length}`);
        
        // Extract position from error message if available
        const positionMatch = parseError.message.match(/position (\d+)/);
        if (positionMatch) {
          const position = parseInt(positionMatch[1]);
          const start = Math.max(0, position - 100);
          const end = Math.min(jsonText.length, position + 100);
          console.error(`   ❌ Context around error position ${position}:`);
          console.error(`   ${jsonText.substring(start, end)}`);
          console.error(`   ${' '.repeat(Math.min(100, position - start))}^`);
        } else {
          console.error(`   ❌ JSON preview (first 500 chars): ${jsonText.substring(0, 500)}`);
        }
        
        // Also log the last 200 chars in case the issue is at the end
        if (jsonText.length > 500) {
          console.error(`   ❌ JSON ending (last 200 chars): ${jsonText.substring(jsonText.length - 200)}`);
        }
        
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
    console.error(`   ❌ Error parsing resume with Groq: ${errorMsg}`);
    throw new Error(`Error parsing resume with Groq: ${errorMsg}. Please check your API key and network connection.`);
  }
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
  parseResumeWithGemini: parseResumeWithGroq, // Keep old name for backward compatibility
  parseResumeWithGroq
};

