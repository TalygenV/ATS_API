const express = require('express');
const axios = require('axios');
const { query, queryOne } = require('../config/database');
const { authenticate, requireWriteAccess } = require('../middleware/auth');
const { convertResultToUTC } = require('../utils/datetimeUtils');

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
      'SELECT * FROM resumes where parent_id is null ORDER BY created_at DESC'
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

    // Parse JSON fields safely and convert datetime to UTC
    const parsedResume = {
      ...resume,
      skills: safeParseJSON(resume.skills, []),
      experience: safeParseJSON(resume.experience, []),
      education: safeParseJSON(resume.education, []),
      certifications: safeParseJSON(resume.certifications, [])
    };

    res.json({
      success: true,
      data: convertResultToUTC(parsedResume)
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

    // Parse JSON fields and convert datetime to UTC
    const parsedResumes = resumes.map(resume => {
      const parsed = {
        ...resume,
        skills: resume.skills ? JSON.parse(resume.skills) : [],
        experience: resume.experience ? JSON.parse(resume.experience) : [],
        education: resume.education ? JSON.parse(resume.education) : [],
        certifications: resume.certifications ? JSON.parse(resume.certifications) : []
      };
      return convertResultToUTC(parsed);
    });

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
  const startTime = Date.now();
  console.log(`\n==========================================`);
  console.log(`📥 DOWNLOAD REQUEST - Resume ID: ${req.params.id}`);
  console.log(`==========================================`);
  
  try {
    const { id } = req.params;
    const fs = require('fs').promises;
    const path = require('path');

    console.log(`🔍 Step 1: Looking up resume with ID: ${id}`);
    const resume = await queryOne(
      'SELECT  file_name FROM resumes WHERE id = ?',
      [id]
    );

    if (!resume) {
      console.error(`❌ Resume not found with ID: ${id}`);
      return res.status(404).json({ error: 'Resume not found' });
    }

    console.log(`✅ Resume found:`);
    console.log(`   - File Name: ${resume.file_name}`);

    // First, try to find the file in file_uploads table (Talygen storage)
    // Use resume_id for direct connection
    console.log(`\n🔍 Step 2: Searching for file_upload record...`);
    console.log(`   - Searching by resume_id: ${id}`);
    
    let fileUpload = await queryOne(
      'SELECT * FROM file_uploads WHERE resume_id = ? ORDER BY created_at DESC LIMIT 1',
      [id]
    );

    // Fallback: If not found by resume_id, try filename matching (for backward compatibility)
    if (!fileUpload) {
      console.log(`   - Not found by resume_id, trying filename match (backward compatibility)...`);
      console.log(`   - Searching by exact match: original_file_name = "${resume.file_name}"`);
      
      fileUpload = await queryOne(
        'SELECT * FROM file_uploads WHERE original_file_name = ? ORDER BY created_at DESC LIMIT 1',
        [resume.file_name]
      );

      // If not found by exact match, try case-insensitive match
      if (!fileUpload) {
        console.log(`   - Exact match not found, trying case-insensitive match...`);
        fileUpload = await queryOne(
          'SELECT * FROM file_uploads WHERE LOWER(original_file_name) = LOWER(?) ORDER BY created_at DESC LIMIT 1',
          [resume.file_name]
        );
      }

      // If still not found, try matching by file_name column
      if (!fileUpload) {
        console.log(`   - Case-insensitive match not found, trying file_name column match...`);
        fileUpload = await queryOne(
          'SELECT * FROM file_uploads WHERE file_name = ? OR LOWER(file_name) = LOWER(?) ORDER BY created_at DESC LIMIT 1',
          [resume.file_name, resume.file_name]
        );
      }
    }
    res.send(fileUpload);
    
    
  } catch (error) {
    const totalTime = ((Date.now() - startTime) / 1000).toFixed(2);
    console.error(`\n❌ ERROR downloading resume:`);
    console.error(`   - Error Message: ${error.message}`);
    console.error(`   - Error Code: ${error.code || 'N/A'}`);
    console.error(`   - Error Name: ${error.name || 'N/A'}`);
    if (error.response) {
      console.error(`   - Response Status: ${error.response.status || 'N/A'}`);
      console.error(`   - Response Status Text: ${error.response.statusText || 'N/A'}`);
    }
    console.error(`   - Stack Trace:`, error.stack);
    console.error(`⏱️  Total time before error: ${totalTime}s`);
    console.error(`==========================================\n`);
    
    res.status(500).json({
      error: 'Failed to download resume',
      message: error.message
    });
  }
});

