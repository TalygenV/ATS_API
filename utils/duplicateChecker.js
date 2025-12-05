const { queryOne, query } = require('../config/database');

/**
 * Find the original resume ID for a candidate (the first resume without a parent_id)
 * This is used for versioning - all versions of a resume should point to the original
 * @param {Object} parsedData - Parsed resume data
 * @returns {Promise<number|null>} - Original resume ID if duplicate found, null otherwise
 */
async function findOriginalResume(parsedData) {
  try {
    const email = parsedData.email?.toLowerCase().trim();
    const name = parsedData.name?.toLowerCase().trim();

    if (!email && !name) {
      // Can't check for duplicates without email or name
      return null;
    }

    let original = null;

    if (email) {
      // Check by email first (most reliable) - find the original (no parent_id or lowest version)
      // The original is the one with parent_id IS NULL or the one that is the parent of others
      original = await queryOne(
        `SELECT id, email, name, created_at, parent_id, version_number 
         FROM resumes 
         WHERE LOWER(email) = ? 
         ORDER BY 
           CASE WHEN parent_id IS NULL THEN 0 ELSE 1 END,
           version_number ASC,
           created_at ASC 
         LIMIT 1`,
        [email]
      );
    }

    if (!original && name) {
      // Fallback to name if no email match - case-insensitive
      original = await queryOne(
        `SELECT id, email, name, created_at, parent_id, version_number 
         FROM resumes 
         WHERE LOWER(name) = ? 
         ORDER BY 
           CASE WHEN parent_id IS NULL THEN 0 ELSE 1 END,
           version_number ASC,
           created_at ASC 
         LIMIT 1`,
        [name]
      );
    }

    if (original) {
      // If the found resume has a parent_id, return the parent_id (the true original)
      // Otherwise, return the resume's own ID (it is the original)
      return original.parent_id || original.id;
    }

    // If we have both email and name, also check for name match with same email
    // This handles cases where email might be slightly different but name matches
    if (email && name) {
      const nameMatch = await queryOne(
        `SELECT id, email, name, created_at, parent_id, version_number 
         FROM resumes 
         WHERE LOWER(name) = ? 
         ORDER BY 
           CASE WHEN parent_id IS NULL THEN 0 ELSE 1 END,
           version_number ASC,
           created_at ASC 
         LIMIT 1`,
        [name]
      );

      if (nameMatch) {
        // Check if the email also matches (case-insensitive)
        const existingEmail = nameMatch.email?.toLowerCase().trim();
        if (existingEmail && existingEmail === email) {
          return nameMatch.parent_id || nameMatch.id;
        }
      }
    }

    return null;
  } catch (error) {
    console.error('Error in findOriginalResume:', error);
    return null;
  }
}

/**
 * Get the next version number for a candidate's resume
 * @param {number} originalResumeId - The original resume ID (parent)
 * @returns {Promise<number>} - Next version number (1 if it's the first, 2+ for subsequent versions)
 */
async function getNextVersionNumber(originalResumeId) {
  try {
    // Find the highest version number for this candidate
    const maxVersion = await queryOne(
      `SELECT COALESCE(MAX(version_number), 0) as max_version 
       FROM resumes 
       WHERE id = ? OR parent_id = ?`,
      [originalResumeId, originalResumeId]
    );

    return (maxVersion?.max_version || 0) + 1;
  } catch (error) {
    console.error('Error in getNextVersionNumber:', error);
    // Default to version 1 if there's an error
    return 1;
  }
}

/**
 * Check for duplicate resume based on email or email + name combination
 * Returns the ID of the oldest matching record if duplicate is found
 * @param {Object} parsedData - Parsed resume data
 * @returns {Promise<number|null>} - Parent ID if duplicate found, null otherwise
 * @deprecated Use findOriginalResume instead for versioning support
 */
async function findDuplicateResume(parsedData) {
  // For backward compatibility, use findOriginalResume
  return await findOriginalResume(parsedData);
}

module.exports = {
  findDuplicateResume,
  findOriginalResume,
  getNextVersionNumber
};
