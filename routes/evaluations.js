const express = require('express');
const { query, queryOne } = require('../config/database');
const { authenticate, requireWriteAccess, authorize } = require('../middleware/auth');
const { sendInterviewFeedbackToHR } = require('../utils/emailService');

const router = express.Router();

// Helper function to safely parse JSON fields
const safeParseJSON = (value, defaultValue = null) => {
  if (value === null || value === undefined) {
    return defaultValue;
  }
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch (e) {
      console.error('Error parsing JSON:', e, 'Value:', value);
      return defaultValue;
    }
  }
  // Already an object/array
  return value;
};

// Get all evaluations (all authenticated users can view, with visibility rules)
router.get('/', authenticate, async (req, res) => {
  try {
    const { job_description_id, resume_id, status } = req.query;

    let sql = `
      SELECT 
        ce.*,
        JSON_OBJECT(
          'id', r.id,
          'name', r.name,
          'email', r.email,
          'phone', r.phone,
          'file_name', r.file_name
        ) as resume,
        JSON_OBJECT(
          'id', jd.id,
          'title', jd.title,
          'description', jd.description
        ) as job_description,
        JSON_OBJECT(
          'id', u.id,
          'email', u.email,
          'full_name', u.full_name
        ) as interviewer
      FROM candidate_evaluations ce
      LEFT JOIN resumes r ON ce.resume_id = r.id
      LEFT JOIN job_descriptions jd ON ce.job_description_id = jd.id
      LEFT JOIN users u ON ce.interviewer_id = u.id
      WHERE 1=1
    `;
    const params = [];

    // Visibility rules: Interviewers can only see their assigned candidates
    if (req.user.role === 'Interviewer') {
      sql += ' AND ce.interviewer_id = ?';
      params.push(req.user.id);
    }

    if (job_description_id) {
      sql += ' AND ce.job_description_id = ?';
      params.push(job_description_id);
    }

    if (resume_id) {
      sql += ' AND ce.resume_id = ?';
      params.push(resume_id);
    }

    if (status) {
      sql += ' AND (ce.status = ? OR ce.interviewer_status = ? OR ce.hr_final_status = ?)';
      params.push(status, status, status);
    }

    sql += ' ORDER BY ce.created_at DESC';

    const evaluations = await query(sql, params);

    // Parse JSON fields safely
    const parsedEvaluations = evaluations.map(eval => {
      const parsed = {
        ...eval,
        resume: safeParseJSON(eval.resume, null),
        job_description: safeParseJSON(eval.job_description, null),
        interviewer: safeParseJSON(eval.interviewer, null),
        interviewer_feedback: safeParseJSON(eval.interviewer_feedback, null)
      };
      // Parse nested JSON in resume if it exists
      if (parsed.resume) {
        parsed.resume.skills = safeParseJSON(parsed.resume.skills, []);
        parsed.resume.experience = safeParseJSON(parsed.resume.experience, []);
        parsed.resume.education = safeParseJSON(parsed.resume.education, []);
      }
      return parsed;
    });

    res.json({
      success: true,
      count: parsedEvaluations.length,
      data: parsedEvaluations
    });
  } catch (error) {
    console.error('Error fetching evaluations:', error);
    res.status(500).json({
      error: 'Failed to fetch evaluations',
      message: error.message
    });
  }
});

