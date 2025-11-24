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

    res.json({
      success: true,
      count: jobDescriptions.length,
      data: jobDescriptions
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

    res.json({
      success: true,
      data: jobDescription
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
    const { title, description, requirements } = req.body;

    if (!title || !description) {
      return res.status(400).json({
        error: 'Title and description are required'
      });
    }

    const result = await query(
      'INSERT INTO job_descriptions (title, description, requirements) VALUES (?, ?, ?)',
      [title.trim(), description.trim(), requirements ? requirements.trim() : null]
    );

    const jobDescription = await queryOne(
      'SELECT * FROM job_descriptions WHERE id = ?',
      [result.insertId]
    );

    res.json({
      success: true,
      message: 'Job description created successfully',
      data: jobDescription
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
    const { title, description, requirements } = req.body;

    if (!title || !description) {
      return res.status(400).json({
        error: 'Title and description are required'
      });
    }

    const result = await query(
      'UPDATE job_descriptions SET title = ?, description = ?, requirements = ? WHERE id = ?',
      [title.trim(), description.trim(), requirements ? requirements.trim() : null, id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Job description not found' });
    }

    const jobDescription = await queryOne(
      'SELECT * FROM job_descriptions WHERE id = ?',
      [id]
    );

    res.json({
      success: true,
      message: 'Job description updated successfully',
      data: jobDescription
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
