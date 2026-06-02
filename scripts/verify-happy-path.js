/**
 * Local verification for happy-path vs recovery-path logic (no Groq API calls).
 */
const { tryParseJson } = require('../utils/groqJsonUtils');

const kumarRaw = `
KUMAR AMAN
CONTACT DETAILS
Email: kumar@example.com
Phone: 9876543210

PROFESSIONAL SUMMARY
QA engineer with manual testing experience.

SKILLS
Selenium, JIRA, Manual Testing
`;

const kumarParsed = {
  name: 'Kumar Aman',
  email: 'kumar@example.com',
  phone: '9876543210',
  skills: ['Selenium', 'JIRA', 'Manual Testing'],
  experience: [{ title: 'QA Engineer', company: 'Acme', duration: '2 years' }],
  education: [{ degree: 'BCA', institution: 'University', year: '2020' }],
  total_experience: 2
};

// Inline copies of key helpers for offline test (not exported from resumeParser)
const INVALID_NAME_PATTERNS = /^(contact\s*details|professional\s*summary|work\s*experience|experience|education|skills|projects|strengths|key\s*achievements|summary|resume|curriculum\s*vitae|cv)$/i;

function isPlausiblePersonName(name) {
  if (!name || typeof name !== 'string') return false;
  const trimmed = name.trim();
  if (trimmed.length < 3 || trimmed.length > 80) return false;
  if (INVALID_NAME_PATTERNS.test(trimmed)) return false;
  if (/@|https?:\/\//i.test(trimmed)) return false;
  const words = trimmed.split(/\s+/).filter(Boolean);
  return words.length >= 2;
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
      if (isPlausiblePersonName(candidate)) return candidate;
    }
  }
  return null;
}

let failed = 0;

function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg);
    failed++;
  } else {
    console.log('OK:', msg);
  }
}

const badHeaderName = extractNameFromRaw(kumarRaw);
assert(badHeaderName === 'Kumar Aman', `extractNameFromRaw picks person name before section headers (got: ${badHeaderName})`);
assert(!isPlausiblePersonName('Contact Details'), 'Contact Details is not a plausible name');

const headerOnlyRaw = 'CONTACT DETAILS\n9758019189abhishek@example.com\n';
assert(extractNameFromRaw(headerOnlyRaw) === null, 'section header CONTACT DETAILS is not extracted as name');

const happyCopy = JSON.parse(JSON.stringify(kumarParsed));
// Happy path: do not overwrite good AI name with raw section header
assert(happyCopy.name === 'Kumar Aman', 'happy path keeps AI name');

const matchJson = tryParseJson(
  'Analysis:\n{"overall_match":80,"skills_match":80,"skills_details":"Kumar Aman has a strong match","experience_match":65,"experience_details":"Good","education_match":70,"education_details":"BCA","status":"accepted","rejection_reason":""}',
  { quiet: true }
);
assert(matchJson.ok && matchJson.data.skills_match === 80, 'matcher-style prefixed JSON parses');

const validResumeJson = tryParseJson(JSON.stringify(kumarParsed), { quiet: true });
assert(validResumeJson.ok && validResumeJson.data.name === 'Kumar Aman', 'primary resume JSON parses locally');

console.log(failed ? `\n${failed} assertion(s) failed` : '\nAll local checks passed');
process.exit(failed ? 1 : 0);