// Get evaluation by ID (all authenticated users can view)
router.get('/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    console.log(`📋 Fetching evaluation ID: ${id} for user: ${req.user.email}`);

    const evaluation = await queryOne(
      `SELECT 
        ce.*,
        JSON_OBJECT(
          'id', r.id,
          'name', r.name,
          'email', r.email,
          'phone', r.phone,
          'file_name', r.file_name,
          'skills', r.skills,
          'experience', r.experience,
          'education', r.education
        ) as resume,
        JSON_OBJECT(
          'id', jd.id,
          'title', jd.title,
          'description', jd.description,
          'requirements', jd.requirements
        ) as job_description
      FROM candidate_evaluations ce
      LEFT JOIN resumes r ON ce.resume_id = r.id
      LEFT JOIN job_descriptions jd ON ce.job_description_id = jd.id
      WHERE ce.id = ?`,
      [id]
    );

    if (!evaluation) {
      return res.status(404).json({ error: 'Evaluation not found' });
    }

    // Visibility check: Interviewers can only see their assigned candidates
    if (req.user.role === 'Interviewer' && evaluation.interviewer_id !== req.user.id) {
      return res.status(403).json({
        success: false,
        error: 'Access denied. This candidate is not assigned to you.'
      });
    }

    // Parse JSON fields
    const parsedEvaluation = {
      ...evaluation,
      resume: safeParseJSON(evaluation.resume, null),
      job_description: safeParseJSON(evaluation.job_description, null),
      interviewer_feedback: safeParseJSON(evaluation.interviewer_feedback, null)
    };

    // Parse nested JSON in resume
    if (parsedEvaluation.resume) {
      parsedEvaluation.resume.skills = safeParseJSON(parsedEvaluation.resume.skills, []);
      parsedEvaluation.resume.experience = safeParseJSON(parsedEvaluation.resume.experience, []);
      parsedEvaluation.resume.education = safeParseJSON(parsedEvaluation.resume.education, []);
    }
    
    console.log('Fetched evaluation:', {
      id: parsedEvaluation.id,
      resume_id: parsedEvaluation.resume_id,
      has_resume: !!parsedEvaluation.resume,
      has_job_description: !!parsedEvaluation.job_description
    });

    res.json({
      success: true,
      data: parsedEvaluation
    });
  } catch (error) {
    console.error('Error fetching evaluation:', error);
    res.status(500).json({
      error: 'Failed to fetch evaluation',
      message: error.message
    });
  }
});

// Update evaluation status (only HR and Admin can update)
router.patch('/:id/status', authenticate, requireWriteAccess, async (req, res) => {
  try {
    const { id } = req.params;
    const { status, rejection_reason } = req.body;

    const validStatuses = ['accepted', 'pending', 'rejected'];
    if (!status || !validStatuses.includes(status)) {
      return res.status(400).json({
        error: 'Valid status is required (accepted, pending, or rejected)'
      });
    }

    let sql = 'UPDATE candidate_evaluations SET status = ?';
    const params = [status];

    if (status === 'rejected' && rejection_reason) {
      sql += ', rejection_reason = ?';
      params.push(rejection_reason.trim());
    } else if (status !== 'rejected') {
      sql += ', rejection_reason = NULL';
    }

    sql += ' WHERE id = ?';
    params.push(id);

    const result = await query(sql, params);

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Evaluation not found' });
    }

    const updatedEvaluation = await queryOne(
      'SELECT * FROM candidate_evaluations WHERE id = ?',
      [id]
    );

    res.json({
      success: true,
      message: 'Evaluation status updated successfully',
      data: updatedEvaluation
    });
  } catch (error) {
    console.error('Error updating evaluation status:', error);
    res.status(500).json({
      error: 'Failed to update evaluation status',
      message: error.message
    });
  }
});

