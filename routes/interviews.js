const express = require('express');
const { query, queryOne } = require('../config/database');
const { authenticate, requireWriteAccess, authorize } = require('../middleware/auth');
const {
  sendEmail,
  sendInterviewAssignmentToInterviewer,
  sendInterviewAssignmentToCandidate
} = require('../utils/emailService');
const { toUTCString, fromUTCString, convertResultToUTC } = require('../utils/datetimeUtils');
const { generateInterViewLink } = require('../utils/zoomLinkGenerate');


const router = express.Router();

// Assign interviewer to a candidate evaluation (HR/Admin only)
router.post('/assign', authenticate, requireWriteAccess, async (req, res) => {
  try {
    const { evaluation_id, interviewer_id, interview_date, slot_id } = req.body;

    if (!evaluation_id || !interviewer_id || (!interview_date && !slot_id)) {
      return res.status(400).json({
        success: false,
        error: 'evaluation_id, interviewer_id and either interview_date or slot_id are required'
      });
    }

    // Validate interviewer exists, is an Interviewer, and is active
    const interviewer = await queryOne(
      'SELECT id, email, role, full_name, status FROM users WHERE id = ? AND role = ? AND status = ?',
      [interviewer_id, 'Interviewer', 'active']
    );

    if (!interviewer) {
      return res.status(400).json({
        success: false,
        error: 'Invalid interviewer ID, user is not an Interviewer, or interviewer is inactive'
      });
    }

    // Get evaluation with candidate and job details
    const evaluation = await queryOne(
      `SELECT ce.*, 
        r.name as candidate_name, r.email as candidate_email,
        jd.title as job_title
       FROM candidate_evaluations ce
       LEFT JOIN resumes r ON ce.resume_id = r.id
       LEFT JOIN job_descriptions jd ON ce.job_description_id = jd.id
       WHERE ce.id = ?`,
      [evaluation_id]
    );

    if (!evaluation) {
      return res.status(404).json({
        success: false,
        error: 'Evaluation not found'
      });
    }

    // Step 1: Cancel old assignments - Get all existing interview_details for this evaluation
    const oldInterviewDetails = await query(
      `SELECT id, interviewer_time_slots_id 
       FROM interview_details 
       WHERE candidate_evaluations_id = ?`,
      [evaluation_id]
    );

    // Step 2: Free old slots (set is_booked = 0, evaluation_id = NULL)
    if (oldInterviewDetails.length > 0) {
      const oldSlotIds = oldInterviewDetails.map(detail => detail.interviewer_time_slots_id).filter(Boolean);
      if (oldSlotIds.length > 0) {
        await query(
          `UPDATE interviewer_time_slots 
           SET is_booked = 0, evaluation_id = NULL 
           WHERE id IN (${oldSlotIds.map(() => '?').join(',')})`,
          oldSlotIds
        );
      }
    }

    // Step 3: Delete all existing interview_details for this evaluation
    await query(
      `DELETE FROM interview_details 
       WHERE candidate_evaluations_id = ?`,
      [evaluation_id]
    );

    let finalInterviewDate = interview_date;

    // If HR selected a predefined slot, mark it booked and use its start_time
    if (slot_id) {
      const slot = await queryOne(
        `SELECT * FROM interviewer_time_slots 
         WHERE id = ? AND interviewer_id = ? AND is_booked = 0`,
        [slot_id, interviewer_id]
      );

      if (!slot) {
        return res.status(400).json({
          success: false,
          error: 'Selected slot is not available'
        });
      }

      await query(
        `UPDATE interviewer_time_slots 
         SET is_booked = 1, evaluation_id = ?, job_description_id = ?
         WHERE id = ? AND is_booked = 0`,
        [evaluation_id, evaluation.job_description_id, slot_id]
      );

      finalInterviewDate = slot.start_time;
    }

    // Convert interview date to UTC
    const interviewDateUTC = toUTCString(finalInterviewDate);

    // Generate interview link
    const interviewLink = await generateInterViewLink({
      topic: "INTERVIEW",
      start_time: interviewDateUTC,
      duration: process.env.INTERVIEW_TIME_SLOT,
    });

    // Update candidate_evaluations with interview links (shared link for all interviewers)
    await query(
      `UPDATE candidate_evaluations 
       SET interview_start_url = ?, interview_join_url = ?
       WHERE id = ?`,
      [interviewLink.start_url, interviewLink.join_url, evaluation_id]
    );

    // Create assignment record (convert to UTC)
    const assignmentNote = oldInterviewDetails.length > 0 ? 'Reassigned' : null;
    await query(
      `INSERT INTO interview_assignments (evaluation_id, interviewer_id, interview_date, assigned_by, notes)
       VALUES (?, ?, ?, ?, ?)`,
      [evaluation_id, interviewer_id, interviewDateUTC, req.user.id, assignmentNote]
    );

    // Create interview_details record (using interview_details table structure)
    await query(
      `INSERT INTO interview_details (candidate_evaluations_id, interviewer_time_slots_id, interviewer_id, interviewer_status)
       VALUES (?, ?, ?, 'pending')`,
      [evaluation_id, slot_id, interviewer_id]
    );

    // Send email notifications
    const candidateName = evaluation.candidate_name || evaluation.name || 'Candidate';
    const candidateEmail = evaluation.candidate_email || evaluation.email;
    const jobTitle = evaluation.job_title || 'Position';

 // Send to interviewer
    if (interviewer.email) {
      await sendInterviewAssignmentToInterviewer({
        // interviewerEmail: interviewer.email,
        interviewerEmail : 'ssrivastav@zorbis.com',
        interviewerName: interviewer.full_name || interviewer.email,
        candidateName,
        candidateEmail,
        jobTitle,
        interviewDate: fromUTCString(interviewDateUTC),
        interViewLink : interviewLink.start_url
      });
    }

    // Send to candidate
    if (candidateEmail) {
      await sendInterviewAssignmentToCandidate({
        candidateEmail : 'ssrivastav@cogniter.com',
        candidateName,
        jobTitle,
        interviewDate: fromUTCString(interviewDateUTC),
        interviewerName: interviewer.full_name || interviewer.email,
         interviewLink : interviewLink.join_url
      });
    }


    // Get updated evaluation with interview details
    const updatedEvaluation = await queryOne(
      `SELECT ce.*
       FROM candidate_evaluations ce
       WHERE ce.id = ?`,
      [evaluation_id]
    );

    // Get interview details for this evaluation
    const interviewDetails = await query(
      `SELECT 
        id.id,
        id.interviewer_id,
        id.interviewer_status,
        id.interviewer_feedback,
        id.interviewer_hold_reason,
        its.start_time as interview_date,
        its.end_time as interview_end_time,
        JSON_OBJECT(
          'id', u.id,
          'email', u.email,
          'full_name', u.full_name
        ) as interviewer
      FROM interview_details id
      INNER JOIN interviewer_time_slots its ON id.interviewer_time_slots_id = its.id
      LEFT JOIN users u ON id.interviewer_id COLLATE utf8mb4_unicode_ci = u.id COLLATE utf8mb4_unicode_ci
      WHERE id.candidate_evaluations_id = ?
      ORDER BY its.start_time ASC`,
      [evaluation_id]
    );

    // Parse interview details
    const parsedInterviewDetails = interviewDetails.map(detail => ({
      ...detail,
      interviewer: detail.interviewer ? JSON.parse(detail.interviewer) : null,
      interviewer_feedback: detail.interviewer_feedback ? JSON.parse(detail.interviewer_feedback) : null
    }));

    const parsedEvaluation = {
      ...updatedEvaluation,
      interview_details: convertResultToUTC(parsedInterviewDetails)
    };
    
    // Convert datetime fields to UTC
    const convertedEvaluation = convertResultToUTC(parsedEvaluation);

    // Notify HR/Admin about scheduled interview
    try {
      const hrAdminUsers = await query(
        "SELECT email, role FROM users WHERE role IN ('HR', 'Admin')"
      );

      const hrAdminEmails = hrAdminUsers.map(u => u.email).filter(Boolean);
      if (hrAdminEmails.length > 0) {
        const subject = `Interview Scheduled: ${candidateName} - ${jobTitle}`;
        const html = `
          <!DOCTYPE html>
          <html>
          <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
            <h2>Interview Scheduled</h2>
            <p>An interview has been scheduled with the following details:</p>
            <ul>
              <li><strong>Candidate:</strong> ${candidateName}</li>
              <li><strong>Candidate Email:</strong> ${candidateEmail || 'N/A'}</li>
              <li><strong>Job Position:</strong> ${jobTitle}</li>
              <li><strong>Interviewer:</strong> ${interviewer.full_name || interviewer.email}</li>
                 <li><strong>Interviewer Link:</strong> ${interviewLink.start_url}</li>
                  <li><strong>User Link Link:</strong> ${interviewLink.join_url}</li>
              <li><strong>Date & Time:</strong> ${fromUTCString(finalInterviewDate) ? fromUTCString(finalInterviewDate).toLocaleString('en-US') : 'N/A'}</li>
            </ul>
          </body>
          </html>
        `;

        sendEmail({
          to: 'schamoli@cogniter.com',
          subject,
          html
        })
     
        // uncomment to send email to all hr and admin
        // await Promise.all(
        //   hrAdminEmails.map(email =>
        //     sendEmail({
        //       to: email,
        //       subject,
        //       html
        //     })
        //   )
        // );
      }
    } catch (notifyError) {
      console.error('Error sending HR/Admin schedule emails:', notifyError);
    }

    res.json({
      success: true,
      message: 'Interviewer assigned successfully',
      data: convertedEvaluation
    });
  } catch (error) {
    console.error('Error assigning interviewer:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to assign interviewer',
      message: error.message
    });
  }
});

