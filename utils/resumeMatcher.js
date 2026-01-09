// Resume Matcher Utility
// This module handles matching resumes against job descriptions using AI
// Provides scoring and detailed analysis for candidate evaluation

// const groq = require('../config/groq');
const { getGroqClient } = require('../config/groq')

/**
 * Extract JSON from text by finding matching braces
 * Handles cases where there's text before or after the JSON object
 * Used to clean AI responses that may include explanatory text
 * 
 * @param {string} text - Text containing JSON object
 * @returns {string|null} Extracted JSON string or null if not found
 */
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

/**
 * Compare resume with job description and generate match scores
 * Uses AI to analyze and score how well a candidate matches a job description
 * Provides detailed breakdown of skills, experience, and education matches
 * 
 * @param {string} resumeText - Full text content of the resume
 * @param {string} jobDescription - Job description text
 * @param {object} parsedResumeData - Parsed resume data (name, email, skills, experience, education, etc.)
 * @returns {Promise<object>} Match scores and details including overall_match, skills_match, experience_match, education_match, status, and rejection_reason
 */
async function matchResumeWithJobDescription(resumeText, jobDescription, parsedResumeData) {
  // Using Groq's llama-3.1-8b-instant model for fast matching analysis
  const modelName = 'llama-3.1-8b-instant';
  
  const prompt = `You are an expert Technical Recruiter evaluating a candidate's resume against a job description. Analyze the resume and job description, then provide a comprehensive matching score and detailed analysis.

RESUME INFORMATION:
- Name: ${parsedResumeData.name || 'Not provided'}
- Email: ${parsedResumeData.email || 'Not provided'}
- Phone: ${parsedResumeData.phone || 'Not provided'}
- Skills: ${JSON.stringify(parsedResumeData.skills || [])}
- Experience: ${JSON.stringify(parsedResumeData.experience || [])}
- Education: ${JSON.stringify(parsedResumeData.education || [])}
- Total Experience: ${parsedResumeData.total_experience || 0} years
- Summary: ${parsedResumeData.summary || 'Not provided'}

FULL RESUME TEXT:
${resumeText}

JOB DESCRIPTION:
${jobDescription}

Please analyze and provide a JSON response with the following structure:
{
  "overall_match": <number between 0-100, representing overall match percentage>,
  "skills_match": <number between 0-100, representing skills match percentage>,
  "skills_details": "<detailed analysis of skills match - what skills match, what's missing, what's extra>",
  "experience_match": <number between 0-100, representing experience match percentage>,
  "experience_details": "<detailed analysis of experience match - relevant experience, years of experience match, gaps>",
  "education_match": <number between 0-100, representing education match percentage>,
  "education_details": "<detailed analysis of education match - degree match, field match, institution quality>",
  "status": "<recommended status: 'accepted', 'pending', or 'rejected'>",
  "rejection_reason": "<if status is 'rejected', provide detailed reason. Otherwise, empty string>"
}

IMPORTANT INSTRUCTIONS:
1. Be thorough and accurate in your analysis
2. Consider both required and preferred qualifications
3. For skills_match: Compare technical skills, tools, frameworks, and soft skills mentioned in the job description with those in the resume
4. For experience_match: Consider years of experience, relevant industry experience, role similarity, and achievements
5. For education_match: Consider degree level, field of study, and institution quality
6. For overall_match: Calculate a weighted average (skills: 40%, experience: 40%, education: 20%) Strictly follow the weights and do not change them.
7. Set status as:
   - "accepted" if overall_match >= 70
   - "pending" if overall_match >= 50 and < 70
   - "rejected" if overall_match < 50
8. Provide detailed, actionable feedback in the details fields
9. CRITICAL OUTPUT FORMAT: Your response MUST start with the opening brace { and end with the closing brace }. Do NOT include any text, explanations, comments, or markdown before or after the JSON object. Do NOT use code blocks (\`\`\`json or \`\`\`). Do NOT add any prefix like "Here is the analysis:" or "The match results are:". Your ENTIRE response must be ONLY the JSON object itself, nothing else.
10. Ensure all special characters in string values are properly escaped (e.g., quotes, newlines, backslashes). Use \\n for newlines, \\" for quotes, \\\\ for backslashes.
11. All string values must be properly quoted and escaped. Do not include unescaped control characters or invalid JSON characters.

Remember: Your response must be ONLY valid JSON starting with { and ending with }. No other text whatsoever.`;

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
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    throw lastError;
  }

  let lastError = null;
  
  try {
    const groq = await getGroqClient();
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
      
      // Try to extract JSON from the response using brace matching
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

      let matchData;
      try {
        matchData = JSON.parse(jsonText);
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
      
      // Validate and normalize the data
      matchData = validateAndNormalizeMatchData(matchData);

    return matchData;
  } catch (error) {
    lastError = error;
    const errorMsg = error.message || 'Unknown error';
    console.error(`     Error matching resume with Groq: ${errorMsg}`);
    throw new Error(`Error matching resume with job description: ${errorMsg}. Please check your API key and network connection.`);
  }
}

