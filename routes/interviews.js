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

    // Validate interviewer exists and is an Interviewer
    const interviewer = await queryOne(
      'SELECT id, email, role, full_name FROM users WHERE id = ? AND role = ?',
      [interviewer_id, 'Interviewer']
    );

    if (!interviewer) {
      return res.status(400).json({
        success: false,
        error: 'Invalid interviewer ID or user is not an Interviewer'
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

    // Update evaluation with interviewer assignment (convert to UTC)
    const interviewDateUTC = toUTCString(finalInterviewDate);
    await query(
      `UPDATE candidate_evaluations 
       SET interviewer_id = ?, interview_date = ?, interviewer_status = 'pending'
       WHERE id = ?`,
      [interviewer_id, interviewDateUTC, evaluation_id]
    );

    // Create assignment record (convert to UTC)
    await query(
      `INSERT INTO interview_assignments (evaluation_id, interviewer_id, interview_date, assigned_by, notes)
       VALUES (?, ?, ?, ?, ?)`,
      [evaluation_id, interviewer_id, interviewDateUTC, req.user.id, null]
    );

    // Send email notifications
    const candidateName = evaluation.candidate_name || evaluation.name || 'Candidate';
    const candidateEmail = evaluation.candidate_email || evaluation.email;
    const jobTitle = evaluation.job_title || 'Position';

          let interviewLink  = await generateInterViewLink({
    topic: "INTERVIEW",
    start_time: interviewDateUTC,
    duration: process.env.INTERVIEW_TIME_SLOT,
});

 // Send to interviewer
    if (interviewer.email) {
      await sendInterviewAssignmentToInterviewer({
        // interviewerEmail: interviewer.email,
        interviewerEmail : 'jaxmorgan001@gmail.com',
        interviewerName: interviewer.full_name || interviewer.email,
        candidateName,
        candidateEmail,
        jobTitle,
        interviewDate: fromUTCString(interviewDateUTC).toLocaleString('en-US'),
        interViewLink : interviewLink.start_url
      });
    }

    // Send to candidate
    if (candidateEmail) {
      await sendInterviewAssignmentToCandidate({
        candidateEmail : 'jaidnasim1@gmail.com',
        candidateName,
        jobTitle,
        interviewDate: fromUTCString(interviewDateUTC).toLocaleString('en-US'),
        interviewerName: interviewer.full_name || interviewer.email,
         interviewLink : interviewLink.join_url
      });
    }


    // Get updated evaluation
    const updatedEvaluation = await queryOne(
      `SELECT ce.*,
        JSON_OBJECT(
          'id', u.id,
          'email', u.email,
          'full_name', u.full_name
        ) as interviewer
       FROM candidate_evaluations ce
       LEFT JOIN users u ON ce.interviewer_id = u.id
       WHERE ce.id = ?`,
      [evaluation_id]
    );

    const parsedEvaluation = {
      ...updatedEvaluation,
      interviewer: updatedEvaluation.interviewer ? JSON.parse(updatedEvaluation.interviewer) : null
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

    // Validate interviewer exists and is an Interviewer
    const interviewer = await queryOne(
      'SELECT id, email, role, full_name FROM users WHERE id = ? AND role = ?',
      [interviewer_id, 'Interviewer']
    );

    if (!interviewer) {
      return res.status(400).json({
        success: false,
        error: 'Invalid interviewer ID or user is not an Interviewer'
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

    // Update evaluation (convert to UTC)
    const interviewDateUTC = toUTCString(finalInterviewDate);
    await query(
      `UPDATE candidate_evaluations 
       SET interviewer_id = ?, interview_date = ?
       WHERE id = ?`,
      [interviewer_id, interviewDateUTC, evaluation_id]
    );

    // Create new assignment record (convert to UTC)
    await query(
      `INSERT INTO interview_assignments (evaluation_id, interviewer_id, interview_date, assigned_by, notes)
       VALUES (?, ?, ?, ?, ?)`,
      [evaluation_id, interviewer_id, interviewDateUTC, req.user.id, 'Reassigned']
    );

    // Send email notifications
    const candidateName = evaluation.candidate_name || evaluation.name || 'Candidate';
    const candidateEmail = evaluation.candidate_email || evaluation.email;
    const jobTitle = evaluation.job_title || 'Position';

  
    
      let interviewLink  = await generateInterViewLink({
    topic: "INTERVIEW",
    start_time: interviewDateUTC,
    duration: process.env.INTERVIEW_TIME_SLOT,
});

    // Send to interviewer
    if (interviewer.email) {
      await sendInterviewAssignmentToInterviewer({
        // interviewerEmail: interviewer.email,
        interviewerEmail : 'jaxmorgan001@gmail.com',
        interviewerName: interviewer.full_name || interviewer.email,
        candidateName,
        candidateEmail,
        jobTitle,
        interviewDate: fromUTCString(interviewDateUTC).toLocaleString('en-US'),
        interViewLink : interviewLink.start_url
      });
    }

    // Send to candidate
    if (candidateEmail) {
      await sendInterviewAssignmentToCandidate({
        candidateEmail : 'jaidnasim1@gmail.com',
        candidateName,
        jobTitle,
        interviewDate: fromUTCString(interviewDateUTC).toLocaleString('en-US'),
        interviewerName: interviewer.full_name || interviewer.email,
         interviewLink : interviewLink.join_url
      });
    }

    // Get updated evaluation
    const updatedEvaluation = await queryOne(
      `SELECT ce.*,
        JSON_OBJECT(
          'id', u.id,
          'email', u.email,
          'full_name', u.full_name
        ) as interviewer
       FROM candidate_evaluations ce
       LEFT JOIN users u ON ce.interviewer_id = u.id
       WHERE ce.id = ?`,
      [evaluation_id]
    );

    const parsedEvaluation = {
      ...updatedEvaluation,
      interviewer: updatedEvaluation.interviewer ? JSON.parse(updatedEvaluation.interviewer) : null
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

// Get interviewer's assigned candidates (Interviewer only)
router.get('/my-assignments', authenticate, authorize('Interviewer'), async (req, res) => {
  try {
    const { status } = req.query;

    let sql = `
      SELECT 
        ce.*,
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
      LEFT JOIN resumes r ON ce.resume_id = r.id
      LEFT JOIN job_descriptions jd ON ce.job_description_id = jd.id
      WHERE ce.interviewer_id = ?
    `;
    const params = [req.user.id];

    if (status) {
      sql += ' AND ce.interviewer_status = ?';
      params.push(status);
    }

    sql += ' ORDER BY ce.interview_date ASC, ce.created_at DESC';

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
       WHERE id = ? AND interviewer_id = ? AND is_booked = 0`,
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
      LEFT JOIN users u ON s.interviewer_id = u.id
      WHERE s.is_booked = 0
        AND s.start_time > UTC_TIMESTAMP()
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

// get today'is interviews list for admin and hr 

router.get('/today-avaiable-interviews', authenticate, requireWriteAccess, async (req, res) => {
   

    try {
        const sql = ` select  its.start_time , its.end_time ,users.full_name as interviewer_name,jd.title,ev.candidate_name 
 from interviewer_time_slots its
 inner join users
     on its.interviewer_id = users.id 
 inner join candidate_evaluations ev 
   on its.evaluation_id = ev.id
inner join job_descriptions jd
    on ev.job_description_id = jd.id 
 where Date(its.start_time) = utc_date() AND is_booked =1 

`
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