// Reassign/Update interview details (HR/Admin only)
router.put('/assign/:evaluation_id', authenticate, requireWriteAccess, async (req, res) => {
  try {
    const { evaluation_id } = req.params;
    const { interviewer_id, interview_date, slot_id } = req.body;

    if (!interviewer_id || (!interview_date && !slot_id)) {
      return res.status(400).json({
        success: false,
        error: 'interviewer_id and either interview_date or slot_id are required'
      });
    }

    // Validate interviewer exists, is an Interviewer, and is active
    const interviewer = await queryOne(
      'SELECT id, email, role, full_name, status FROM users WHERE id = ? AND role = ? AND status = ?',
      [interviewer_id, 'Interviewer', 'active']
    );

    if (!interviewer) {
      return res.status(400).json({
        success: false,
        error: 'Invalid interviewer ID, user is not an Interviewer, or interviewer is inactive'
      });
    }

    // Get evaluation with candidate and job details
    const evaluation = await queryOne(
      `SELECT ce.*, 
        r.name as candidate_name, r.email as candidate_email,
        jd.title as job_title
       FROM candidate_evaluations ce
       LEFT JOIN resumes r ON ce.resume_id = r.id
       LEFT JOIN job_descriptions jd ON ce.job_description_id = jd.id
       WHERE ce.id = ?`,
      [evaluation_id]
    );

    if (!evaluation) {
      return res.status(404).json({
        success: false,
        error: 'Evaluation not found'
      });
    }

    // Step 1: Cancel old assignments - Get all existing interview_details for this evaluation
    const oldInterviewDetails = await query(
      `SELECT id, interviewer_time_slots_id 
       FROM interview_details 
       WHERE candidate_evaluations_id = ?`,
      [evaluation_id]
    );

    // Step 2: Free old slots (set is_booked = 0, evaluation_id = NULL)
    if (oldInterviewDetails.length > 0) {
      const oldSlotIds = oldInterviewDetails.map(detail => detail.interviewer_time_slots_id).filter(Boolean);
      if (oldSlotIds.length > 0) {
        await query(
          `UPDATE interviewer_time_slots 
           SET is_booked = 0, evaluation_id = NULL 
           WHERE id IN (${oldSlotIds.map(() => '?').join(',')})`,
          oldSlotIds
        );
      }
    }

    // Step 3: Delete all existing interview_details for this evaluation
    await query(
      `DELETE FROM interview_details 
       WHERE candidate_evaluations_id = ?`,
      [evaluation_id]
    );

    let finalInterviewDate = interview_date;

    if (slot_id) {
      const slot = await queryOne(
        `SELECT * FROM interviewer_time_slots 
         WHERE id = ? AND interviewer_id = ? AND is_booked = 0`,
        [slot_id, interviewer_id]
      );

      if (!slot) {
        return res.status(400).json({
          success: false,
          error: 'Selected slot is not available'
        });
      }

      await query(
        `UPDATE interviewer_time_slots 
         SET is_booked = 1, evaluation_id = ?, job_description_id = ?
         WHERE id = ? AND is_booked = 0`,
        [evaluation_id, evaluation.job_description_id, slot_id]
      );

      finalInterviewDate = slot.start_time;
    }

    // Convert interview date to UTC
    const interviewDateUTC = toUTCString(finalInterviewDate);

    // Generate interview link
    const interviewLink = await generateInterViewLink({
      topic: "INTERVIEW",
      start_time: interviewDateUTC,
      duration: process.env.INTERVIEW_TIME_SLOT,
    });

    // Update candidate_evaluations with interview links (shared link for all interviewers)
    await query(
      `UPDATE candidate_evaluations 
       SET interview_start_url = ?, interview_join_url = ?
       WHERE id = ?`,
      [interviewLink.start_url, interviewLink.join_url, evaluation_id]
    );

    // Step 4: Create new assignment record (convert to UTC)
    const assignmentNote = oldInterviewDetails.length > 0 ? 'Reassigned' : 'Assigned';
    await query(
      `INSERT INTO interview_assignments (evaluation_id, interviewer_id, interview_date, assigned_by, notes)
       VALUES (?, ?, ?, ?, ?)`,
      [evaluation_id, interviewer_id, interviewDateUTC, req.user.id, assignmentNote]
    );

    // Step 5: Create new interview_details record
    await query(
      `INSERT INTO interview_details (candidate_evaluations_id, interviewer_time_slots_id, interviewer_id, interviewer_status)
       VALUES (?, ?, ?, 'pending')`,
      [evaluation_id, slot_id, interviewer_id]
    );

    // Send email notifications
    const candidateName = evaluation.candidate_name || evaluation.name || 'Candidate';
    const candidateEmail = evaluation.candidate_email || evaluation.email;
    const jobTitle = evaluation.job_title || 'Position';


    // Send to interviewer
    if (interviewer.email) {
      await sendInterviewAssignmentToInterviewer({
        // interviewerEmail: interviewer.email,
        interviewerEmail : 'ssrivastav@zorbis.com',
        interviewerName: interviewer.full_name || interviewer.email,
        candidateName,
        candidateEmail,
        jobTitle,
        interviewDate: fromUTCString(interviewDateUTC),
        interViewLink : interviewLink.start_url
      });
    }

    // Send to candidate
    if (candidateEmail) {
      await sendInterviewAssignmentToCandidate({
        candidateEmail : 'ssrivastav@cogniter.com',
        candidateName,
        jobTitle,
        interviewDate: fromUTCString(interviewDateUTC),
        interviewerName: interviewer.full_name || interviewer.email,
         interviewLink : interviewLink.join_url
      });
    }

    // Get updated evaluation with interview details
    const updatedEvaluation = await queryOne(
      `SELECT ce.*
       FROM candidate_evaluations ce
       WHERE ce.id = ?`,
      [evaluation_id]
    );

    // Get interview details for this evaluation
    const interviewDetails = await query(
      `SELECT 
        id.id,
        id.interviewer_id,
        id.interviewer_status,
        id.interviewer_feedback,
        id.interviewer_hold_reason,
        its.start_time as interview_date,
        its.end_time as interview_end_time,
        JSON_OBJECT(
          'id', u.id,
          'email', u.email,
          'full_name', u.full_name
        ) as interviewer
      FROM interview_details id
      INNER JOIN interviewer_time_slots its ON id.interviewer_time_slots_id = its.id
      LEFT JOIN users u ON id.interviewer_id COLLATE utf8mb4_unicode_ci = u.id COLLATE utf8mb4_unicode_ci
      WHERE id.candidate_evaluations_id = ?
      ORDER BY its.start_time ASC`,
      [evaluation_id]
    );

    // Parse interview details
    const parsedInterviewDetails = interviewDetails.map(detail => ({
      ...detail,
      interviewer: detail.interviewer ? JSON.parse(detail.interviewer) : null,
      interviewer_feedback: detail.interviewer_feedback ? JSON.parse(detail.interviewer_feedback) : null
    }));

    const parsedEvaluation = {
      ...updatedEvaluation,
      interview_details: convertResultToUTC(parsedInterviewDetails)
    };
    
    // Convert datetime fields to UTC
    const convertedEvaluation = convertResultToUTC(parsedEvaluation);

    // Notify HR/Admin about updated interview schedule
    try {
      const hrAdminUsers = await query(
        "SELECT email, role FROM users WHERE role IN ('HR', 'Admin')"
      );

      const hrAdminEmails = hrAdminUsers.map(u => u.email).filter(Boolean);
      if (hrAdminEmails.length > 0) {
        const subject = `Interview Updated: ${candidateName} - ${jobTitle}`;
        const html = `
          <!DOCTYPE html>
          <html>
          <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
            <h2>Interview Schedule Updated</h2>
            <p>An interview schedule has been updated with the following details:</p>
            <ul>
              <li><strong>Candidate:</strong> ${candidateName}</li>
              <li><strong>Candidate Email:</strong> ${candidateEmail || 'N/A'}</li>
              <li><strong>Job Position:</strong> ${jobTitle}</li>
              <li><strong>Interviewer:</strong> ${interviewer.full_name || interviewer.email}</li>
                <li><strong>User Link :</strong> ${interviewLink.join_url}</li>
              <li><strong>Interviewer Link:</strong> ${interviewLink.start_url}</li>
              <li><strong>New Date & Time:</strong> ${fromUTCString(finalInterviewDate) ? fromUTCString(finalInterviewDate).toLocaleString('en-US') : 'N/A'}</li>
            </ul>
          </body>
          </html>
        `;

        sendEmail({
          to: 'schamoli@cogniter.com',
          subject,
          html
        })
         // uncomment to send email to all hr and admin
        // await Promise.all(
        //   hrAdminEmails.map(email =>
        //     sendEmail({
        //       to: email,
        //       subject,
        //       html
        //     })
        //   )
        // );
      }
    } catch (notifyError) {
      console.error('Error sending HR/Admin reschedule emails:', notifyError);
    }

    res.json({
      success: true,
      message: 'Interview details updated successfully',
      data: convertedEvaluation
    });
  } catch (error) {
    console.error('Error updating interview assignment:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update interview assignment',
      message: error.message
    });
  }
});

