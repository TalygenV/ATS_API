// Resume Parser Utility
// This module handles text extraction from resume files and parsing using AI
// Supports multiple file formats: PDF, DOC, DOCX, and TXT
// Uses Groq AI for resume parsing with retry logic for reliability

// const groq = require('../config/groq');
const { getGroqClient } = require('../config/groq');
const {
  PRIMARY_MODEL,
  callGroqJsonChat,
  resolveGroqJsonContent,
  isJsonValidateFailedError,
  getFailedGeneration,
  tryParseJson,
  repairJsonWithGroq
} = require('./groqJsonUtils');
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
 * Primary Groq resume parse prompt (do not modify wording)
 */
function buildResumeParsePrompt(resumeText) {
  return `You are a resume parser. Parse the following resume text and extract all relevant information. You MUST return ONLY a valid JSON object with no additional text, explanations, or markdown formatting.

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
6. If the value is not found, use empty string "" for strings or empty array [] for arrays or for number use 0.

Resume text to parse:
${resumeText}

Return ONLY the JSON object, nothing else.`;
}

function buildResumeRepairPrompt(malformedContent, fileName) {
  return `The following text was generated by a resume parser but is NOT valid JSON. Extract all resume information and return ONLY a single valid JSON object using the same Required JSON fields and CRITICAL INSTRUCTIONS as the resume parser.

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

Set "fileName" to "${fileName}".

Malformed content to fix:
${malformedContent}`;
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
  if (!resumeText || typeof resumeText !== 'string' || resumeText.trim().length === 0) {
    throw new Error('Resume text is empty or invalid. Cannot parse empty resume.');
  }

  const prompt = buildResumeParsePrompt(resumeText);
  const fallbackPrompt = buildResumeParsePrompt(resumeText);

  let lastError = null;

  try {
    const groq = await getGroqClient();
    const primaryResult = await callGroqJsonChat(groq, {
      messages: [
        {
          role: 'system',
          content: 'You are a resume parser. You must respond with ONLY valid JSON. Do not include any text, explanations, or markdown formatting before or after the JSON object.'
        },
        {
          role: 'user',
          content: prompt
        }
      ]
    });

    const rawContent = primaryResult.content || '';
    let parsedData;
    let recoveryMode = false;

    if (!primaryResult.jsonValidateFailed) {
      const localResult = tryParseJson(rawContent, { quiet: true });
      if (localResult.ok) {
        parsedData = localResult.data;
      }
    }

    if (!parsedData) {
      if (primaryResult.jsonValidateFailed) {
        console.warn(`     Primary model JSON validation failed (${PRIMARY_MODEL}), attempting recovery`);
      } else {
        console.warn(`     Primary model output could not be parsed as JSON, attempting recovery`);
      }
      recoveryMode = true;
      const repairPrompt = rawContent.trim()
        ? buildResumeRepairPrompt(rawContent, fileName)
        : '';

      parsedData = await resolveGroqJsonContent(groq, rawContent, {
        repairPrompt,
        fallbackPrompt,
        jsonValidateFailed: !!primaryResult.jsonValidateFailed,
        logLabel: 'resume JSON'
      });
    }

    if (!parsedData.fileName) {
      parsedData.fileName = fileName;
    }

    parsedData = validateAndCleanData(parsedData, resumeText, { recoveryMode });
    return parsedData;
  } catch (error) {
    lastError = error;
    const errorMsg = error.message || 'Unknown error';
    console.error(`     Error parsing resume with Groq: ${errorMsg.substring(0, 500)}`);

    if (isJsonValidateFailedError(error)) {
      try {
        const groq = await getGroqClient();
        const failedGeneration = getFailedGeneration(error);
        const localResult = failedGeneration ? tryParseJson(failedGeneration, { quiet: true }) : { ok: false };
        let parsedData;
        let recoveryMode = true;
        if (localResult.ok) {
          parsedData = localResult.data;
          recoveryMode = false;
        } else {
          parsedData = await repairJsonWithGroq(groq, {
            repairPrompt: failedGeneration ? buildResumeRepairPrompt(failedGeneration, fileName) : '',
            fallbackPrompt,
            logLabel: 'resume JSON'
          });
        }
        if (!parsedData.fileName) {
          parsedData.fileName = fileName;
        }
        return validateAndCleanData(parsedData, resumeText, { recoveryMode });
      } catch (recoveryError) {
        console.error(`     JSON recovery failed: ${recoveryError.message}`);
      }
      throw new Error(`Resume JSON validation failed and could not be repaired: ${errorMsg.substring(0, 300)}`);
    }

    const isAuthOrNetwork =
      errorMsg.includes('API key') ||
      errorMsg.includes('401') ||
      errorMsg.includes('403') ||
      errorMsg.includes('fetch failed') ||
      errorMsg.includes('ECONNRESET') ||
      errorMsg.includes('ETIMEDOUT') ||
      errorMsg.includes('network') ||
      errorMsg.includes('timeout');

    if (isAuthOrNetwork) {
      throw new Error(`Error parsing resume with Groq: ${errorMsg}. Please check your API key and network connection.`);
    }

    throw new Error(`Error parsing resume with Groq: ${errorMsg}`);
  }
}