/**
 * Validate and normalize match data
 * Ensures all match scores are valid numbers between 0-100
 * Validates status field and sets defaults for missing fields
 * 
 * @param {Object} matchData - Raw match data from AI
 * @returns {Object} Validated and normalized match data
 */
function validateAndNormalizeMatchData(matchData) {
  // Ensure all numeric fields are valid numbers between 0-100
  const numericFields = ['overall_match', 'skills_match', 'experience_match', 'education_match'];
  
  numericFields.forEach(field => {
    if (matchData[field] !== null && matchData[field] !== undefined) {
      let value = parseFloat(matchData[field]);
      if (isNaN(value)) {
        value = 0;
      }
      // Clamp between 0 and 100
      value = Math.max(0, Math.min(100, value));
      matchData[field] = Math.round(value * 100) / 100; // Round to 2 decimal places
    } else {
      matchData[field] = 0;
    }
  });

  // Ensure status is valid
  const validStatuses = ['accepted', 'pending', 'rejected'];
  if (!validStatuses.includes(matchData.status)) {
    // Auto-determine status based on overall_match
    if (matchData.overall_match >= 70) {
      matchData.status = 'accepted';
    } else if (matchData.overall_match >= 50) {
      matchData.status = 'pending';
    } else {
      matchData.status = 'rejected';
    }
  }

  // Ensure rejection_reason is a string
  if (!matchData.rejection_reason) {
    matchData.rejection_reason = matchData.status === 'rejected' 
      ? 'Overall match score below acceptable threshold' 
      : null;
  }

  // Ensure details fields are strings
  ['skills_details', 'experience_details', 'education_details'].forEach(field => {
    if (!matchData[field] || typeof matchData[field] !== 'string') {
      matchData[field] = 'No details provided';
    }
  });

  return matchData;
}

/**
 * Compare resume with job description and generate match scores, including Q&A responses
 * Enhanced matching that considers both resume content and candidate's Q&A responses
 * Provides more accurate evaluation by validating resume claims with Q&A answers
 * 
 * @param {string} resumeText - Full text content of the resume
 * @param {string} jobDescription - Job description text
 * @param {object} parsedResumeData - Parsed resume data (name, email, skills, experience, education, etc.)
 * @param {object} questionAnswers - Object with questions as keys and answers as values
 * @returns {Promise<object>} Match scores and details including overall_match, skills_match, experience_match, education_match, status, and rejection_reason
 */