// Get version history for a resume (all authenticated users can view)
// Accepts any resume ID (original or version) and returns all versions
router.get('/:id/versions', authenticate, async (req, res) => {
  try {
    const { id } = req.params;

    // First, get the resume to find the original

    // `SELECT id, parent_id, email, name FROM resumes WHERE id = ?  `
    const resume = await queryOne(`  SELECT 
  r.id,
  r.parent_id,
  r.email,
  r.name,
  jd.title         
FROM resumes r
INNER JOIN candidate_evaluations ce
  ON r.id = ce.resume_id
INNER JOIN job_descriptions jd
  ON jd.id = ce.job_description_id
WHERE r.id = ?`,
      [id]
    );

  

    if (!resume) {
      return res.status(404).json({ 
        success: false,
        error: 'Resume not found' 
      });
    }

    // Find the original resume ID
    // If this resume has a parent_id, use that; otherwise, this is the original
    const originalResumeId = resume.parent_id || resume.id;

    // Get all versions of this resume (original + all versions)
    // Order by version_number DESC (latest first), then by created_at DESC as fallback
    const versions = await query(
      `SELECT id, file_name, file_path, name, email, phone, location,
              skills, experience, education, summary, certifications,
              raw_text, total_experience, parent_id, version_number,
              created_at, updated_at
       FROM resumes 
       WHERE id = ? OR parent_id = ?
       ORDER BY version_number DESC, created_at DESC`,
      [originalResumeId, originalResumeId]
    );

    // Parse JSON fields for each version
    const parsedVersions = versions.map(version => ({
      id: version.id,
      file_name: version.file_name,
      file_path: version.file_path,
      name: version.name,
      email: version.email,
      phone: version.phone,
      location: version.location,
      skills: safeParseJSON(version.skills, []),
      experience: safeParseJSON(version.experience, []),
      education: safeParseJSON(version.education, []),
      summary: version.summary,
      certifications: safeParseJSON(version.certifications, []),
      raw_text: version.raw_text,
      total_experience: version.total_experience,
      parent_id: version.parent_id,
      version_number: version.version_number || 1,
      created_at: version.created_at,
      updated_at: version.updated_at,
      // Format the parsed data for display
      parsed_data: {
        name: version.name,
        email: version.email,
        phone: version.phone,
        location: version.location,
        skills: safeParseJSON(version.skills, []),
        experience: safeParseJSON(version.experience, []),
        education: safeParseJSON(version.education, []),
        summary: version.summary,
        certifications: safeParseJSON(version.certifications, []),
        total_experience: version.total_experience
      }
    }));

    // Convert datetime fields to UTC
    const convertedVersions = parsedVersions.map(v => convertResultToUTC(v));

    res.json({
      success: true,
      original_resume_id: originalResumeId,
      total_versions: convertedVersions.length,
      data: convertedVersions.map(v => ({
        title: resume.title,
        version: v.version_number,
        uploaded_on: v.created_at,
        resume_id: v.id,
        file_name: v.file_name,
        results: v.parsed_data
      }))
    });
  } catch (error) {
    console.error('Error fetching resume versions:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch resume versions',
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

// Get all resumes (all authenticated users can view)

// Get all resumes (all authenticated users can view)
router.get('/new/new-resumes', authenticate, async (req, res) => {
  try {
    const resumes = await query(
      'SELECT * FROM resumes where parent_id is null AND DATE(created_at) > utc_date() - INTERVAL 5 DAY ORDER BY created_at DESC LIMIT 4'
    );

    // Parse JSON fields and convert datetime to UTC
    const parsedResumes = resumes.map(resume => {
      const parsed = {
        ...resume,
        skills: resume.skills ? JSON.parse(resume.skills) : [],
        experience: resume.experience ? JSON.parse(resume.experience) : [],
        education: resume.education ? JSON.parse(resume.education) : [],
        certifications: resume.certifications ? JSON.parse(resume.certifications) : []
      };
      return convertResultToUTC(parsed);
    });

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

module.exports = router;