// Get interviewer's assigned candidates list for seven days (Interviewer only)
router.get('/my-assignments', authenticate, authorize('Interviewer'), async (req, res) => {
  try {
    const { status } = req.query;

    let sql = `
      SELECT 
        ce.*,
        id.id as interview_details_id,
        id.interviewer_status,
        id.interviewer_feedback,
        id.interviewer_hold_reason,
        its.start_time as interview_date,
        its.end_time as interview_end_time,
        JSON_OBJECT(
          'id', r.id,
          'name', r.name,
          'email', r.email,
          'phone', r.phone,
          'file_name', r.file_name,
          'location', r.location,
          'total_experience', r.total_experience
        ) as resume,
        JSON_OBJECT(
          'id', jd.id,
          'title', jd.title,
          'description', jd.description
        ) as job_description
      FROM candidate_evaluations ce
      INNER JOIN interview_details id ON ce.id = id.candidate_evaluations_id
      INNER JOIN interviewer_time_slots its ON id.interviewer_time_slots_id = its.id
      LEFT JOIN resumes r ON ce.resume_id = r.id
      LEFT JOIN job_descriptions jd ON ce.job_description_id = jd.id
      WHERE id.interviewer_id COLLATE utf8mb4_unicode_ci = ? COLLATE utf8mb4_unicode_ci
      AND its.start_time >= UTC_TIMESTAMP() - INTERVAL 7 DAY
    `;

    const params = [req.user.id];

    if (status) {
      sql += ' AND id.interviewer_status = ?';
      params.push(status);
    }

    sql += ' ORDER BY its.start_time ASC, ce.created_at DESC ';

    const evaluations = await query(sql, params);

    // Parse JSON fields and convert datetime to UTC
    const parsedEvaluations = evaluations.map(eval => {
      const parsed = {
        ...eval,
        resume: eval.resume ? JSON.parse(eval.resume) : null,
        job_description: eval.job_description ? JSON.parse(eval.job_description) : null,
        interviewer_feedback: eval.interviewer_feedback ? JSON.parse(eval.interviewer_feedback) : null
      };
      // Parse nested JSON in resume
      if (parsed.resume) {
        parsed.resume.skills = parsed.resume.skills ? JSON.parse(parsed.resume.skills) : [];
        parsed.resume.experience = parsed.resume.experience ? JSON.parse(parsed.resume.experience) : [];
        parsed.resume.education = parsed.resume.education ? JSON.parse(parsed.resume.education) : [];
      }
      return convertResultToUTC(parsed);
    });

    res.json({
      success: true,
      count: parsedEvaluations.length,
      data: parsedEvaluations
    });
  } catch (error) {
    console.error('Error fetching interviewer assignments:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch assignments',
      message: error.message
    });
  }
});

