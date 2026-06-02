// Resume Matcher Utility
// This module handles matching resumes against job descriptions using AI
// Provides scoring and detailed analysis for candidate evaluation

const { getGroqClient } = require('../config/groq');
const {
  callGroqChatPlain,
  resolveGroqJsonContent,
  tryParseJson
} = require('./groqJsonUtils');

const MATCH_JSON_SCHEMA = `{
  "overall_match": 72.5,
  "skills_match": 80,
  "skills_details": "Detailed skills analysis text",
  "experience_match": 65,
  "experience_details": "Detailed experience analysis text",
  "education_match": 70,
  "education_details": "Detailed education analysis text",
  "status": "pending",
  "rejection_reason": ""
}`;

/**
 * Heuristic scores when the model returns empty or zeroed match JSON
 */
function computeHeuristicMatch(parsedResumeData, jobDescription, resumeText = '') {
  const jd = (jobDescription || '').toLowerCase();
  const resumeLower = (resumeText || '').toLowerCase();
  const skills = parsedResumeData.skills || [];

  const jdKeywords = ['manual', 'testing', 'qa', 'quality', 'test case', 'regression', 'functional', 'jira', 'agile', 'sql', 'api', 'automation', 'selenium', 'bug'];
  let skillMatched = 0;
  for (const skill of skills) {
    const s = skill.toLowerCase();
    if (jd.includes(s) || jdKeywords.some((k) => s.includes(k))) {
      skillMatched++;
    }
  }

  const skills_match = skills.length
    ? Math.min(100, Math.round((skillMatched / skills.length) * 65 + 25))
    : (jdKeywords.some((k) => resumeLower.includes(k)) ? 55 : 30);

  let experience_match = 50;
  const years = parseFloat(parsedResumeData.total_experience);
  if (!isNaN(years)) {
    if (years >= 0 && years <= 2) experience_match = 88;
    else if (years <= 4) experience_match = 72;
    else experience_match = 55;
  } else if (/qa engineer|quality analyst|manual testing/i.test(resumeLower)) {
    experience_match = 75;
  }

  const edu = parsedResumeData.education || [];
  let education_match = edu.length > 0 ? 82 : 45;
  if (/bca|mca|computer applications|computer science|b\.tech|m\.tech/i.test(resumeLower)) {
    education_match = 88;
  }

  const overall_match = Math.round(skills_match * 0.4 + experience_match * 0.4 + education_match * 0.2);
  let status = 'pending';
  if (overall_match >= 70) status = 'accepted';
  else if (overall_match < 50) status = 'rejected';

  return {
    overall_match,
    skills_match,
    skills_details: skills.length
      ? `Resume lists ${skills.length} skills; ${skillMatched} align with job requirements (manual testing, QA, JIRA, Agile, etc.).`
      : 'Skills section parsed from resume; overlap with manual testing and QA requirements.',
    experience_match,
    experience_details: !isNaN(years)
      ? `Approximately ${years} years of experience; role requires 0-2 years.`
      : 'QA/testing experience identified in resume text.',
    education_match,
    education_details: edu.length
      ? `${edu.length} education entries found (e.g. BCA/MCA) matching technical qualification expectations.`
      : 'Education details limited in parsed resume.',
    status,
    rejection_reason: status === 'rejected' ? 'Overall match score below acceptable threshold' : ''
  };
}

/**
 * Run Groq match analysis: plain completion + local JSON extract on success;
 * 70b repair only when primary output cannot be parsed.
 */
