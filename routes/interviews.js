const express = require('express');
const { query, queryOne } = require('../config/database');
const { authenticate, requireWriteAccess, authorize } = require('../middleware/auth');
const {
  sendInterviewAssignmentToInterviewer,
  sendInterviewAssignmentToCandidate,
  sendInterviewFeedbackToHR
} = require('../utils/emailService');

const router = express.Router();

// Assign interviewer to a candidate evaluation (HR/Admin only)
router.post('/assign', authenticate, requireWriteAccess, async (req, res) => {
  try {
    const { evaluation_id, interviewer_id, interview_date } = req.body;

    if (!evaluation_id || !interviewer_id || !interview_date) {
      return res.status(400).json({
        success: false,
        error: 'evaluation_id, interviewer_id, and interview_date are required'
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

    // Update evaluation with interviewer assignment
    await query(
      `UPDATE candidate_evaluations 
       SET interviewer_id = ?, interview_date = ?, interviewer_status = 'pending'
       WHERE id = ?`,
      [interviewer_id, interview_date, evaluation_id]
    );

    // Create assignment record
    await query(
      `INSERT INTO interview_assignments (evaluation_id, interviewer_id, interview_date, assigned_by, notes)
       VALUES (?, ?, ?, ?, ?)`,
      [evaluation_id, interviewer_id, interview_date, req.user.id, null]
    );

    // Send email notifications
    const candidateName = evaluation.candidate_name || evaluation.name || 'Candidate';
    const candidateEmail = evaluation.candidate_email || evaluation.email;
    const jobTitle = evaluation.job_title || 'Position';

    // Send to interviewer
    if (interviewer.email) {
      await sendInterviewAssignmentToInterviewer({
        interviewerEmail: interviewer.email,
        interviewerName: interviewer.full_name || interviewer.email,
        candidateName,
        candidateEmail,
        jobTitle,
        interviewDate: interview_date
      });
    }

    // Send to candidate
    if (candidateEmail) {
      await sendInterviewAssignmentToCandidate({
        candidateEmail,
        candidateName,
        jobTitle,
        interviewDate: interview_date,
        interviewerName: interviewer.full_name || interviewer.email
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

    res.json({
      success: true,
      message: 'Interviewer assigned successfully',
      data: parsedEvaluation
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
    const { interviewer_id, interview_date } = req.body;

    if (!interviewer_id || !interview_date) {
      return res.status(400).json({
        success: false,
        error: 'interviewer_id and interview_date are required'
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

    // Update evaluation
    await query(
      `UPDATE candidate_evaluations 
       SET interviewer_id = ?, interview_date = ?
       WHERE id = ?`,
      [interviewer_id, interview_date, evaluation_id]
    );

    // Create new assignment record
    await query(
      `INSERT INTO interview_assignments (evaluation_id, interviewer_id, interview_date, assigned_by, notes)
       VALUES (?, ?, ?, ?, ?)`,
      [evaluation_id, interviewer_id, interview_date, req.user.id, 'Reassigned']
    );

    // Send email notifications
    const candidateName = evaluation.candidate_name || evaluation.name || 'Candidate';
    const candidateEmail = evaluation.candidate_email || evaluation.email;
    const jobTitle = evaluation.job_title || 'Position';

    // Send to interviewer
    if (interviewer.email) {
      await sendInterviewAssignmentToInterviewer({
        interviewerEmail: interviewer.email,
        interviewerName: interviewer.full_name || interviewer.email,
        candidateName,
        candidateEmail,
        jobTitle,
        interviewDate: interview_date
      });
    }

    // Send to candidate
    if (candidateEmail) {
      await sendInterviewAssignmentToCandidate({
        candidateEmail,
        candidateName,
        jobTitle,
        interviewDate: interview_date,
        interviewerName: interviewer.full_name || interviewer.email
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

    res.json({
      success: true,
      message: 'Interview details updated successfully',
      data: parsedEvaluation
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

    // Parse JSON fields
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
      return parsed;
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

module.exports = router;