// Get interviewer's assigned candidates (Interviewer only)
router.get('/my-assignments/decision', authenticate, authorize('Interviewer'), async (req, res) => {
  try {
    const { status, decision = 'pending', limit = 10, page = 1 } = req.query;
    const params = [req.user.id];
    const offset = ((parseInt(page) - 1) * parseInt(limit)).toString();
    
    let whereSql = `
      FROM candidate_evaluations ce
      INNER JOIN interview_details id ON ce.id = id.candidate_evaluations_id
      INNER JOIN interviewer_time_slots its ON id.interviewer_time_slots_id = its.id
      LEFT JOIN resumes r ON ce.resume_id = r.id
      LEFT JOIN job_descriptions jd ON ce.job_description_id = jd.id
      WHERE id.interviewer_id COLLATE utf8mb4_unicode_ci = ? COLLATE utf8mb4_unicode_ci
    `;

    if (status) {
      whereSql += ` AND id.interviewer_status = ?`;
      params.push(status);
    }

    if (decision === 'complete') {
      whereSql += `
        AND its.start_time <= UTC_TIMESTAMP()
        AND id.interviewer_feedback IS NOT NULL
      `;
    }

    if (decision === 'pending') {
      whereSql += `
        AND its.start_time <= UTC_TIMESTAMP()
        AND id.interviewer_feedback IS NULL
      `;
    }

    let sql = `
      SELECT 
        ce.*,
        id.id as interview_details_id,
        id.interviewer_status,
        id.interviewer_feedback,
        id.interviewer_hold_reason,
        its.start_time as interview_date,
        its.end_time as interview_end_time,
        JSON_OBJECT(
          'id', r.id,
          'name', r.name,
          'email', r.email,
          'phone', r.phone,
          'file_name', r.file_name,
          'location', r.location,
          'total_experience', r.total_experience
        ) as resume,
        JSON_OBJECT(
          'id', jd.id,
          'title', jd.title,
          'description', jd.description
        ) as job_description
      ${whereSql}
    `;

    // Add ordering based on decision type
    if (decision === 'complete') {
      sql += ' ORDER BY its.start_time DESC ';
    } else if (decision === 'pending') {
      sql += ' ORDER BY its.start_time ASC, ce.created_at DESC ';
    }

    const countSql = `
      SELECT COUNT(*) as total
      ${whereSql}
    `;

    const [countResult] = await query(countSql, params);
    const totalResult = countResult.total;
    const totalPages = Math.ceil(totalResult / limit);

    sql += ` LIMIT ? OFFSET ? `;
    params.push(limit);
    params.push(offset);

    const evaluations = await query(sql, params);

    // Parse JSON fields and convert datetime to UTC
    const parsedEvaluations = evaluations.map(eval => {
      const parsed = {
        ...eval,
        resume: eval.resume ? JSON.parse(eval.resume) : null,
        job_description: eval.job_description ? JSON.parse(eval.job_description) : null,
        interviewer_feedback: eval.interviewer_feedback ? JSON.parse(eval.interviewer_feedback) : null
      };
      // Parse nested JSON in resume
      if (parsed.resume) {
        parsed.resume.skills = parsed.resume.skills ? JSON.parse(parsed.resume.skills) : [];
        parsed.resume.experience = parsed.resume.experience ? JSON.parse(parsed.resume.experience) : [];
        parsed.resume.education = parsed.resume.education ? JSON.parse(parsed.resume.education) : [];
      }
      return convertResultToUTC(parsed);
    });

    res.json({
      success: true,
      count: parsedEvaluations.length,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: parseInt(totalResult),
        totalPages: parseInt(totalPages)
      },
      data: parsedEvaluations
    });
  } catch (error) {
    console.error('Error fetching interviewer assignments:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch assignments',
      message: error.message
    });
  }
});