// Submit interviewer feedback (Interviewer only)
router.post('/:id/interviewer-feedback', authenticate, authorize('Interviewer'), async (req, res) => {
  try {
    const { id } = req.params;
    const { ratings, status, hold_reason } = req.body;

    // Validate that this evaluation is assigned to the current interviewer
    const evaluation = await queryOne(
      'SELECT * FROM candidate_evaluations WHERE id = ? AND interviewer_id = ?',
      [id, req.user.id]
    );

    if (!evaluation) {
      return res.status(404).json({
        success: false,
        error: 'Evaluation not found or not assigned to you'
      });
    }

    // Validate status
    const validStatuses = ['selected', 'rejected', 'on_hold'];
    if (!status || !validStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        error: 'Valid status is required (selected, rejected, or on_hold)'
      });
    }

    // Validate hold_reason if status is on_hold
    if (status === 'on_hold' && (!hold_reason || !hold_reason.trim())) {
      return res.status(400).json({
        success: false,
        error: 'hold_reason is required when status is on_hold'
      });
    }

    // Validate ratings (should be an object with numeric values 1-10)
    let feedbackJson = null;
    if (ratings) {
      if (typeof ratings !== 'object') {
        return res.status(400).json({
          success: false,
          error: 'ratings must be an object'
        });
      }
      // Validate each rating is between 1 and 10
      for (const [key, value] of Object.entries(ratings)) {
        const numValue = Number(value);
        if (isNaN(numValue) || numValue < 1 || numValue > 10) {
          return res.status(400).json({
            success: false,
            error: `Rating "${key}" must be a number between 1 and 10`
          });
        }
      }
      feedbackJson = JSON.stringify(ratings);
    }

    // Update evaluation with feedback
    let sql = `UPDATE candidate_evaluations 
               SET interviewer_feedback = ?, interviewer_status = ?`;
    const params = [feedbackJson, status];

    if (status === 'on_hold') {
      sql += ', interviewer_hold_reason = ?';
      params.push(hold_reason.trim());
    } else {
      sql += ', interviewer_hold_reason = NULL';
    }

    sql += ' WHERE id = ?';
    params.push(id);

    await query(sql, params);

    // Get updated evaluation with candidate and job details
    const updatedEvaluation = await queryOne(
      `SELECT ce.*,
        r.name as candidate_name, r.email as candidate_email,
        jd.title as job_title
       FROM candidate_evaluations ce
       LEFT JOIN resumes r ON ce.resume_id = r.id
       LEFT JOIN job_descriptions jd ON ce.job_description_id = jd.id
       WHERE ce.id = ?`,
      [id]
    );

    // Get HR and Admin emails
    const hrAdminUsers = await query(
      "SELECT email FROM users WHERE role IN ('HR', 'Admin')"
    );
    const hrAdminEmails = hrAdminUsers.map(u => u.email);

    // Send email notification to HR/Admin
    if (hrAdminEmails.length > 0) {
      await sendInterviewFeedbackToHR({
        hrAdminEmails,
        candidateName: updatedEvaluation.candidate_name || updatedEvaluation.name || 'Candidate',
        jobTitle: updatedEvaluation.job_title || 'Position',
        interviewerName: req.user.full_name || req.user.email,
        status
      });
    }

    // Parse JSON fields
    const parsedEvaluation = {
      ...updatedEvaluation,
      interviewer_feedback: updatedEvaluation.interviewer_feedback 
        ? JSON.parse(updatedEvaluation.interviewer_feedback) 
        : null
    };

    res.json({
      success: true,
      message: 'Interview feedback submitted successfully',
      data: parsedEvaluation
    });
  } catch (error) {
    console.error('Error submitting interviewer feedback:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to submit feedback',
      message: error.message
    });
  }
});