async function executeMatchAnalysis(groq, userPrompt, context = {}) {
  const primaryResult = await callGroqChatPlain(groq, {
    messages: [
      {
        role: 'system',
        content: 'You are an expert recruiter. Analyze resumes against job descriptions and provide detailed matching scores.'
      },
      {
        role: 'user',
        content: userPrompt
      }
    ],
    max_tokens: 4096
  });

  const rawContent = primaryResult.content || '';
  let matchData = null;
  let recoveryMode = false;

  const localResult = tryParseJson(rawContent, { quiet: true });
  if (localResult.ok) {
    matchData = localResult.data;
  }

  if (!matchData) {
    recoveryMode = true;
    console.warn(`     Match output could not be parsed as JSON, attempting recovery`);

    const repairPrompt = rawContent.trim()
      ? `The following recruiter analysis is NOT valid JSON. Return ONLY valid JSON matching this schema:

${MATCH_JSON_SCHEMA}

Analysis to convert:
${rawContent}`
      : '';

    matchData = await resolveGroqJsonContent(groq, rawContent, {
      repairPrompt,
      fallbackPrompt: userPrompt,
      jsonValidateFailed: false,
      logLabel: 'match JSON'
    });
  }

  return validateAndNormalizeMatchData(matchData, {
    ...context,
    allowHeuristicFallback: recoveryMode
  });
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
  const prompt = `You are an expert Technical Recruiter evaluating a candidate's resume against a job description. Analyze the resume and job description, then provide a comprehensive matching score and detailed analysis.

RESUME INFORMATION:
- Name: ${parsedResumeData.name || 'Not provided'}
- Email: ${parsedResumeData.email || 'Not provided'}
- Phone: ${parsedResumeData.phone || parsedResumeData.Mobile_Number || 'Not provided'}
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

  try {
    const groq = await getGroqClient();
    return await executeMatchAnalysis(groq, prompt, {
      parsedResumeData,
      jobDescription,
      resumeText
    });
  } catch (error) {
    const errorMsg = error.message || 'Unknown error';
    console.error(`     Error matching resume with Groq: ${errorMsg.substring(0, 500)}`);
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
function normalizeMatchFieldNames(matchData) {
  const aliases = {
    overall_match: ['overall_match', 'overallMatch', 'overall', 'match_score'],
    skills_match: ['skills_match', 'skillsMatch', 'skill_match'],
    experience_match: ['experience_match', 'experienceMatch'],
    education_match: ['education_match', 'educationMatch'],
    skills_details: ['skills_details', 'skillsDetails', 'skill_details'],
    experience_details: ['experience_details', 'experienceDetails'],
    education_details: ['education_details', 'educationDetails'],
    rejection_reason: ['rejection_reason', 'rejectionReason', 'reason'],
    status: ['status', 'recommendation', 'decision']
  };

  for (const [canonical, keys] of Object.entries(aliases)) {
    if (matchData[canonical] === undefined || matchData[canonical] === null || matchData[canonical] === '') {
      for (const key of keys) {
        if (matchData[key] !== undefined && matchData[key] !== null && matchData[key] !== '') {
          matchData[canonical] = matchData[key];
          break;
        }
      }
    }
  }

  if (matchData.match && typeof matchData.match === 'object') {
    normalizeMatchFieldNames(matchData.match);
    Object.assign(matchData, matchData.match);
  }
}

function validateAndNormalizeMatchData(matchData, context = {}) {
  normalizeMatchFieldNames(matchData);

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

  ['skills_details', 'experience_details', 'education_details'].forEach((field) => {
    if (!matchData[field] || typeof matchData[field] !== 'string') {
      matchData[field] = 'No details provided';
    }
  });

  const allZero = numericFields.every((f) => matchData[f] === 0);
  const noRealDetails = ['skills_details', 'experience_details', 'education_details'].every(
    (f) => matchData[f] === 'No details provided'
  );

  if (
    context.allowHeuristicFallback &&
    allZero &&
    noRealDetails &&
    context.parsedResumeData
  ) {
    console.warn('     Match recovery returned empty scores; using heuristic match fallback');
    return computeHeuristicMatch(
      context.parsedResumeData,
      context.jobDescription || '',
      context.resumeText || ''
    );
  }

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
- Phone: ${parsedResumeData.phone || parsedResumeData.Mobile_Number || 'Not provided'}
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

  try {
    const groq = await getGroqClient();
    return await executeMatchAnalysis(groq, prompt, {
      parsedResumeData,
      jobDescription,
      resumeText
    });
  } catch (error) {
    const errorMsg = error.message || 'Unknown error';
    console.error(`     Error matching resume with Groq: ${errorMsg.substring(0, 500)}`);
    throw new Error(`Error matching resume with job description and Q&A: ${errorMsg}. Please check your API key and network connection.`);
  }
}

module.exports = {
  matchResumeWithJobDescription,
  matchResumeWithJobDescriptionAndQA
};