async function matchResumeWithJobDescriptionAndQA(resumeText, jobDescription, parsedResumeData, questionAnswers = {}) {
  // Using Groq's llama-3.1-8b-instant model for fast matching analysis with Q&A
  const modelName = 'llama-3.1-8b-instant';
  
  // Format Q&A responses for inclusion in the AI prompt
  let qaSection = '';
  if (questionAnswers && Object.keys(questionAnswers).length > 0) {
    qaSection = '\n\nCANDIDATE Q&A RESPONSES:\n';
    Object.entries(questionAnswers).forEach(([question, answer]) => {
      qaSection += `Q: ${question}\nA: ${answer}\n\n`;
    });
  }
  
  const prompt = `You are an expert HR recruiter evaluating a candidate's resume against a job description. Analyze the resume, job description, and candidate's Q&A responses, then provide a comprehensive matching score and detailed analysis.

RESUME INFORMATION:
- Name: ${parsedResumeData.name || 'Not provided'}
- Email: ${parsedResumeData.email || 'Not provided'}
- Phone: ${parsedResumeData.phone || 'Not provided'}
- Skills: ${JSON.stringify(parsedResumeData.skills || [])}
- Experience: ${JSON.stringify(parsedResumeData.experience || [])}
- Education: ${JSON.stringify(parsedResumeData.education || [])}
- Total Experience: ${parsedResumeData.total_experience || 0} years
- Summary: ${parsedResumeData.summary || 'Not provided'}

FULL RESUME TEXT:
${resumeText}

JOB DESCRIPTION:
${jobDescription}${qaSection}
Please analyze and provide a JSON response with the following structure:
{
  "overall_match": <number between 0-100, representing overall match percentage>,
  "skills_match": <number between 0-100, representing skills match percentage>,
  "skills_details": "<detailed analysis of skills match - what skills match, what's missing, what's extra>",
  "experience_match": <number between 0-100, representing experience match percentage>,
  "experience_details": "<detailed analysis of experience match - relevant experience, years of experience match, gaps>",
  "education_match": <number between 0-100, representing education match percentage>,
  "education_details": "<detailed analysis of education match - degree match, field match, institution quality>",
  "status": "<recommended status: 'accepted', 'pending', or 'rejected'>",
  "rejection_reason": "<if status is 'rejected', provide detailed reason. Otherwise, empty string>"
}

IMPORTANT INSTRUCTIONS:
1. Be thorough and accurate in your analysis
2. Consider both required and preferred qualifications
3. For skills_match: Compare technical skills, tools, frameworks, and soft skills mentioned in the job description with those in the resume AND Q&A responses
4. For experience_match: Consider years of experience, relevant industry experience, role similarity, and achievements from BOTH resume and Q&A responses
5. For education_match: Consider degree level, field of study, and institution quality
6. When Q&A responses are provided, use them to validate and enhance the information from the resume. If Q&A responses contradict the resume, note this in the details
7. For overall_match: Calculate a weighted average (skills: 40%, experience: 40%, education: 20%)
8. Set status as:
   - "accepted" if overall_match >= 70
   - "pending" if overall_match >= 50 and < 70
   - "rejected" if overall_match < 50
9. Provide detailed, actionable feedback in the details fields, including insights from Q&A responses
10. CRITICAL OUTPUT FORMAT: Your response MUST start with the opening brace { and end with the closing brace }. Do NOT include any text, explanations, comments, or markdown before or after the JSON object. Do NOT use code blocks (\`\`\`json or \`\`\`). Do NOT add any prefix like "Here is the analysis:" or "The match results are:". Your ENTIRE response must be ONLY the JSON object itself, nothing else.
11. Ensure all special characters in string values are properly escaped (e.g., quotes, newlines, backslashes). Use \\n for newlines, \\" for quotes, \\\\ for backslashes.
12. All string values must be properly quoted and escaped. Do not include unescaped control characters or invalid JSON characters.

Remember: Your response must be ONLY valid JSON starting with { and ending with }. No other text whatsoever.`;

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
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    throw lastError;
  }

  let lastError = null;
  
  try {
    const groq = await getGroqClient();
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

    // Clean the response to extract JSON
    let jsonText = text.trim();
    
    // Remove null bytes and other control characters that can corrupt JSON
    // Replace null bytes (\u0000) and other problematic control characters
    jsonText = jsonText.replace(/\u0000/g, ''); // Remove null bytes
    jsonText = jsonText.replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F]/g, ''); // Remove other control chars except \n, \r, \t
    
    // Remove markdown code blocks if present
    jsonText = jsonText.replace(/```json\n?/g, '').replace(/```\n?/g, '');
    
    // Try to extract JSON from the response using brace matching
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

    let matchData;
    try {
      matchData = JSON.parse(jsonText);
    } catch (parseError) {
      // Log the problematic JSON for debugging
      console.error(`JSON Parse Error: ${parseError.message}`);
      console.error(`JSON text length: ${jsonText.length}`);
      
      // Extract position from error message if available
      const positionMatch = parseError.message.match(/position (\d+)/);
      if (positionMatch) {
        const position = parseInt(positionMatch[1]);
        const start = Math.max(0, position - 100);
        const end = Math.min(jsonText.length, position + 100);
        console.error(`Context around error position ${position}:`);
        console.error(`   ${jsonText.substring(start, end)}`);
        console.error(`   ${' '.repeat(Math.min(100, position - start))}^`);
      } else {
        console.error(`JSON preview (first 500 chars): ${jsonText.substring(0, 500)}`);
      }
      
      // Also log the last 200 chars in case the issue is at the end
      if (jsonText.length > 500) {
        console.error(`JSON ending (last 200 chars): ${jsonText.substring(jsonText.length - 200)}`);
      }
      
      throw new Error(`Failed to parse JSON response: ${parseError.message}. Response may contain invalid characters.`);
    }
    
    // Validate and normalize the data
    matchData = validateAndNormalizeMatchData(matchData);

    return matchData;
  } catch (error) {
    lastError = error;
    const errorMsg = error.message || 'Unknown error';
    console.error(` Error matching resume with Groq: ${errorMsg}`);
    throw new Error(`Error matching resume with job description and Q&A: ${errorMsg}. Please check your API key and network connection.`);
  }
}

module.exports = {
  matchResumeWithJobDescription,
  matchResumeWithJobDescriptionAndQA
};

