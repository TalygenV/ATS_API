const { queryOne } = require('../config/database');

/**
 * Check for duplicate resume based on email or email + name combination
 * Returns the ID of the oldest matching record if duplicate is found
 * @param {Object} parsedData - Parsed resume data
 * @returns {Promise<number|null>} - Parent ID if duplicate found, null otherwise
 */
async function findDuplicateResume(parsedData) {
  try {
    const email = parsedData.email?.toLowerCase().trim();
    const name = parsedData.name?.toLowerCase().trim();

    if (!email && !name) {
      // Can't check for duplicates without email or name
      return null;
    }

    let duplicate = null;

    if (email) {
      // Check by email first (most reliable) - case-insensitive
      duplicate = await queryOne(
        'SELECT id, email, name, created_at FROM resumes WHERE LOWER(email) = ? ORDER BY created_at ASC LIMIT 1',
        [email]
      );
    }

    if (!duplicate && name) {
      // Fallback to name if no email match - case-insensitive
      duplicate = await queryOne(
        'SELECT id, email, name, created_at FROM resumes WHERE LOWER(name) = ? ORDER BY created_at ASC LIMIT 1',
        [name]
      );
    }

    if (duplicate) {
      return duplicate.id;
    }

    // If we have both email and name, also check for name match with same email
    // This handles cases where email might be slightly different but name matches
    if (email && name) {
      const nameMatch = await queryOne(
        'SELECT id, email, name, created_at FROM resumes WHERE LOWER(name) = ? ORDER BY created_at ASC LIMIT 1',
        [name]
      );

      if (nameMatch) {
        // Check if the email also matches (case-insensitive)
        const existingEmail = nameMatch.email?.toLowerCase().trim();
        if (existingEmail && existingEmail === email) {
          return nameMatch.id;
        }
      }
    }

    return null;
  } catch (error) {
    console.error('Error in findDuplicateResume:', error);
    return null;
  }
}

module.exports = {
  findDuplicateResume
};
