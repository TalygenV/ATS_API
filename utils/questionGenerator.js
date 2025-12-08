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
  // List of models to try in order (prioritized by capability and availability)
  // When quota is exceeded (429), automatically switches to next model
  const modelsToTry = [
    
    'gemini-2.5-flash-lite'
    
  ];

  const { title, seniority, yearsOfExperience } = options;

  const prompt = `
  You are an expert technical recruiter. Based on the JOB CONTEXT and JOB DESCRIPTION provided below, generate the MINIMUM number of objective screening questions required to verify whether the candidate is suitable for the role.

JOB CONTEXT:
- Job Title: ${title || 'Not specified'}
- Seniority: ${seniority || 'Not specified'}
- Expected Experience: ${yearsOfExperience || 'Not specified'}

JOB DESCRIPTION:
${jobDescription}

🚨 STRICT RULES — MUST FOLLOW
1. Every question MUST be answerable with ONLY one of these formats:
   • Yes/No
   • True/False
   • Numeric value in years (0, 1, 3, 5…)
2. No other answer type is allowed (NO text, NO tech name, NO multiple choice).
3. Ask ONLY the minimum essential questions needed to filter candidates.
4. Questions must be fully aligned with REQUIRED skills, responsibilities, certifications, or mandatory conditions in the job description.
5. Do not repeat questions for the same competency even if mentioned multiple times.
6. First category must ALWAYS be **Overall Experience** with the exact predefined question below.

⚠️ OUTPUT MUST BE JSON ONLY — NO EXPLANATIONS.

📌 JSON STRUCTURE (strict — must match exactly)
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

🔧 ADDITIONAL RULES FOR NEW QUESTIONS:
- For skill validation → type = "yes_no"
- For mandatory compliance (shift, location, visa, etc.) → type = "yes_no" or "true_false"
- For experience duration → type = "number" and include "unit": "years"
- Max 5 categories in total
- 1–3 questions per category only

📌 FORMATTING REQUIREMENTS:
- Every category must have:
  - id (snake_case)
  - label (readable name)
  - questions (array)
- Every question must have:
  - id (snake_case)
  - text (the question)
  - type (yes_no | true_false | number)
  - unit ONLY if type = number (value must be "years")

Return ONLY the JSON — nothing else.

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
      const errorString = JSON.stringify(error) || '';
      
      // Check for quota exceeded errors (429) - this is the main case we need to handle
      const isQuotaError = 
        errorMsg.includes('429') || 
        errorMsg.includes('quota') || 
        errorMsg.includes('Quota exceeded') ||
        errorMsg.includes('exceeded your current quota') ||
        errorString.includes('429') ||
        errorString.includes('quota');
      
      if (isQuotaError) {
        console.log(`   ⚠️  Quota exceeded for ${modelName}, switching to next model...`);
        continue;
      }

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
        errorMsg.includes('403')
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


