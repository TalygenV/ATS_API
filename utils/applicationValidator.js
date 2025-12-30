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


async function alreadyAssignInterView(email) {
  if (!email) {
    // If no email provided, we can't check, so allow the application
    return false;
  }

  try {
    // Normalize email to lowercase for consistency
    const normalizedEmail = email.toLowerCase().trim();

    // Check for  application interview already scheduled
    // const interviewScheduled = await queryOne(
    //   `SELECT id, created_at 
    //    FROM candidate_evaluations 
    //    WHERE email = ? And interviewer_id is not null 
    //    ORDER BY created_at DESC 
    //    LIMIT 1`,
    //   [normalizedEmail]
    // );
    const interviewScheduled = await queryOne(
      `SELECT *
       FROM candidate_evaluations
       WHERE email = ?
         AND interviewer_id IS NOT NULL
         AND hr_final_status = 'pending'
       ORDER BY created_at DESC
       LIMIT 1`,
      [normalizedEmail]
    );

    if(!interviewScheduled)
    {
      let query = `UPDATE candidate_evaluations
SET
  interviewer_id = NULL,
  interview_date = NULL,
  interviewer_feedback = NULL,
  interviewer_status = 'pending',
  interview_start_url = NULL,
  interview_join_url = NULL,
  hr_final_reason = NULL,
  hr_remarks=NULL,
  hr_final_status ='pending',
  updated_at = NOW()
WHERE email = ?`

     await queryOne(query , [normalizedEmail])
    }

    return !!interviewScheduled;
  } catch (error) {
    console.error('Error checking for recent application:', error);
    // On error, allow the application to proceed (fail open)
    return false;
  }
}

module.exports = {
  hasRecentApplication,
  alreadyAssignInterView
};