/**
 * Pick first non-empty value from object using possible keys
 */
function pickField(obj, keys) {
  for (const key of keys) {
    const val = obj?.[key];
    if (val !== null && val !== undefined && String(val).trim() !== '') {
      return typeof val === 'string' ? val.trim() : val;
    }
  }
  return null;
}

/**
 * Get resume section body by header line (avoids matching "experience in" inside SUMMARY)
 */
function getResumeSection(rawText, header, stopHeaders = []) {
  if (!rawText) {
    return '';
  }
  const normalized = rawText.replace(/\u0000/g, ' ');
  const headerRegex = new RegExp(`(?:^|\\n)\\s*${header}\\s*\\n`, 'i');
  const match = headerRegex.exec(normalized);
  if (!match) {
    return '';
  }

  const start = match.index + match[0].length;
  let end = normalized.length;
  for (const stop of stopHeaders) {
    const stopRegex = new RegExp(`(?:^|\\n)\\s*${stop}\\s*\\n`, 'i');
    stopRegex.lastIndex = start;
    const stopMatch = stopRegex.exec(normalized);
    if (stopMatch && stopMatch.index > start && stopMatch.index < end) {
      end = stopMatch.index;
    }
  }

  return normalized.substring(start, end).trim();
}

function sanitizeEmail(value) {
  if (!value || typeof value !== 'string') {
    return null;
  }
  let email = value.trim().toLowerCase();
  email = email.replace(/^\d+/, '');
  if (email.includes('linkedin.com') && !email.endsWith('@linkedin.com')) {
    const gmail = email.match(/([a-z0-9._%+-]+@(?:gmail|googlemail|yahoo|outlook|hotmail|icloud)\.com)/i);
    if (gmail) {
      email = gmail[1].toLowerCase();
    }
  }
  if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(email)) {
    return null;
  }
  if (email.includes('linkedin.com') && !email.endsWith('@linkedin.com')) {
    return null;
  }
  return email;
}

function extractEmailFromRaw(text) {
  const glued = text.match(/([a-z][a-z0-9._%+-]*@(?:gmail|googlemail|yahoo|outlook|hotmail|icloud)\.com)/i);
  if (glued) {
    return sanitizeEmail(glued[1].replace(/^\d+/, ''));
  }
  const all = text.match(/[a-z0-9._%+-]+@(?:gmail|googlemail|yahoo|outlook|hotmail|icloud)\.com/gi);
  if (all?.length) {
    return sanitizeEmail(all[0]);
  }
  return null;
}

function extractPhoneFromRaw(text) {
  const glued = text.match(/(\d{10,12})[a-z0-9._%+-]+@/i);
  if (glued) {
    return glued[1].slice(-10);
  }
  const phoneMatch = text.match(/(?:\+91[\s-]?)?([6-9]\d{9})\b/);
  if (phoneMatch) {
    return phoneMatch[1];
  }
  return null;
}

