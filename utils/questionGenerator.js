const genAI = require('../config/gemini');

// Helper function to retry API calls with exponential backoff
async function retryWithBackoff(fn, maxRetries = 3, baseDelay = 1000) {
  let lastError;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const isNetworkError =
        error.message &&
        (error.message.includes('fetch failed') ||
          error.message.includes('ECONNRESET') ||
          error.message.includes('ETIMEDOUT') ||
          error.message.includes('network') ||
          error.message.includes('timeout'));

      // Only retry on network errors, not on API errors (400, 401, 403, etc.)
      if (!isNetworkError || attempt === maxRetries) {
        throw error;
      }

      const delay = baseDelay * Math.pow(2, attempt - 1);
      console.log(
        `   ⚠️  Attempt ${attempt}/${maxRetries} failed for question generation, retrying in ${delay}ms...`
      );
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}

/**
 * Generate structured interview questions from a job description.
 * @param {string} jobDescription - Full job description text
 * @param {object} options - Optional metadata like title, level, tech stack
 * @returns {Promise<object>} Object with categories and questions
 */
async function generateQuestionsFromJD(jobDescription, options = {}) {
  const modelsToTry = ['gemini-1.5-flash', 'gemini-1.5-pro', 'gemini-2.0-flash'];

  const { title, seniority, yearsOfExperience } = options;

  const prompt = `
  You are an expert technical interviewer.
  
  JOB CONTEXT:
  - Job Title: ${title || 'Not specified'}
  - Seniority: ${seniority || 'Not specified'}
  - Expected Experience: ${yearsOfExperience || 'Not specified'}
  
  JOB DESCRIPTION:
  ${jobDescription}
  
  TASK:
  Generate clear, concise screening questions HR/interviewers can use to quickly assess the candidate.
  
  REQUIREMENTS:
  1. Ask SHORT, DIRECT questions answerable in numbers or brief sentences.
  2. Cover:
     - Total overall experience
     - Experience (in years) for each major technology/stack in the JD
     - Database experience
     - Cloud/DevOps tools if present
     - Domain/industry experience
  3. Use formats like:
     - "Total experience in .NET Core (in years)"
     - "Total overall professional experience (in years)"
  4. don't categories the questions.
  
  OUTPUT FORMAT (JSON only):
  {
    "categories": [
      {
        "id": "overall_experience",
        "label": "Overall Experience",
        "questions": [
          {
            "id": "total_experience_years",
            "text": "Total overall professional experience (in years)",
            "type": "number",
            "unit": "years"
          }
        ]
      }
    ]
  }
  
  RULES:
  - Use snake_case for all ids.
  - Use human-readable category labels.
  - For experience: type = number, unit = years.
  - For yes/no: type = boolean.
  - For text answers: type = text.
  - Include at least:
    - 1 overall experience question
    - 5-7 technology/skill experience impactful questions from the JD.
  `;
  

  let lastError = null;

  for (const modelName of modelsToTry) {
    try {
      console.log(`   🔄 Trying model for question generation: ${modelName}`);

      const model = genAI.getGenerativeModel({ model: modelName });

      const result = await retryWithBackoff(async () => {
        return await model.generateContent(prompt);
      }, 3, 2000);

      const response = await result.response;
      const text = response.text();
      console.log(`   ✅ Got question generation response from ${modelName}`);

      let jsonText = text.trim();

      // Clean control characters and markdown fences
      jsonText = jsonText.replace(/\u0000/g, '');
      jsonText = jsonText.replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F]/g, '');
      jsonText = jsonText.replace(/```json\n?/g, '').replace(/```\n?/g, '');

      const jsonMatch = jsonText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        jsonText = jsonMatch[0];
        jsonText = jsonText
          .replace(/\u0000/g, '')
          .replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F]/g, '');
      }

      if (!jsonText || jsonText.trim().length === 0) {
        throw new Error('Empty or invalid JSON response from Gemini API');
      }

      let data;
      try {
        data = JSON.parse(jsonText);
      } catch (parseError) {
        console.error(`   ❌ JSON Parse Error (questions): ${parseError.message}`);
        console.error(`   ❌ JSON text length: ${jsonText.length}`);
        console.error(
          `   ❌ JSON preview (first 400 chars): ${jsonText.substring(0, 400)}`
        );
        throw new Error(
          `Failed to parse JSON response: ${parseError.message}. Response may contain invalid characters.`
        );
      }

      // Basic normalization / safety
      if (!data.categories || !Array.isArray(data.categories)) {
        throw new Error('Invalid response: missing categories array');
      }

      data.categories = data.categories.map(cat => ({
        id: typeof cat.id === 'string' ? cat.id : 'uncategorized',
        label: cat.label || 'Other',
        questions: Array.isArray(cat.questions) ? cat.questions : []
      }));

      console.log(`   ✅ Successfully generated questions with ${modelName}`);
      return data;
    } catch (error) {
      lastError = error;
      const errorMsg = error.message || 'Unknown error';

      if (
        errorMsg.includes('404') ||
        errorMsg.includes('not found')
      ) {
        console.log(
          `   ⚠️  Model ${modelName} not available for question generation, trying next model...`
        );
        continue;
      }

      if (
        errorMsg.includes('fetch failed') ||
        errorMsg.includes('network') ||
        errorMsg.includes('ECONNRESET') ||
        errorMsg.includes('ETIMEDOUT')
      ) {
        console.log(
          `   ⚠️  Network error with ${modelName} for question generation: ${errorMsg}, trying next model...`
        );
        continue;
      }

      if (
        errorMsg.includes('401') ||
        errorMsg.includes('403') ||
        errorMsg.includes('429')
      ) {
        console.log(
          `   ⚠️  API error with ${modelName} for question generation: ${errorMsg}, trying next model...`
        );
        continue;
      }

      console.log(
        `   ⚠️  Error with ${modelName} for question generation: ${errorMsg}, trying next model...`
      );
      continue;
    }
  }

  const errorDetails = lastError?.message || 'Unknown error';
  console.error(
    `   ❌ All models failed for question generation. Last error: ${errorDetails}`
  );
  throw new Error(
    `Error generating questions from job description: All models failed. Last error: ${errorDetails}. Please check your API key and network connection.`
  );
}

module.exports = {
  generateQuestionsFromJD
};