// Generate 30-minute time slots for an interviewer within a time range (Interviewer only)
router.post('/slots/generate', authenticate, authorize('Interviewer'), async (req, res) => {
  try {
    const { date, start_time, end_time } = req.body;

    if (!date) {
      return res.status(400).json({
        success: false,
        error: 'date is required (YYYY-MM-DD)'
      });
    }

    // Default working hours 9am-6pm if not provided
    const startTime = start_time || '09:00';
    const endTime = end_time || '18:00';

    // Create dates in UTC
    const startDateTime = new Date(`${date}T${startTime}:00Z`);
    const endDateTime = new Date(`${date}T${endTime}:00Z`);

    if (isNaN(startDateTime.getTime()) || isNaN(endDateTime.getTime())) {
      return res.status(400).json({
        success: false,
        error: 'Invalid date or time format'
      });
    }

    if (endDateTime <= startDateTime) {
      return res.status(400).json({
        success: false,
        error: 'end_time must be after start_time'
      });
    }

    const slots = [];
    let currentStart = new Date(startDateTime);
    const slotMinutes = process.env.INTERVIEW_TIME_SLOT;

    while (currentStart < endDateTime) {
      const currentEnd = new Date(currentStart.getTime() + slotMinutes * 60000);
      if (currentEnd > endDateTime) break;
      slots.push({
        start_time: toUTCString(currentStart),
        end_time: toUTCString(currentEnd)
      });
      currentStart = currentEnd;
    }

    if (slots.length === 0) {
      return res.status(400).json({
        success: false,
        error: `No ${slotMinutes}-minute slots could be generated for the given range`
      });
    }

    // Avoid creating duplicate slots for same time range
    const values = [];
    const placeholders = [];
    slots.forEach(slot => {
      placeholders.push('(?, ?, ?, ?)');
      values.push(req.user.id, slot.start_time, slot.end_time, 0);
    });

    await query(
      `INSERT IGNORE INTO interviewer_time_slots (interviewer_id, start_time, end_time, is_booked)
       VALUES ${placeholders.join(', ')}`,
      values
    );

    const startTimeUTC = toUTCString(startDateTime);
    const endTimeUTC = toUTCString(endDateTime);
    const createdSlots = await query(
      `SELECT * FROM interviewer_time_slots 
       WHERE interviewer_id = ? AND start_time >= ? AND end_time <= ?
       ORDER BY start_time ASC`,
      [req.user.id, startTimeUTC, endTimeUTC]
    );

    res.json({
      success: true,
      message: 'Time slots generated successfully',
      data: convertResultToUTC(createdSlots)
    });
  } catch (error) {
    console.error('Error generating time slots:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to generate time slots',
      message: error.message
    });
  }
});

