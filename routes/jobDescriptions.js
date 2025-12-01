const express = require('express');
const { query, queryOne } = require('../config/database');
const { authenticate, requireWriteAccess } = require('../middleware/auth');

const router = express.Router();

// Get all job descriptions (all authenticated users can view)
router.get('/', authenticate, async (req, res) => {
  try {
    const jobDescriptions = await query(
      'SELECT * FROM job_descriptions ORDER BY created_at DESC'
    );

    // Parse JSON fields
    const parsedJobDescriptions = jobDescriptions.map(jd => ({
      ...jd,
      interviewers: jd.interviewers ? JSON.parse(jd.interviewers) : []
    }));

    res.json({
      success: true,
      count: parsedJobDescriptions.length,
      data: parsedJobDescriptions
    });
  } catch (error) {
    console.error('Error fetching job descriptions:', error);
    res.status(500).json({
      error: 'Failed to fetch job descriptions',
      message: error.message
    });
  }
});

// Get job description by ID (all authenticated users can view)
router.get('/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;

    const jobDescription = await queryOne(
      'SELECT * FROM job_descriptions WHERE id = ?',
      [id]
    );

    if (!jobDescription) {
      return res.status(404).json({ error: 'Job description not found' });
    }

    // Parse JSON fields
    const parsedJobDescription = {
      ...jobDescription,
      interviewers: jobDescription.interviewers ? JSON.parse(jobDescription.interviewers) : []
    };

    res.json({
      success: true,
      data: parsedJobDescription
    });
  } catch (error) {
    console.error('Error fetching job description:', error);
    res.status(500).json({
      error: 'Failed to fetch job description',
      message: error.message
    });
  }
});

// Create new job description (only HR and Admin can create)
router.post('/', authenticate, requireWriteAccess, async (req, res) => {
  try {
    const { title, description, requirements, interviewers } = req.body;

    if (!title || !description) {
      return res.status(400).json({
        error: 'Title and description are required'
      });
    }

    // Validate interviewers if provided
    let interviewersJson = null;
    if (interviewers) {
      if (!Array.isArray(interviewers)) {
        return res.status(400).json({
          error: 'Interviewers must be an array'
        });
      }
      // Validate that all interviewer IDs exist and are Interviewer role
      if (interviewers.length > 0) {
        const placeholders = interviewers.map(() => '?').join(',');
        const validInterviewers = await query(
          `SELECT id FROM users WHERE id IN (${placeholders}) AND role = 'Interviewer'`,
          interviewers
        );
        if (validInterviewers.length !== interviewers.length) {
          return res.status(400).json({
            error: 'One or more invalid interviewer IDs provided'
          });
        }
      }
      interviewersJson = JSON.stringify(interviewers);
    }

    const result = await query(
      'INSERT INTO job_descriptions (title, description, requirements, interviewers) VALUES (?, ?, ?, ?)',
      [title.trim(), description.trim(), requirements ? requirements.trim() : null, interviewersJson]
    );

    const jobDescription = await queryOne(
      'SELECT * FROM job_descriptions WHERE id = ?',
      [result.insertId]
    );

    // Parse JSON fields
    const parsedJobDescription = {
      ...jobDescription,
      interviewers: jobDescription.interviewers ? JSON.parse(jobDescription.interviewers) : []
    };

    res.json({
      success: true,
      message: 'Job description created successfully',
      data: parsedJobDescription
    });
  } catch (error) {
    console.error('Error creating job description:', error);
    res.status(500).json({
      error: 'Failed to create job description',
      message: error.message
    });
  }
});

// Update job description (only HR and Admin can update)
router.put('/:id', authenticate, requireWriteAccess, async (req, res) => {
  try {
    const { id } = req.params;
    const { title, description, requirements, interviewers } = req.body;

    if (!title || !description) {
      return res.status(400).json({
        error: 'Title and description are required'
      });
    }

    // Validate interviewers if provided
    let interviewersJson = null;
    if (interviewers !== undefined) {
      if (!Array.isArray(interviewers)) {
        return res.status(400).json({
          error: 'Interviewers must be an array'
        });
      }
      // Validate that all interviewer IDs exist and are Interviewer role
      if (interviewers.length > 0) {
        const placeholders = interviewers.map(() => '?').join(',');
        const validInterviewers = await query(
          `SELECT id FROM users WHERE id IN (${placeholders}) AND role = 'Interviewer'`,
          interviewers
        );
        if (validInterviewers.length !== interviewers.length) {
          return res.status(400).json({
            error: 'One or more invalid interviewer IDs provided'
          });
        }
      }
      interviewersJson = JSON.stringify(interviewers);
    }

    // Build update query dynamically
    let updateFields = ['title = ?', 'description = ?'];
    let updateValues = [title.trim(), description.trim()];

    if (requirements !== undefined) {
      updateFields.push('requirements = ?');
      updateValues.push(requirements ? requirements.trim() : null);
    }

    if (interviewers !== undefined) {
      updateFields.push('interviewers = ?');
      updateValues.push(interviewersJson);
    }

    updateValues.push(id);

    const result = await query(
      `UPDATE job_descriptions SET ${updateFields.join(', ')} WHERE id = ?`,
      updateValues
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Job description not found' });
    }

    const jobDescription = await queryOne(
      'SELECT * FROM job_descriptions WHERE id = ?',
      [id]
    );

    // Parse JSON fields
    const parsedJobDescription = {
      ...jobDescription,
      interviewers: jobDescription.interviewers ? JSON.parse(jobDescription.interviewers) : []
    };

    res.json({
      success: true,
      message: 'Job description updated successfully',
      data: parsedJobDescription
    });
  } catch (error) {
    console.error('Error updating job description:', error);
    res.status(500).json({
      error: 'Failed to update job description',
      message: error.message
    });
  }
});

// Delete job description (only HR and Admin can delete)
router.delete('/:id', authenticate, requireWriteAccess, async (req, res) => {
  try {
    const { id } = req.params;

    const result = await query(
      'DELETE FROM job_descriptions WHERE id = ?',
      [id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Job description not found' });
    }

    res.json({
      success: true,
      message: 'Job description deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting job description:', error);
    res.status(500).json({
      error: 'Failed to delete job description',
      message: error.message
    });
  }
});

module.exports = router;
