const groq = require('../config/groq');

/**
 * Extract JSON from text by finding matching braces
 * Handles cases where there's text before or after the JSON object
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
  // Using Groq's llama-3.1-8b-instant model
  const modelName = 'llama-3.1-8b-instant';

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

⚠️ CRITICAL OUTPUT FORMAT: Your response MUST start with the opening brace { and end with the closing brace }. Do NOT include any text, explanations, comments, or markdown before or after the JSON object. Do NOT use code blocks (\`\`\`json or \`\`\`). Do NOT add any prefix like "Here are the questions:" or "The generated questions are:". Your ENTIRE response must be ONLY the JSON object itself, nothing else.

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
- Ensure all special characters in string values are properly escaped (e.g., quotes, newlines, backslashes). Use \\n for newlines, \\" for quotes, \\\\ for backslashes.
- All string values must be properly quoted and escaped. Do not include unescaped control characters or invalid JSON characters.

Remember: Your response must be ONLY valid JSON starting with { and ending with }. No other text whatsoever.

  `;
  

  let lastError = null;

  try {
    console.log(`   🔄 Using Groq model for question generation: ${modelName}`);

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
    console.log(`   ✅ Got question generation response from ${modelName}`);

      let jsonText = text.trim();

      // Clean control characters and markdown fences
      jsonText = jsonText.replace(/\u0000/g, '');
      jsonText = jsonText.replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F]/g, '');
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
        jsonText = jsonText
          .replace(/\u0000/g, '')
          .replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F]/g, '');
      } else {
        // Fallback to regex if brace matching fails
        const jsonMatch = jsonText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          jsonText = jsonMatch[0];
          jsonText = jsonText
            .replace(/\u0000/g, '')
            .replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F]/g, '');
        }
      }

      if (!jsonText || jsonText.trim().length === 0) {
        throw new Error('Empty or invalid JSON response from Groq API');
      }

      let data;
      try {
        data = JSON.parse(jsonText);
      } catch (parseError) {
        console.error(`   ❌ JSON Parse Error (questions): ${parseError.message}`);
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
          console.error(
            `   ❌ JSON preview (first 400 chars): ${jsonText.substring(0, 400)}`
          );
        }
        
        // Also log the last 200 chars in case the issue is at the end
        if (jsonText.length > 400) {
          console.error(`   ❌ JSON ending (last 200 chars): ${jsonText.substring(jsonText.length - 200)}`);
        }
        
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
    console.error(`   ❌ Error generating questions with Groq: ${errorMsg}`);
    throw new Error(
      `Error generating questions from job description: ${errorMsg}. Please check your API key and network connection.`
    );
  }
}

module.exports = {
  generateQuestionsFromJD
};