// HR/Admin final decision (HR/Admin only)
router.post('/:id/hr-decision', authenticate, requireWriteAccess, async (req, res) => {
  try {
    const { id } = req.params;
    const { status, reason } = req.body;

    // Validate status
    const validStatuses = ['selected', 'rejected', 'on_hold'];
    if (!status || !validStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        error: 'Valid status is required (selected, rejected, or on_hold)'
      });
    }

    // Get evaluation first
    const evaluation = await queryOne(
      'SELECT * FROM candidate_evaluations WHERE id = ?',
      [id]
    );

    if (!evaluation) {
      return res.status(404).json({
        success: false,
        error: 'Evaluation not found'
      });
    }

    // Get interviewer status to check if override is happening
    const interviewerStatus = evaluation.interviewer_status;

    // Validate reason:
    // 1. Required for rejected or on_hold
    // 2. Required for selected if interviewer didn't select (override case)
    const requiresReason = 
      status === 'rejected' || 
      status === 'on_hold' ||
      (status === 'selected' && interviewerStatus && interviewerStatus !== 'selected');

    if (requiresReason && (!reason || !reason.trim())) {
      if (status === 'selected') {
        return res.status(400).json({
          success: false,
          error: 'reason is required when selecting a candidate that the interviewer did not select (overriding decision)'
        });
      } else {
        return res.status(400).json({
          success: false,
          error: 'reason is required when status is rejected or on_hold'
        });
      }
    }

    // Update evaluation with HR final decision
    let sql = `UPDATE candidate_evaluations SET hr_final_status = ?`;
    const params = [status];

    // Store reason if provided (required for rejected, on_hold, or selected when overriding)
    if (reason && reason.trim()) {
      sql += ', hr_final_reason = ?';
      params.push(reason.trim());
    } else {
      sql += ', hr_final_reason = NULL';
    }

    sql += ' WHERE id = ?';
    params.push(id);

    await query(sql, params);

    // Get updated evaluation
    const updatedEvaluation = await queryOne(
      `SELECT ce.*,
        JSON_OBJECT(
          'id', r.id,
          'name', r.name,
          'email', r.email
        ) as resume,
        JSON_OBJECT(
          'id', jd.id,
          'title', jd.title
        ) as job_description
       FROM candidate_evaluations ce
       LEFT JOIN resumes r ON ce.resume_id = r.id
       LEFT JOIN job_descriptions jd ON ce.job_description_id = jd.id
       WHERE ce.id = ?`,
      [id]
    );

    // Parse JSON fields
    const parsedEvaluation = {
      ...updatedEvaluation,
      resume: updatedEvaluation.resume ? JSON.parse(updatedEvaluation.resume) : null,
      job_description: updatedEvaluation.job_description ? JSON.parse(updatedEvaluation.job_description) : null,
      interviewer_feedback: updatedEvaluation.interviewer_feedback 
        ? JSON.parse(updatedEvaluation.interviewer_feedback) 
        : null
    };

    res.json({
      success: true,
      message: 'Final decision updated successfully',
      data: parsedEvaluation
    });
  } catch (error) {
    console.error('Error updating HR final decision:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update final decision',
      message: error.message
    });
  }
});