// Create selected time slots (Interviewer only)
router.post('/slots/create-selected', authenticate, authorize('Interviewer'), async (req, res) => {
  try {
    const { slots } = req.body;

    if (!slots || !Array.isArray(slots) || slots.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'slots array is required and must not be empty'
      });
    }

    // Validate each slot
    for (const slot of slots) {
      if (!slot.start_time || !slot.end_time) {
        return res.status(400).json({
          success: false,
          error: 'Each slot must have start_time and end_time'
        });
      }

      // Convert to UTC strings for database storage
      const startDateTime = fromUTCString(slot.start_time);
      const endDateTime = fromUTCString(slot.end_time);

      if (isNaN(startDateTime.getTime()) || isNaN(endDateTime.getTime())) {
        return res.status(400).json({
          success: false,
          error: 'Invalid date or time format in slots'
        });
      }

      if (endDateTime <= startDateTime) {
        return res.status(400).json({
          success: false,
          error: 'end_time must be after start_time for each slot'
        });
      }
    }

    // Insert slots (using INSERT IGNORE to avoid duplicates) - convert to UTC
    const values = [];
    const placeholders = [];
    slots.forEach(slot => {
      placeholders.push('(?, ?, ?, ?)');
      values.push(req.user.id, toUTCString(slot.start_time), toUTCString(slot.end_time), 0);
    });

    await query(
      `INSERT IGNORE INTO interviewer_time_slots (interviewer_id, start_time, end_time, is_booked)
       VALUES ${placeholders.join(', ')}`,
      values
    );

    // Get the created slots (convert start times to UTC for query)
    const startTimes = slots.map(s => toUTCString(s.start_time));
    const placeholders2 = startTimes.map(() => '?').join(',');
    const createdSlots = await query(
      `SELECT * FROM interviewer_time_slots 
       WHERE interviewer_id = ? AND start_time IN (${placeholders2})
       ORDER BY start_time ASC`,
      [req.user.id, ...startTimes]
    );

    res.json({
      success: true,
      message: `${createdSlots.length} time slot(s) created successfully`,
      data: convertResultToUTC(createdSlots)
    });
  } catch (error) {
    console.error('Error creating selected time slots:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to create time slots',
      message: error.message
    });
  }
});

// Get current interviewer's time slots
router.get('/my-slots', authenticate, authorize('Interviewer'), async (req, res) => {
  try {
    const { from, to } = req.query;

    // let sql = `
    //   SELECT * FROM interviewer_time_slots
    //   WHERE interviewer_id = ?
    // `;

    let sql = `SELECT *
FROM interviewer_time_slots
WHERE interviewer_id = ?
  AND start_time >= UTC_TIMESTAMP()
`;
    const params = [req.user.id];

    if (from) {
      sql += ' AND start_time >= ?';
      params.push(toUTCString(from));
    }

    if (to) {
      sql += ' AND end_time <= ?';
      params.push(toUTCString(to));
    }

    sql += ' ORDER BY start_time ASC';

    const slots = await query(sql, params);

    res.json({
      success: true,
      count: slots.length,
      data: slots
    });
  } catch (error) {
    console.error('Error fetching time slots:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch time slots',
      message: error.message
    });
  }
});

// Delete an unbooked time slot (Interviewer only, cannot delete booked slots)
router.delete('/slots/:id', authenticate, authorize('Interviewer'), async (req, res) => {
  try {
    const { id } = req.params;

    const result = await query(
      `DELETE FROM interviewer_time_slots 
       WHERE id = ? AND interviewer_id COLLATE utf8mb4_unicode_ci = ? COLLATE utf8mb4_unicode_ci AND is_booked = 0`,
      [id, req.user.id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({
        success: false,
        error: 'Slot not found or already booked'
      });
    }

    res.json({
      success: true,
      message: 'Time slot deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting time slot:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to delete time slot',
      message: error.message
    });
  }
});

// Get available time slots for a job description (for HR scheduling UI)
router.get('/available-slots', authenticate, async (req, res) => {
  try {
    const { job_description_id, interviewer_id } = req.query;

    if (!job_description_id) {
      return res.status(400).json({
        success: false,
        error: 'job_description_id is required'
      });
    }

    const job = await queryOne(
      'SELECT id, title, interviewers FROM job_descriptions WHERE id = ?',
      [job_description_id]
    );

    if (!job) {
      return res.status(404).json({
        success: false,
        error: 'Job description not found'
      });
    }

    const mappedInterviewers = job.interviewers ? JSON.parse(job.interviewers) : [];

    const params = [];
    let sql = `
      SELECT 
        s.*,
        JSON_OBJECT(
          'id', u.id,
          'email', u.email,
          'full_name', u.full_name
        ) as interviewer
      FROM interviewer_time_slots s
      LEFT JOIN users u ON s.interviewer_id COLLATE utf8mb4_unicode_ci = u.id COLLATE utf8mb4_unicode_ci
      WHERE s.is_booked = 0
        AND s.start_time > UTC_TIMESTAMP()
        AND u.status = 'active'
    `;

    // If a specific interviewer_id is provided, use that
    // Otherwise, restrict to mapped interviewers if mapping exists
    if (interviewer_id) {
      sql += ' AND s.interviewer_id = ?';
      params.push(interviewer_id);
    } else if (mappedInterviewers && mappedInterviewers.length > 0) {
      const placeholders = mappedInterviewers.map(() => '?').join(',');
      sql += ` AND s.interviewer_id IN (${placeholders})`;
      params.push(...mappedInterviewers);
    }

    sql += `
      ORDER BY s.start_time ASC
    `;

    console.log('Available slots query:', sql);
    console.log('Available slots params:', params);
    
    const rows = await query(sql, params);
    
    console.log('Available slots found:', rows.length);

    const slots = rows.map(row => {
      const slot = {
        ...row,
        interviewer: row.interviewer ? JSON.parse(row.interviewer) : null
      };
      return convertResultToUTC(slot);
    });

    res.json({
      success: true,
      count: slots.length,
      data: slots
    });
  } catch (error) {
    console.error('Error fetching available slots:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch available slots',
      message: error.message
    });
  }
});


