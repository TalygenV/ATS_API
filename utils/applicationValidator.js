// Application Validator Utility
// This module validates candidate applications to prevent duplicates and conflicts

const { queryOne, query } = require('../config/database');

/**
 * Check if a candidate has already applied within the last 6 months
 * Prevents duplicate applications from the same candidate within a 6-month period
 * 
 * @param {string} email - Candidate email address (will be normalized to lowercase)
 * @returns {Promise<boolean>} True if candidate has applied within last 6 months, false otherwise
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

/**
 * Check if a candidate already has an interview assigned
 * Prevents duplicate interview assignments for the same candidate
 * Also performs cleanup of orphaned interview data for candidates without active interviews
 * 
 * @param {string} email - Candidate email address (will be normalized to lowercase)
 * @returns {Promise<boolean>} True if candidate has an interview already assigned, false otherwise
 */
async function alreadyAssignInterView(email) {
  if (!email) {
    // If no email provided, we can't check, so allow the application
    return false;
  }

  try {
    // Normalize email to lowercase for consistency
    const normalizedEmail = email.toLowerCase().trim();

    // Check if candidate has an interview already scheduled using interview_details table
    const interviewScheduled = await queryOne(
      `SELECT ce.*
       FROM candidate_evaluations ce
       INNER JOIN interview_details id ON ce.id = id.candidate_evaluations_id
       WHERE ce.email = ?
         AND ce.hr_final_status = 'pending'
       ORDER BY ce.created_at DESC
       LIMIT 1`,
      [normalizedEmail]
    );

    // If no interview scheduled, clean up any orphaned interview data
    // This handles cases where interview_details exist but shouldn't
    if(!interviewScheduled)
    {
      // Get evaluations that might need cleanup (pending evaluations without active interviews)
      const evaluationsToClean = await query(
        `SELECT ce.id
         FROM candidate_evaluations ce
         WHERE ce.email = ?
           AND ce.hr_final_status = 'pending'`,
        [normalizedEmail]
      );

      // Clean up interview_details and free slots for these evaluations
      for (const eval of evaluationsToClean) {
        // Get interview_details for this evaluation
        const interviewDetails = await query(
          `SELECT id, interviewer_time_slots_id 
           FROM interview_details 
           WHERE candidate_evaluations_id = ?`,
          [eval.id]
        );

        // Free old slots
        if (interviewDetails.length > 0) {
          const slotIds = interviewDetails.map(detail => detail.interviewer_time_slots_id).filter(Boolean);
          if (slotIds.length > 0) {
            await query(
              `UPDATE interviewer_time_slots 
               SET is_booked = 0, evaluation_id = NULL 
               WHERE id IN (${slotIds.map(() => '?').join(',')})`,
              slotIds
            );
          }

          // Delete interview_details
          await query(
            `DELETE FROM interview_details 
             WHERE candidate_evaluations_id = ?`,
            [eval.id]
          );
        }

        // Clean up candidate_evaluations fields that still exist
        await query(
          `UPDATE candidate_evaluations
           SET
             interview_start_url = NULL,
             interview_join_url = NULL,
             hr_final_reason = NULL,
             hr_remarks = NULL,
             hr_final_status = 'pending',
             updated_at = NOW()
           WHERE id = ?`,
          [eval.id]
        );
      }
    }

    return !!interviewScheduled;
  } catch (error) {
    console.error('Error checking for interview assignment:', error);
    // On error, allow the application to proceed (fail open)
    return false;
  }
}

module.exports = {
  hasRecentApplication,
  alreadyAssignInterView
};