// Get evaluations by job description ID (all authenticated users can view, with visibility rules)
router.get('/job/:job_description_id', authenticate, async (req, res) => {
  try {
    const { job_description_id } = req.params;
    const { status, sort_by } = req.query;

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
          'id', u.id,
          'email', u.email,
          'full_name', u.full_name
        ) as interviewer
      FROM candidate_evaluations ce
      LEFT JOIN resumes r ON ce.resume_id = r.id
      LEFT JOIN users u ON ce.interviewer_id = u.id
      WHERE ce.job_description_id = ?
    `;
    const params = [job_description_id];

    // Visibility rules: Interviewers can only see their assigned candidates
    if (req.user.role === 'Interviewer') {
      sql += ' AND ce.interviewer_id = ?';
      params.push(req.user.id);
    }

    // Status filtering - check all status fields
    if (status) {
      if (status === 'selected') {
        sql += ' AND (ce.interviewer_status = ? OR ce.hr_final_status = ?)';
        params.push('selected', 'selected');
      } else if (status === 'rejected') {
        sql += ' AND (ce.interviewer_status = ? OR ce.hr_final_status = ?)';
        params.push('rejected', 'rejected');
      } else if (status === 'on_hold') {
        sql += ' AND (ce.interviewer_status = ? OR ce.hr_final_status = ?)';
        params.push('on_hold', 'on_hold');
      } else {
        sql += ' AND (ce.status = ? OR ce.interviewer_status = ? OR ce.hr_final_status = ?)';
        params.push(status, status, status);
      }
    }

    // Sort by overall_match by default, or by created_at
    if (sort_by === 'date') {
      sql += ' ORDER BY ce.created_at DESC';
    } else {
      sql += ' ORDER BY ce.overall_match DESC';
    }

    const evaluations = await query(sql, params);

    // Parse JSON fields safely
    const parsedEvaluations = evaluations.map(eval => {
      const parsed = {
        ...eval,
        resume: safeParseJSON(eval.resume, null),
        interviewer: safeParseJSON(eval.interviewer, null),
        interviewer_feedback: safeParseJSON(eval.interviewer_feedback, null)
      };
      // Parse nested JSON in resume if it exists
      if (parsed.resume) {
        parsed.resume.skills = safeParseJSON(parsed.resume.skills, []);
        parsed.resume.experience = safeParseJSON(parsed.resume.experience, []);
        parsed.resume.education = safeParseJSON(parsed.resume.education, []);
      }
      return parsed;
    });

    // Detect and mark duplicates
    // Group by email (if available) or by name
    const duplicateGroups = new Map();
    const seenKeys = new Set();

    // First pass: group evaluations by email/name
    for (const eval of parsedEvaluations) {
      // Create a unique key for grouping duplicates
      // Use email if available, otherwise use name
      const email = eval.email?.toLowerCase().trim() || eval.resume?.email?.toLowerCase().trim();
      const name = eval.candidate_name?.toLowerCase().trim() || eval.resume?.name?.toLowerCase().trim();
      
      let groupKey = null;
      if (email) {
        groupKey = `email:${email}`;
      } else if (name) {
        groupKey = `name:${name}`;
      }

      if (groupKey) {
        if (!duplicateGroups.has(groupKey)) {
          duplicateGroups.set(groupKey, []);
        }
        duplicateGroups.get(groupKey).push(eval);
      }
    }

    // Second pass: process evaluations in original order, mark duplicates
    const processedEvaluations = [];
    const processedIds = new Set();
    
    for (const eval of parsedEvaluations) {
      const email = eval.email?.toLowerCase().trim() || eval.resume?.email?.toLowerCase().trim();
      const name = eval.candidate_name?.toLowerCase().trim() || eval.resume?.name?.toLowerCase().trim();
      
      let groupKey = null;
      if (email) {
        groupKey = `email:${email}`;
      } else if (name) {
        groupKey = `name:${name}`;
      }

      if (groupKey) {
        const group = duplicateGroups.get(groupKey);
        if (group && group.length > 1) {
          // Check if this is the first occurrence in the group (maintains sort order)
          const firstInGroup = group[0];
          if (firstInGroup.id === eval.id && !processedIds.has(eval.id)) {
            // First occurrence - mark as duplicate
            processedEvaluations.push({
              ...eval,
              isDuplicate: true,
              duplicateCount: group.length - 1
            });
            processedIds.add(eval.id);
          }
          // Skip other occurrences (duplicates) - they're already handled
        } else {
          // Only one in group - not a duplicate
          if (!processedIds.has(eval.id)) {
            processedEvaluations.push({
              ...eval,
              isDuplicate: false,
              duplicateCount: 0
            });
            processedIds.add(eval.id);
          }
        }
      } else {
        // No email or name, treat as unique
        if (!processedIds.has(eval.id)) {
          processedEvaluations.push({
            ...eval,
            isDuplicate: false,
            duplicateCount: 0
          });
          processedIds.add(eval.id);
        }
      }
    }

    res.json({
      success: true,
      count: processedEvaluations.length,
      data: processedEvaluations
    });
  } catch (error) {
    console.error('Error fetching evaluations by job description:', error);
    res.status(500).json({
      error: 'Failed to fetch evaluations',
      message: error.message
    });
  }
});

// Get candidate process timeline (all authenticated users can view)
router.get('/:id/timeline', authenticate, async (req, res) => {
  try {
    const { id } = req.params;

    // Get evaluation
    const evaluation = await queryOne(
      'SELECT * FROM candidate_evaluations WHERE id = ?',
      [id]
    );

    if (!evaluation) {
      return res.status(404).json({
        success: false,
        error: 'Evaluation not found'
      });
    }

    // Visibility check: Interviewers can only see their assigned candidates
    if (req.user.role === 'Interviewer' && evaluation.interviewer_id !== req.user.id) {
      return res.status(403).json({
        success: false,
        error: 'Access denied. This candidate is not assigned to you.'
      });
    }

    const timeline = [];

    // 1. Resume uploaded / Evaluation created
    timeline.push({
      type: 'resume_uploaded',
      title: 'Resume Uploaded',
      description: 'Candidate resume was uploaded and evaluated',
      timestamp: evaluation.created_at,
      user: null,
      details: {
        overall_match: evaluation.overall_match,
        skills_match: evaluation.skills_match,
        experience_match: evaluation.experience_match,
        education_match: evaluation.education_match
      }
    });

    // 2. Get interview assignment history
    const assignments = await query(
      `SELECT ia.*,
        JSON_OBJECT(
          'id', u1.id,
          'email', u1.email,
          'full_name', u1.full_name
        ) as interviewer,
        JSON_OBJECT(
          'id', u2.id,
          'email', u2.email,
          'full_name', u2.full_name
        ) as assigned_by_user
       FROM interview_assignments ia
       LEFT JOIN users u1 ON ia.interviewer_id = u1.id
       LEFT JOIN users u2 ON ia.assigned_by = u2.id
       WHERE ia.evaluation_id = ?
       ORDER BY ia.created_at ASC`,
      [id]
    );

    assignments.forEach(assignment => {
      const interviewer = assignment.interviewer ? JSON.parse(assignment.interviewer) : null;
      const assignedBy = assignment.assigned_by_user ? JSON.parse(assignment.assigned_by_user) : null;
      
      timeline.push({
        type: assignment.notes === 'Reassigned' ? 'interviewer_reassigned' : 'interviewer_assigned',
        title: assignment.notes === 'Reassigned' ? 'Interviewer Reassigned' : 'Interviewer Assigned',
        description: assignment.notes === 'Reassigned' 
          ? `Interview reassigned to ${interviewer?.full_name || interviewer?.email || 'Interviewer'}`
          : `Assigned to ${interviewer?.full_name || interviewer?.email || 'Interviewer'}`,
        timestamp: assignment.created_at,
        user: assignedBy,
        details: {
          interviewer: interviewer,
          interview_date: assignment.interview_date,
          notes: assignment.notes
        }
      });

      // Interview scheduled event
      timeline.push({
        type: 'interview_scheduled',
        title: 'Interview Scheduled',
        description: `Interview scheduled for ${new Date(assignment.interview_date).toLocaleString('en-US', {
          year: 'numeric',
          month: 'long',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit'
        })}`,
        timestamp: assignment.interview_date,
        user: null,
        details: {
          interviewer: interviewer,
          interview_date: assignment.interview_date
        }
      });
    });

    // 3. Interviewer feedback submitted
    if (evaluation.interviewer_status && evaluation.interviewer_status !== 'pending') {
      const interviewer = await queryOne(
        'SELECT id, email, full_name FROM users WHERE id = ?',
        [evaluation.interviewer_id]
      );

      const feedback = evaluation.interviewer_feedback ? JSON.parse(evaluation.interviewer_feedback) : null;

      timeline.push({
        type: 'feedback_submitted',
        title: 'Interview Feedback Submitted',
        description: `Interviewer decision: ${evaluation.interviewer_status}`,
        timestamp: evaluation.updated_at,
        user: interviewer,
        details: {
          status: evaluation.interviewer_status,
          ratings: feedback,
          hold_reason: evaluation.interviewer_hold_reason
        }
      });
    }

    // 4. HR final decision
    if (evaluation.hr_final_status && evaluation.hr_final_status !== 'pending') {
      // Get who made the decision (we'll use updated_at to determine, but ideally we'd track this)
      timeline.push({
        type: 'hr_decision',
        title: 'HR Final Decision',
        description: `Final decision: ${evaluation.hr_final_status}`,
        timestamp: evaluation.updated_at,
        user: null, // Could be enhanced to track who made the decision
        details: {
          status: evaluation.hr_final_status,
          reason: evaluation.hr_final_reason
        }
      });
    }

    // Sort timeline by timestamp
    timeline.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

    res.json({
      success: true,
      data: timeline
    });
  } catch (error) {
    console.error('Error fetching timeline:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch timeline',
      message: error.message
    });
  }
});

module.exports = router;