router.post('/available-slots/group', authenticate, async (req, res) => {
  try {
    const { job_description_id  } = req.query;
    const { mappedInterviewers = [] } = req.body
    // const interviwerId = ['5a082feb-b4ce-4f8b-97b4-97eac46f8b67' , '5c1dc2d2-4b7c-4d93-b542-56510a4cb9d2']
    if (!job_description_id) {
      return res.status(400).json({
        success: false,
        error: 'job_description_id is required'
      });
    }

    const job = await queryOne(
      'SELECT id, title, interviewers FROM job_descriptions WHERE id = ?',
      [job_description_id]
    );

    if (!job) {
      return res.status(404).json({
        success: false,
        error: 'Job description not found'
      });
    }

    // const mappedInterviewers = job.interviewers ? JSON.parse(job.interviewers) : [];
    // const mappedInterviewers = ['5a082feb-b4ce-4f8b-97b4-97eac46f8b67' , '5c1dc2d2-4b7c-4d93-b542-56510a4cb9d2']
    const interviewerCount = mappedInterviewers.length;
    // const placeholders = mappedInterviewers.map(() => '?').join(',');
    const params = [...mappedInterviewers    ,interviewerCount ];
   const placeholders = mappedInterviewers.map(() => '?').join(',');

  console.log(placeholders , "placeholders")
   
// let sql = `
//  select * from interviewer_time_slots
//   where interviewer_id IN (${placeholders})
//   and  start_time > UTC_TIMESTAMP()
//   and is_booked = 0
//   AND start_time IN (
//     SELECT start_time
//     FROM interviewer_time_slots
//     WHERE interviewer_id IN (
//       ${placeholders}
//     )
//     AND start_time > UTC_TIMESTAMP()
//     AND is_booked = 0
//     GROUP BY start_time
//     HAVING COUNT(DISTINCT interviewer_id) = ?
// )
// ORDER BY start_time;
// `;
   
let sql = `
SELECT
  start_time,
  end_time,

  -- collect all slot ids
  JSON_ARRAYAGG(id) AS slot_ids,

  -- collect interviewer ids if needed
  JSON_ARRAYAGG(interviewer_id) AS interviewer_ids,

  COUNT(*) AS total_slots
FROM interviewer_time_slots
WHERE interviewer_id IN (${placeholders})
AND start_time > UTC_TIMESTAMP()
AND is_booked = 0
GROUP BY start_time, end_time
HAVING COUNT(DISTINCT interviewer_id) = ?
ORDER BY start_time;

`
    console.log('Available slots query:', sql);
    console.log('Available slots params:', params);
    
    const rows = await query(sql, params);
    
    console.log('Available slots found:', rows.length);

    const slots = rows.map(row => {
      // Parse JSON arrays from JSON_ARRAYAGG
      let slotIds = [];
      let interviewerIds = [];
      
      try {
        slotIds = row.slot_ids ? (typeof row.slot_ids === 'string' ? JSON.parse(row.slot_ids) : row.slot_ids) : [];
        interviewerIds = row.interviewer_ids ? (typeof row.interviewer_ids === 'string' ? JSON.parse(row.interviewer_ids) : row.interviewer_ids) : [];
      } catch (e) {
        console.error('Error parsing slot_ids or interviewer_ids:', e);
      }

      const slot = {
        ...row,
        slot_ids: slotIds,
        interviewer_ids: interviewerIds
      };
      return convertResultToUTC(slot);
    });

    res.json({
      success: true,
      count: slots.length,
      data: slots
    });
  } catch (error) {
    console.error('Error fetching available slots:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch available slots',
      message: error.message
    });
  }
});