const INVALID_NAME_PATTERNS = /^(contact\s*details|professional\s*summary|work\s*experience|experience|education|skills|projects|strengths|key\s*achievements|summary|resume|curriculum\s*vitae|cv)$/i;

function isPlausiblePersonName(name) {
  if (!name || typeof name !== 'string') {
    return false;
  }
  const trimmed = name.trim();
  if (trimmed.length < 3 || trimmed.length > 80) {
    return false;
  }
  if (INVALID_NAME_PATTERNS.test(trimmed)) {
    return false;
  }
  if (/@|https?:\/\//i.test(trimmed)) {
    return false;
  }
  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length < 2) {
    return false;
  }
  return true;
}

function extractNameFromRaw(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (const line of lines.slice(0, 8)) {
    if (line.length < 3 || line.length > 60) continue;
    if (line.includes('@') || /https?:\/\//i.test(line) || /\d{8,}/.test(line)) continue;
    if (/^(SUMMARY|EXPERIENCE|EDUCATION|SKILLS|PROJECTS)/i.test(line)) break;
    if (/^[A-Z][A-Z\s.'-]{2,50}$/.test(line)) {
      const candidate = line
        .split(/\s+/)
        .map((w) => w.charAt(0) + w.slice(1).toLowerCase())
        .join(' ');
      if (isPlausiblePersonName(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

function extractLocationFromHeader(text) {
  const headerLine = text.split(/\r?\n/).slice(0, 6).join('\n');
  const cities = ['Noida', 'Bengaluru', 'Bangalore', 'Mumbai', 'Delhi', 'Hyderabad', 'Pune', 'Chennai', 'Chandigarh', 'Agra', 'Mathura'];
  for (const city of cities) {
    const re = new RegExp(`(?:^|[^a-z])${city}(?:[^a-z]|$)`, 'i');
    if (re.test(headerLine)) {
      return city;
    }
  }
  return null;
}

function extractSummaryFromRaw(rawText) {
  const block = getResumeSection(rawText, 'SUMMARY', ['EXPERIENCE', 'EDUCATION', 'PROJECTS', 'SKILLS', 'STRENGTHS']);
  return block.replace(/\s+/g, ' ').trim() || null;
}

function extractSkillsFromRaw(rawText) {
  const block = getResumeSection(rawText, 'SKILLS', ['KEY ACHIEVEMENTS', 'STRENGTHS', 'PROJECTS', 'EDUCATION', 'EXPERIENCE', 'www.']);
  if (!block) {
    return [];
  }
  const cleaned = block
    .replace(/www\.\S+/gi, '')
    .replace(/Powered by/gi, '')
    .replace(/[•​]/g, ' ');
  const parts = cleaned.split(/(?=[A-Z][a-z])/).map((s) => s.trim()).filter((s) => s.length > 1);
  const unique = [...new Set(parts)];
  return unique.filter((s) => s.length < 50 && !/^\d+$/.test(s));
}

function extractEducationFromRaw(rawText) {
  const block = getResumeSection(rawText, 'EDUCATION', ['PROJECTS', 'SKILLS', 'STRENGTHS', 'KEY ACHIEVEMENTS', 'EXPERIENCE']);
  if (!block) {
    return [];
  }

  const entries = [];
  const chunks = block.split(/\n(?=Bachelor|Master|B\.|M\.|BCA|MCA|Diploma|Ph\.)/i).filter((c) => c.trim());

  for (const chunk of chunks) {
    const lines = chunk.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (!lines.length) continue;

    const degreeLine = lines[0];
    const institution = lines.find((l, i) => i > 0 && /college|university|institute|school/i.test(l))
      || (lines[1] && !/\d{2}\/\d{4}/.test(lines[1]) ? lines[1] : '');
    const dateLine = lines.find((l) => /\d{2}\/\d{4}/.test(l) || /\d{4}\s*-\s*\d{2}\/\d{4}/.test(l)) || '';
    const endYear = dateLine.match(/(\d{4})\s*$/);

    entries.push({
      institution: institution || '',
      degree: degreeLine || '',
      field: '',
      year: endYear ? endYear[1] : '',
      duration: dateLine
    });
  }

  return entries;
}

function isValidExperienceEntry(exp) {
  if (!exp?.position || !exp?.company) return false;
  const pos = exp.position.trim();
  const company = exp.company.trim();
  if (pos.length < 2 || company.length < 2) return false;
  if (pos.length < 4 && !/engineer|analyst|developer|manager|tester|lead/i.test(pos)) return false;
  if (company.length > 80 || /expertise|passionate|executing|organization/i.test(company)) return false;
  if (/^(in|at|the|and)$/i.test(pos)) return false;
  return true;
}

function extractExperienceFromRaw(rawText) {
  const block = getResumeSection(rawText, 'EXPERIENCE', ['EDUCATION', 'PROJECTS', 'SKILLS', 'STRENGTHS', 'KEY ACHIEVEMENTS']);
  if (!block) {
    return [];
  }

  const lines = block.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) {
    return [];
  }

  const position = lines[0];
  const company = lines[1].replace(/\s+$/, '');
  const dateLine = lines.find((l) => /\d{2}\/\d{4}/.test(l)) || '';
  const description = lines
    .slice(2)
    .filter((l) => l !== dateLine && !/^VSM Infotech provide/i.test(l))
    .join(' ')
    .substring(0, 800);

  const entry = {
    company,
    position,
    duration: dateLine,
    description,
    startDate: dateLine.match(/\d{2}\/\d{4}/)?.[0] || '',
    endDate: 'Present'
  };

  return isValidExperienceEntry(entry) ? [entry] : [];
}

/**
 * Parse structured fields directly from raw PDF text (Enhancv-style layouts)
 */
function parseStructuredSectionsFromRaw(rawText) {
  if (!rawText) {
    return {};
  }

  const text = rawText.replace(/\u0000/g, ' ');
  const summary = extractSummaryFromRaw(rawText);
  let total_experience = null;
  const yearsMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:\+?\s*)?years?\s+of\s+experience/i)
    || text.match(/nearly\s+(\d+(?:\.\d+)?)\s+years?/i);
  if (yearsMatch) {
    total_experience = parseFloat(yearsMatch[1]);
  }

  return {
    name: extractNameFromRaw(text),
    email: extractEmailFromRaw(text),
    phone: extractPhoneFromRaw(text),
    location: extractLocationFromHeader(text),
    summary,
    skills: extractSkillsFromRaw(rawText),
    experience: extractExperienceFromRaw(rawText),
    education: extractEducationFromRaw(rawText),
    total_experience
  };
}

function fillMissingFromRaw(parsedData, rawText) {
  if (!rawText) {
    return;
  }

  const fromRaw = parseStructuredSectionsFromRaw(rawText);

  if (!isPlausiblePersonName(parsedData.name) && isPlausiblePersonName(fromRaw.name)) {
    parsedData.name = fromRaw.name;
  }

  const cleanEmail = sanitizeEmail(parsedData.email);
  if (!cleanEmail && fromRaw.email) {
    parsedData.email = fromRaw.email;
  } else if (cleanEmail) {
    parsedData.email = cleanEmail;
  }

  if (!parsedData.phone && !parsedData.Mobile_Number && fromRaw.phone) {
    parsedData.phone = fromRaw.phone;
    parsedData.Mobile_Number = fromRaw.phone;
  }

  if (!parsedData.location && fromRaw.location) {
    parsedData.location = fromRaw.location;
  }

  if (!parsedData.summary && fromRaw.summary) {
    parsedData.summary = fromRaw.summary;
  }

  if (parsedData.total_experience == null && fromRaw.total_experience != null) {
    parsedData.total_experience = fromRaw.total_experience;
  }
}

function mergeParsedWithRawSections(parsedData, rawText) {
  const fromRaw = parseStructuredSectionsFromRaw(rawText);

  if (isPlausiblePersonName(fromRaw.name)) {
    parsedData.name = fromRaw.name;
  }
  if (fromRaw.email) parsedData.email = fromRaw.email;
  if (fromRaw.phone) {
    parsedData.phone = fromRaw.phone;
    parsedData.Mobile_Number = fromRaw.phone;
  }
  if (fromRaw.location) parsedData.location = fromRaw.location;
  if (fromRaw.summary) parsedData.summary = fromRaw.summary;
  if (fromRaw.total_experience != null) parsedData.total_experience = fromRaw.total_experience;

  if (fromRaw.skills?.length) {
    parsedData.skills = fromRaw.skills;
  }

  if (fromRaw.education?.length) {
    parsedData.education = fromRaw.education;
  }

  const aiExperience = Array.isArray(parsedData.experience)
    ? parsedData.experience.filter(isValidExperienceEntry)
    : [];
  if (fromRaw.experience?.length) {
    parsedData.experience = fromRaw.experience;
  } else if (aiExperience.length) {
    parsedData.experience = aiExperience;
  } else {
    parsedData.experience = [];
  }

  parsedData.email = sanitizeEmail(parsedData.email) || fromRaw.email || null;
}

/**
 * Normalize education array to schema keys
 */
function normalizeEducation(education) {
  if (!Array.isArray(education)) {
    return [];
  }
  return education.map((edu) => {
    if (!edu || typeof edu !== 'object') {
      return edu;
    }
    const duration = edu.duration || edu.period || '';
    let year = edu.year || '';
    if (!year && duration) {
      const endYear = String(duration).match(/(\d{4})\s*$/);
      year = endYear ? endYear[1] : '';
    }
    return {
      institution: edu.institution || edu.university || edu.school || edu.college || '',
      degree: edu.degree || '',
      field: edu.field || edu.major || '',
      year: String(year || ''),
      ...(duration ? { duration: String(duration) } : {})
    };
  });
}

/**
 * Normalize experience array to schema keys
 */
function normalizeExperience(experience) {
  if (!Array.isArray(experience)) {
    return [];
  }
  return experience.map((exp) => {
    if (!exp || typeof exp !== 'object') {
      return exp;
    }
    return {
      company: exp.company || exp.employer || exp.organization || '',
      position: exp.position || exp.title || exp.role || exp.job_title || '',
      duration: exp.duration || '',
      description: exp.description || exp.responsibilities || exp.summary || '',
      startDate: exp.startDate || exp.start_date || '',
      endDate: exp.endDate || exp.end_date || 'Present'
    };
  });
}

/**
 * Normalize AI field name variants onto canonical keys
 */
function normalizeParsedFieldNames(parsedData) {
  parsedData.name = pickField(parsedData, ['name', 'Name', 'full_name', 'fullName', 'candidate_name']) || parsedData.name;
  parsedData.email = pickField(parsedData, ['email', 'Email', 'email_address', 'Email_Address']) || parsedData.email;
  parsedData.phone = pickField(parsedData, ['phone', 'Phone', 'phone_number', 'contact_number']) || parsedData.phone;
  parsedData.Mobile_Number = pickField(parsedData, ['Mobile_Number', 'mobile', 'mobile_number', 'phone']) || parsedData.Mobile_Number;
  parsedData.location = pickField(parsedData, ['location', 'Location', 'address', 'city']) || parsedData.location;
}

/**
 * Validate and clean parsed resume data
 * Ensures data types are correct and fills in missing fields with defaults
 * Handles edge cases like array locations, missing name parts, etc.
 * 
 * @param {Object} parsedData - Raw parsed data from AI
 * @param {string} [rawText] - Original resume text for fallback extraction
 * @returns {Object} Validated and cleaned resume data
 */
function validateAndCleanData(parsedData, rawText = '', options = {}) {
  const { recoveryMode = false } = options;

  normalizeParsedFieldNames(parsedData);

  if (recoveryMode) {
    mergeParsedWithRawSections(parsedData, rawText);
  } else {
    fillMissingFromRaw(parsedData, rawText);
  }

  parsedData.education = normalizeEducation(parsedData.education);
  parsedData.experience = normalizeExperience(parsedData.experience);

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

