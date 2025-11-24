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
      return defaultValue;
    }
  }
  return value;
};

// Get all resumes (all authenticated users can view)
router.get('/', authenticate, async (req, res) => {
  try {
    const resumes = await query(
      'SELECT * FROM resumes ORDER BY created_at DESC'
    );

    // Parse JSON fields
    const parsedResumes = resumes.map(resume => ({
      ...resume,
      skills: resume.skills ? JSON.parse(resume.skills) : [],
      experience: resume.experience ? JSON.parse(resume.experience) : [],
      education: resume.education ? JSON.parse(resume.education) : [],
      certifications: resume.certifications ? JSON.parse(resume.certifications) : []
    }));

    res.json({
      success: true,
      count: parsedResumes.length,
      data: parsedResumes
    });
  } catch (error) {
    console.error('Error fetching resumes:', error);
    res.status(500).json({
      error: 'Failed to fetch resumes',
      message: error.message
    });
  }
});

// Get resume by ID (all authenticated users can view)
router.get('/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;

    const resume = await queryOne(
      'SELECT * FROM resumes WHERE id = ?',
      [id]
    );

    if (!resume) {
      return res.status(404).json({ error: 'Resume not found' });
    }

    // Parse JSON fields safely
    const parsedResume = {
      ...resume,
      skills: safeParseJSON(resume.skills, []),
      experience: safeParseJSON(resume.experience, []),
      education: safeParseJSON(resume.education, []),
      certifications: safeParseJSON(resume.certifications, [])
    };

    res.json({
      success: true,
      data: parsedResume
    });
  } catch (error) {
    console.error('Error fetching resume:', error);
    res.status(500).json({
      error: 'Failed to fetch resume',
      message: error.message
    });
  }
});

// Search resumes (all authenticated users can view)
router.get('/search/:query', authenticate, async (req, res) => {
  try {
    const { query: searchQuery } = req.params;
    const searchTerm = `%${searchQuery}%`;

    const resumes = await query(
      `SELECT * FROM resumes 
       WHERE name LIKE ? OR email LIKE ? OR location LIKE ?
       ORDER BY created_at DESC`,
      [searchTerm, searchTerm, searchTerm]
    );

    // Parse JSON fields
    const parsedResumes = resumes.map(resume => ({
      ...resume,
      skills: resume.skills ? JSON.parse(resume.skills) : [],
      experience: resume.experience ? JSON.parse(resume.experience) : [],
      education: resume.education ? JSON.parse(resume.education) : [],
      certifications: resume.certifications ? JSON.parse(resume.certifications) : []
    }));

    res.json({
      success: true,
      count: parsedResumes.length,
      data: parsedResumes
    });
  } catch (error) {
    console.error('Error searching resumes:', error);
    res.status(500).json({
      error: 'Failed to search resumes',
      message: error.message
    });
  }
});

// Download original resume file (all authenticated users can download)
router.get('/:id/download', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const fs = require('fs').promises;
    const path = require('path');

    const resume = await queryOne(
      'SELECT file_path, file_name FROM resumes WHERE id = ?',
      [id]
    );

    if (!resume) {
      return res.status(404).json({ error: 'Resume not found' });
    }

    // Check if file path exists
    if (!resume.file_path) {
      return res.status(404).json({ error: 'Original file not found. File may have been deleted.' });
    }

    // Check if file exists on disk
    try {
      await fs.access(resume.file_path);
    } catch (accessError) {
      return res.status(404).json({ error: 'Original file not found on server.' });
    }

    // Get file extension from the actual file path
    const fileExt = path.extname(resume.file_path).toLowerCase();
    const mimeTypes = {
      '.pdf': 'application/pdf',
      '.doc': 'application/msword',
      '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      '.txt': 'text/plain'
    };
    const contentType = mimeTypes[fileExt] || 'application/octet-stream';

    // Get original filename from database
    let originalFileName = resume.file_name || `resume-${id}`;
    
    // Ensure the filename has the correct extension matching the actual file
    const originalExt = path.extname(originalFileName).toLowerCase();
    if (originalExt !== fileExt) {
      // Remove any existing extension and add the correct one
      originalFileName = originalFileName.replace(/\.[^/.]+$/, '') + fileExt;
    }
    
    // Sanitize filename but preserve extension
    const nameWithoutExt = originalFileName.replace(/\.[^/.]+$/, '');
    const sanitizedName = nameWithoutExt.replace(/[^a-zA-Z0-9._-]/g, '_');
    const finalFileName = sanitizedName + fileExt;

    // Set headers for file download with proper encoding
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${finalFileName}"; filename*=UTF-8''${encodeURIComponent(finalFileName)}`);

    // Read and send the file
    const fileBuffer = await fs.readFile(resume.file_path);
    res.send(fileBuffer);
  } catch (error) {
    console.error('Error downloading resume:', error);
    res.status(500).json({
      error: 'Failed to download resume',
      message: error.message
    });
  }
});

// Delete resume (only HR and Admin can delete)
router.delete('/:id', authenticate, requireWriteAccess, async (req, res) => {
  try {
    const { id } = req.params;

    const result = await query(
      'DELETE FROM resumes WHERE id = ?',
      [id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Resume not found' });
    }

    res.json({
      success: true,
      message: 'Resume deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting resume:', error);
    res.status(500).json({
      error: 'Failed to delete resume',
      message: error.message
    });
  }
});

module.exports = router;