router.post('/assign/bulk', authenticate, requireWriteAccess, async (req, res) => {

    const { evaluation_id, interviewer_ids, interview_date, slot_ids } = req.body;

    // Validate input
    if (
      !evaluation_id ||
      !Array.isArray(interviewer_ids) ||
      !Array.isArray(slot_ids) ||
      interviewer_ids.length === 0 ||
      interviewer_ids.length !== slot_ids.length ||
      !interview_date
    ) {
      return res.status(400).json({
        success: false,
        error: 'Invalid payload: evaluation_id, interviewer_ids array, slot_ids array (same length), and interview_date are required'
      });
    }

      

    try {

          // Get evaluation with candidate and job details
    const evaluation = await queryOne(
      `SELECT ce.*, 
        r.name as candidate_name, r.email as candidate_email,
        jd.title as job_title
       FROM candidate_evaluations ce
       LEFT JOIN resumes r ON ce.resume_id = r.id
       LEFT JOIN job_descriptions jd ON ce.job_description_id = jd.id
       WHERE ce.id = ?`,
      [evaluation_id]
    );

    if (!evaluation) {
      return res.status(404).json({
        success: false,
        error: 'Evaluation not found'
      });
    }

    // Step 1: Cancel old assignments - Get all existing interview_details for this evaluation
    const oldInterviewDetails = await query(
      `SELECT id, interviewer_time_slots_id 
       FROM interview_details 
       WHERE candidate_evaluations_id = ?`,
      [evaluation_id]
    );

    // Step 2: Free old slots (set is_booked = 0, evaluation_id = NULL)
    if (oldInterviewDetails.length > 0) {
      const oldSlotIds = oldInterviewDetails.map(detail => detail.interviewer_time_slots_id).filter(Boolean);
      if (oldSlotIds.length > 0) {
        await query(
          `UPDATE interviewer_time_slots 
           SET is_booked = 0, evaluation_id = NULL 
           WHERE id IN (${oldSlotIds.map(() => '?').join(',')})`,
          oldSlotIds
        );
      }
    }

    // Step 3: Delete all existing interview_details for this evaluation
    await query(
      `DELETE FROM interview_details 
       WHERE candidate_evaluations_id = ?`,
      [evaluation_id]
    );

    // Convert interview date to UTC
    const interviewDateUTC = toUTCString(interview_date);

    // Generate interview link
    const interviewLink = await generateInterViewLink({
      topic: "INTERVIEW",
      start_time: interviewDateUTC,
      duration: process.env.INTERVIEW_TIME_SLOT,
    });

    // Update candidate_evaluations with interview links
    await query(
      `UPDATE candidate_evaluations 
       SET interview_start_url = ?, interview_join_url = ?
       WHERE id = ?`,
      [interviewLink.start_url, interviewLink.join_url, evaluation_id]
    );

    // Create assignment records and interview details
    const assignmentNote = oldInterviewDetails.length > 0 ? 'Bulk reassignment' : 'Bulk assignment';
    for (let i = 0; i < interviewer_ids.length; i++) {
      // Create interview_assignments record
      await query(
        `INSERT INTO interview_assignments (evaluation_id, interviewer_id, interview_date, assigned_by, notes)
         VALUES (?, ?, ?, ?, ?)`,
        [evaluation_id, interviewer_ids[i], interviewDateUTC, req.user.id, assignmentNote]
      );
  
      // Create interview_details record
      await query(
        `INSERT INTO interview_details (candidate_evaluations_id, interviewer_time_slots_id, interviewer_id, interviewer_status)
         VALUES (?, ?, ?, 'pending')`,
        [evaluation_id, slot_ids[i], interviewer_ids[i]]
      );

      // Mark slot as booked
      await query(
        `UPDATE interviewer_time_slots 
         SET is_booked = 1, evaluation_id = ?, job_description_id = ?
         WHERE id = ? AND is_booked = 0`,
        [evaluation_id, evaluation.job_description_id, slot_ids[i]]
      );
    }



    res.json({
      success: true,
      message: `Successfully assigned ${interviewer_ids.length} interviewer(s)`,
      interview_link: interviewLink
    });
  } catch (error) {
    console.error('Error in bulk assignment:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to assign interviewers',
      message: error.message
    });
  }
});

// get today'is interviews list for admin and hr 

router.get('/today-avaiable-interviews', authenticate, requireWriteAccess, async (req, res) => {
   

    try {
        const sql = `
  SELECT
    ev.id AS evaluation_id,
    ev.candidate_name,
    ev.interview_start_url,
    jd.title,
    MIN(its.start_time) AS start_time,
    MIN(its.end_time) AS end_time,
    GROUP_CONCAT(DISTINCT users.full_name ORDER BY users.full_name SEPARATOR ', ') AS interviewer_name
  FROM interview_details id
  INNER JOIN interviewer_time_slots its ON id.interviewer_time_slots_id = its.id
  INNER JOIN candidate_evaluations ev ON id.candidate_evaluations_id = ev.id
  INNER JOIN users ON id.interviewer_id COLLATE utf8mb4_unicode_ci = users.id COLLATE utf8mb4_unicode_ci
  INNER JOIN job_descriptions jd ON ev.job_description_id = jd.id
  WHERE DATE(its.start_time) = UTC_DATE()
    AND its.is_booked = 1
  GROUP BY ev.id, ev.candidate_name, ev.interview_start_url, jd.title
  ORDER BY start_time ASC;
`


// SELECT *
// FROM (
//   SELECT 
//     its.id            AS slot_id,
//     its.start_time,
//     its.end_time,
//     its.interviewer_id,
//     its.is_booked,

//     users.id          AS user_id,
//     users.full_name        AS interviewer_name,
//     users.email       AS interviewer_email,

//     ev.id             AS evaluation_id,
//     ev.status         AS evaluation_status,

//     jd.id             AS job_id,
//     jd.title          AS job_title,

//     ROW_NUMBER() OVER (
//       PARTITION BY its.interviewer_id, DATE(its.start_time)
//       ORDER BY its.start_time DESC
//     ) AS rn
//   FROM interviewer_time_slots its
//   INNER JOIN users
//     ON its.interviewer_id = users.id
//   INNER JOIN candidate_evaluations ev
//     ON its.evaluation_id = ev.id
//   INNER JOIN job_descriptions jd
//     ON ev.job_description_id = jd.id
//   WHERE DATE(its.start_time) = UTC_DATE()
//     AND its.is_booked = 1
// ) t
// WHERE t.rn = 1;
        const interviews = await query(sql);
        
        // Convert datetime fields to UTC
        const convertedInterviews = convertResultToUTC(interviews);

        if(convertedInterviews.length >  0)
        {
            return  res.status(200).json({
        success: true,
        count: convertedInterviews.length,
        data: convertedInterviews
      });
        }

          return res.status(200).json({
            success: false,
            count :0,
            data : [],
            message: 'No interviews scheduled for today'
          })
     
    } catch (error) {
           console.error('Error fetching available today interview:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch available today interviews',
      message: error.message
    });
    }

})

module.exports = router;

