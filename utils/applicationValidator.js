const { queryOne } = require('../config/database');

/**
 * Check if a candidate has already applied within the last 6 months
 * @param {string} email - Candidate email (normalized to lowercase)
 * @returns {Promise<boolean>} - True if candidate has applied within last 6 months, false otherwise
 */
async function hasRecentApplication(email) {
  if (!email) {
    // If no email provided, we can't check, so allow the application
    return false;
  }

  try {
    // Normalize email to lowercase for consistency
    const normalizedEmail = email.toLowerCase().trim();

    // Check for any application within the last 6 months
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

    const recentApplication = await queryOne(
      `SELECT id, created_at 
       FROM candidate_evaluations 
       WHERE email = ? AND created_at >= ? 
       ORDER BY created_at DESC 
       LIMIT 1`,
      [normalizedEmail, sixMonthsAgo]
    );

    return !!recentApplication;
  } catch (error) {
    console.error('Error checking for recent application:', error);
    // On error, allow the application to proceed (fail open)
    return false;
  }
}

module.exports = {
  hasRecentApplication
};

