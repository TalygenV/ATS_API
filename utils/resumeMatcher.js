const genAI = require('../config/gemini');

/**
 * Compare resume with job description and generate match scores
 * @param {string} resumeText - Full text content of the resume
 * @param {string} jobDescription - Job description text
 * @param {object} parsedResumeData - Parsed resume data (name, email, skills, experience, education, etc.)
 * @returns {Promise<object>} Match scores and details
 */
async function matchResumeWithJobDescription(resumeText, jobDescription, parsedResumeData) {
  // List of models to try in order (using available models)
  const modelsToTry = ['gemini-1.5-flash', 'gemini-1.5-pro', 'gemini-2.0-flash'];
  
  const prompt = `You are an expert HR recruiter evaluating a candidate's resume against a job description. Analyze the resume and job description, then provide a comprehensive matching score and detailed analysis.

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
6. For overall_match: Calculate a weighted average (skills: 40%, experience: 40%, education: 20%)
7. Set status as:
   - "accepted" if overall_match >= 70
   - "pending" if overall_match >= 50 and < 70
   - "rejected" if overall_match < 50
8. Provide detailed, actionable feedback in the details fields
9. Return ONLY valid JSON, no additional text or markdown formatting`;

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

  let lastError = null;
  
  // Try each model until one works
  for (const modelName of modelsToTry) {
    try {
      console.log(`   🔄 Trying model for matching: ${modelName}`);
      
      const model = genAI.getGenerativeModel({ model: modelName });
      
      // Retry API call with exponential backoff
      const result = await retryWithBackoff(async () => {
        return await model.generateContent(prompt);
      }, 3, 2000);
      
      const response = await result.response;
      const text = response.text();
      console.log(`   ✅ Got matching response from ${modelName}`);

      // Clean the response to extract JSON
      let jsonText = text.trim();
      
      // Remove markdown code blocks if present
      jsonText = jsonText.replace(/```json\n?/g, '').replace(/```\n?/g, '');
      
      // Try to extract JSON from the response
      const jsonMatch = jsonText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        jsonText = jsonMatch[0];
      }

      let matchData = JSON.parse(jsonText);
      
      // Validate and normalize the data
      matchData = validateAndNormalizeMatchData(matchData);
      
      console.log(`   ✅ Successfully matched resume with ${modelName}`);

      return matchData;
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
  console.error(`   ❌ All models failed for matching. Last error: ${errorDetails}`);
  throw new Error(`Error matching resume with job description: All models failed. Last error: ${errorDetails}. Please check your API key and network connection.`);
}

/**
 * Validate and normalize match data
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

module.exports = {
  matchResumeWithJobDescription
};

