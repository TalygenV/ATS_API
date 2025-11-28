const express = require('express');
const { query, queryOne } = require('../config/database');
const { authenticate, requireWriteAccess } = require('../middleware/auth');

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

// Get all evaluations (all authenticated users can view)
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
        ) as job_description
      FROM candidate_evaluations ce
      LEFT JOIN resumes r ON ce.resume_id = r.id
      LEFT JOIN job_descriptions jd ON ce.job_description_id = jd.id
      WHERE 1=1
    `;
    const params = [];

    if (job_description_id) {
      sql += ' AND ce.job_description_id = ?';
      params.push(job_description_id);
    }

    if (resume_id) {
      sql += ' AND ce.resume_id = ?';
      params.push(resume_id);
    }

    if (status) {
      sql += ' AND ce.status = ?';
      params.push(status);
    }

    sql += ' ORDER BY ce.created_at DESC';

    const evaluations = await query(sql, params);

    // Parse JSON fields safely
    const parsedEvaluations = evaluations.map(eval => ({
      ...eval,
      resume: safeParseJSON(eval.resume, null),
      job_description: safeParseJSON(eval.job_description, null)
    }));

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

    // Parse JSON fields
    const parsedEvaluation = {
      ...evaluation,
      resume: safeParseJSON(evaluation.resume, null),
      job_description: safeParseJSON(evaluation.job_description, null)
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

// Get evaluations by job description ID (all authenticated users can view)
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
        ) as resume
      FROM candidate_evaluations ce
      LEFT JOIN resumes r ON ce.resume_id = r.id
      WHERE ce.job_description_id = ?
    `;
    const params = [job_description_id];

    if (status) {
      sql += ' AND ce.status = ?';
      params.push(status);
    }

    // Sort by overall_match by default, or by created_at
    if (sort_by === 'date') {
      sql += ' ORDER BY ce.created_at DESC';
    } else {
      sql += ' ORDER BY ce.overall_match DESC';
    }

    const evaluations = await query(sql, params);

    // Parse JSON fields safely
    const parsedEvaluations = evaluations.map(eval => ({
      ...eval,
      resume: safeParseJSON(eval.resume, null)
    }));

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

module.exports = router;
