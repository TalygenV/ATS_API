const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;
const { extractTextFromFile, parseResumeWithGemini } = require('../utils/resumeParser');
const { findDuplicateResume } = require('../utils/duplicateChecker');
const { matchResumeWithJobDescription } = require('../utils/resumeMatcher');
const { query, queryOne } = require('../config/database');
const { authenticate, requireWriteAccess } = require('../middleware/auth');

const router = express.Router();

// Helper function to safely parse JSON fields (handles both strings and already-parsed objects)
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

// Configure multer for file uploads - save original files with prefix
const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    const uploadDir = path.join(__dirname, '../uploads/resumes');
    try {
      await fs.mkdir(uploadDir, { recursive: true });
      cb(null, uploadDir);
    } catch (error) {
      cb(error, null);
    }
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const originalExt = path.extname(file.originalname);
    // Save with prefix "resume_" and preserve original extension
    cb(null, `resume_${uniqueSuffix}${originalExt}`);
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  fileFilter: (req, file, cb) => {
    const allowedTypes = [
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'text/plain'
    ];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only PDF, DOC, DOCX, and TXT files are allowed.'));
    }
  }
});

// Error handler for multer - must be used as middleware after multer
const handleMulterError = (err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({
        success: false,
        error: 'File too large. Maximum file size is 10MB.'
      });
    }
    if (err.code === 'LIMIT_FILE_COUNT') {
      return res.status(400).json({
        success: false,
        error: 'Too many files. Maximum is 50 files.'
      });
    }
    return res.status(400).json({
      success: false,
      error: err.message || 'File upload error'
    });
  }
  if (err) {
    return res.status(400).json({
      success: false,
      error: err.message || 'Upload error'
    });
  }
  next();
};

// Single file upload (only HR and Admin can upload)
router.post('/single', authenticate, requireWriteAccess, upload.single('resume'), handleMulterError, async (req, res) => {
  const startTime = Date.now();
  console.log('\n========== SINGLE UPLOAD STARTED ==========');
  console.log(`Timestamp: ${new Date().toISOString()}`);
  console.log(`User: ${req.user.email} (${req.user.role})`);
  
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const { job_description_id } = req.body;
    if (!job_description_id) {
      return res.status(400).json({ error: 'Job description ID is required' });
    }

    // Fetch job description
    const jobData = await queryOne(
      'SELECT * FROM job_descriptions WHERE id = ?',
      [job_description_id]
    );

    if (!jobData) {
      return res.status(404).json({ error: 'Job description not found' });
    }

    const filePath = req.file.path;
    const fileName = req.file.originalname; // Original filename with extension
    const mimetype = req.file.mimetype;

    // Extract text from file
    const resumeText = await extractTextFromFile(filePath, mimetype);

    // Parse resume with Gemini
    const parsedData = await parseResumeWithGemini(resumeText, fileName);

    // Check for duplicate resume
    const parentId = await findDuplicateResume(parsedData);

    // Normalize email to lowercase for consistency
    const normalizedEmail = parsedData.email ? parsedData.email.toLowerCase().trim() : null;

    // Ensure we preserve the original filename with extension for download
    const originalFileName = fileName;

    console.log(`💾 Saving resume to database...`);
    // Save to MySQL with file path
    const result = await query(
      `INSERT INTO resumes (
        file_name, file_path, name, email, phone, location, 
        skills, experience, education, summary, certifications, 
        raw_text, total_experience, parent_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        originalFileName,
        filePath,
        parsedData.name || null,
        normalizedEmail,
        parsedData.phone || null,
        parsedData.location || null,
        JSON.stringify(parsedData.skills || []),
        JSON.stringify(parsedData.experience || []),
        JSON.stringify(parsedData.education || []),
        parsedData.summary || null,
        JSON.stringify(parsedData.certifications || []),
        resumeText,
        parsedData.total_experience ? parseFloat(parsedData.total_experience) : null,
        parentId
      ]
    );

    const savedResume = await queryOne(
      'SELECT * FROM resumes WHERE id = ?',
      [result.insertId]
    );
    console.log(`✅ Resume saved to database (ID: ${result.insertId})`);

    // Parse JSON fields safely
    const parsedResume = {
      ...savedResume,
      skills: safeParseJSON(savedResume.skills, []),
      experience: safeParseJSON(savedResume.experience, []),
      education: safeParseJSON(savedResume.education, []),
      certifications: safeParseJSON(savedResume.certifications, [])
    };

    // Match resume with job description
    const fullJobDescription = `${jobData.title}\n\n${jobData.description}\n\n${jobData.requirements || ''}`;
    console.log(`🎯 Matching resume with job description...`);
    const matchResults = await matchResumeWithJobDescription(
      resumeText,
      fullJobDescription,
      parsedData
    );

    console.log(`📊 Match scores - Overall: ${matchResults.overall_match}%, Skills: ${matchResults.skills_match}%, Experience: ${matchResults.experience_match}%, Education: ${matchResults.education_match}%`);
    
    // Save evaluation
    let evaluationData = null;
    console.log(`💾 Saving evaluation to database...`);
    try {
      const evalResult = await query(
        `INSERT INTO candidate_evaluations (
          resume_id, job_description_id, candidate_name, contact_number, email,
          resume_text, job_description, overall_match, skills_match, skills_details,
          experience_match, experience_details, education_match, education_details,
          status, rejection_reason
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          parsedResume.id,
          parseInt(job_description_id),
          parsedData.name || null,
          parsedData.phone || null,
          normalizedEmail,
          resumeText,
          fullJobDescription,
          matchResults.overall_match,
          matchResults.skills_match,
          matchResults.skills_details,
          matchResults.experience_match,
          matchResults.experience_details,
          matchResults.education_match,
          matchResults.education_details,
          matchResults.status,
          matchResults.rejection_reason || null
        ]
      );

      evaluationData = await queryOne(
        'SELECT * FROM candidate_evaluations WHERE id = ?',
        [evalResult.insertId]
      );
      console.log(`✅ Evaluation saved (ID: ${evalResult.insertId})`);
    } catch (evalError) {
      console.error(`⚠️  Error saving evaluation:`, evalError.message);
      // Don't fail the upload if evaluation fails, just log it
    }

    const totalTime = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`✅ SUCCESS - Upload completed in ${totalTime}s`);
    console.log(`==========================================\n`);

    res.json({
      success: true,
      message: parentId ? 'Resume parsed and saved successfully (duplicate detected)' : 'Resume parsed and saved successfully',
      data: parsedResume,
      isDuplicate: !!parentId,
      parentId: parentId,
      evaluation: evaluationData,
      matchScores: {
        overall_match: matchResults.overall_match,
        skills_match: matchResults.skills_match,
        experience_match: matchResults.experience_match,
        education_match: matchResults.education_match,
        status: matchResults.status
      }
    });
  } catch (error) {
    // Clean up file on error
    if (req.file) {
      try {
        await fs.unlink(req.file.path);
        console.log(`🗑️  Cleaned up file: ${req.file.path}`);
      } catch (e) {
        // Ignore cleanup errors
      }
    }

    const totalTime = ((Date.now() - startTime) / 1000).toFixed(2);
    console.error(`\n❌ UPLOAD FAILED after ${totalTime}s`);
    console.error('Error:', error.message);
    console.error('Stack:', error.stack);
    console.log(`==========================================\n`);
    
    res.status(500).json({
      error: 'Failed to process resume',
      message: error.message
    });
  }
});

// Multiple files upload (only HR and Admin can upload)
router.post('/bulk', authenticate, requireWriteAccess, upload.array('resumes', 50), handleMulterError, async (req, res) => {
  const startTime = Date.now();
  console.log('\n========== BULK UPLOAD STARTED ==========');
  console.log(`Timestamp: ${new Date().toISOString()}`);
  console.log(`User: ${req.user.email} (${req.user.role})`);
  
  try {
    if (!req.files || req.files.length === 0) {
      console.log('❌ ERROR: No files uploaded');
      return res.status(400).json({ error: 'No files uploaded' });
    }

    console.log(`📁 Total files received: ${req.files.length}`);
    req.files.forEach((file, index) => {
      console.log(`   ${index + 1}. ${file.originalname} (${(file.size / 1024).toFixed(2)} KB)`);
    });

    const { job_description_id } = req.body;
    if (!job_description_id) {
      console.log('❌ ERROR: Job description ID is required');
      return res.status(400).json({ error: 'Job description ID is required' });
    }

    console.log(`\n🔍 Fetching job description ID: ${job_description_id}`);
    // Fetch job description
    const jobData = await queryOne(
      'SELECT * FROM job_descriptions WHERE id = ?',
      [job_description_id]
    );

    if (!jobData) {
      console.log(`❌ ERROR: Job description not found for ID: ${job_description_id}`);
      return res.status(404).json({ error: 'Job description not found' });
    }

    console.log(`✅ Job description found: "${jobData.title}"`);
    const fullJobDescription = `${jobData.title}\n\n${jobData.description}\n\n${jobData.requirements || ''}`;

    const results = [];
    const errors = [];

    console.log(`\n📝 Processing ${req.files.length} files...\n`);

    for (let i = 0; i < req.files.length; i++) {
      const file = req.files[i];
      const fileStartTime = Date.now(); // Define outside try block so it's available in catch
      try {
        console.log(`[${i + 1}/${req.files.length}] Processing: ${file.originalname}`);
        
        const filePath = file.path;
        const fileName = file.originalname;
        const mimetype = file.mimetype;

        console.log(`   📄 Extracting text from file...`);
        // Extract text from file
        const resumeText = await extractTextFromFile(filePath, mimetype);
        console.log(`   ✅ Text extracted (${resumeText.length} characters)`);

        console.log(`   🤖 Parsing resume with Gemini AI...`);
        // Parse resume with Gemini
        const parsedData = await parseResumeWithGemini(resumeText, fileName);
        console.log(`   ✅ Resume parsed - Name: ${parsedData.name || 'N/A'}, Email: ${parsedData.email || 'N/A'}`);

        console.log(`   🔍 Checking for duplicates...`);
        // Check for duplicate resume
        const parentId = await findDuplicateResume(parsedData);
        if (parentId) {
          console.log(`   ⚠️  Duplicate detected! Parent ID: ${parentId}`);
        } else {
          console.log(`   ✅ No duplicate found`);
        }

        // Normalize email to lowercase for consistency
        const normalizedEmail = parsedData.email ? parsedData.email.toLowerCase().trim() : null;

        // Ensure we preserve the original filename with extension
        const originalFileName = fileName;

        console.log(`   💾 Saving resume to database...`);
        // Save to MySQL with file path
        const result = await query(
          `INSERT INTO resumes (
            file_name, file_path, name, email, phone, location, 
            skills, experience, education, summary, certifications, 
            raw_text, total_experience, parent_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            originalFileName,
            filePath,
            parsedData.name || null,
            normalizedEmail,
            parsedData.phone || null,
            parsedData.location || null,
            JSON.stringify(parsedData.skills || []),
            JSON.stringify(parsedData.experience || []),
            JSON.stringify(parsedData.education || []),
            parsedData.summary || null,
            JSON.stringify(parsedData.certifications || []),
            resumeText,
            parsedData.total_experience ? parseFloat(parsedData.total_experience) : null,
            parentId
          ]
        );

        const savedResume = await queryOne(
          'SELECT * FROM resumes WHERE id = ?',
          [result.insertId]
        );
        console.log(`   ✅ Resume saved to database (ID: ${result.insertId})`);

        // Parse JSON fields safely
        const parsedResume = {
          ...savedResume,
          skills: safeParseJSON(savedResume.skills, []),
          experience: safeParseJSON(savedResume.experience, []),
          education: safeParseJSON(savedResume.education, []),
          certifications: safeParseJSON(savedResume.certifications, [])
        };

        console.log(`   🎯 Matching resume with job description...`);
        // Match resume with job description
        const matchResults = await matchResumeWithJobDescription(
          resumeText,
          fullJobDescription,
          parsedData
        );

        console.log(`   📊 Match scores - Overall: ${matchResults.overall_match}%, Skills: ${matchResults.skills_match}%, Experience: ${matchResults.experience_match}%, Education: ${matchResults.education_match}%`);
        
        // Save evaluation
        let evaluationData = null;
        console.log(`   💾 Saving evaluation to database...`);
        try {
          const evalResult = await query(
            `INSERT INTO candidate_evaluations (
              resume_id, job_description_id, candidate_name, contact_number, email,
              resume_text, job_description, overall_match, skills_match, skills_details,
              experience_match, experience_details, education_match, education_details,
              status, rejection_reason
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              parsedResume.id,
              parseInt(job_description_id),
              parsedData.name || null,
              parsedData.phone || null,
              normalizedEmail,
              resumeText,
              fullJobDescription,
              matchResults.overall_match,
              matchResults.skills_match,
              matchResults.skills_details,
              matchResults.experience_match,
              matchResults.experience_details,
              matchResults.education_match,
              matchResults.education_details,
              matchResults.status,
              matchResults.rejection_reason || null
            ]
          );

          evaluationData = await queryOne(
            'SELECT * FROM candidate_evaluations WHERE id = ?',
            [evalResult.insertId]
          );
          console.log(`   ✅ Evaluation saved (ID: ${evalResult.insertId})`);
        } catch (evalError) {
          console.error(`   ⚠️  Error saving evaluation:`, evalError.message);
          // Don't fail the upload if evaluation fails, just log it
        }

        const fileProcessingTime = ((Date.now() - fileStartTime) / 1000).toFixed(2);
        results.push({
          fileName: fileName,
          success: true,
          data: parsedResume,
          isDuplicate: !!parentId,
          parentId: parentId,
          evaluation: evaluationData,
          matchScores: {
            overall_match: matchResults.overall_match,
            skills_match: matchResults.skills_match,
            experience_match: matchResults.experience_match,
            education_match: matchResults.education_match,
            status: matchResults.status
          }
        });
        console.log(`   ✅ SUCCESS - Completed in ${fileProcessingTime}s\n`);
      } catch (error) {
        const fileProcessingTime = fileStartTime ? ((Date.now() - fileStartTime) / 1000).toFixed(2) : 'N/A';
        console.error(`   ❌ ERROR processing ${file.originalname}:`, error.message);
        if (error.stack) {
          console.error(`   Stack:`, error.stack);
        }
        errors.push({
          fileName: file.originalname,
          error: error.message
        });

        // Clean up file on error
        try {
          await fs.unlink(file.path);
        } catch (e) {
          // Ignore cleanup errors
        }
      }
    }

    const totalTime = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`\n========== BULK UPLOAD COMPLETED ==========`);
    console.log(`✅ Successfully processed: ${results.length} files`);
    console.log(`❌ Failed: ${errors.length} files`);
    console.log(`⏱️  Total time: ${totalTime}s`);
    console.log(`📊 Average time per file: ${(totalTime / req.files.length).toFixed(2)}s`);
    console.log(`==========================================\n`);

    res.json({
      success: true,
      processed: results.length,
      failed: errors.length,
      results: results,
      errors: errors
    });
  } catch (error) {
    const totalTime = ((Date.now() - startTime) / 1000).toFixed(2);
    console.error(`\n❌ BULK UPLOAD FAILED after ${totalTime}s`);
    console.error('Error:', error.message);
    console.error('Stack:', error.stack);
    console.log(`==========================================\n`);
    res.status(500).json({
      error: 'Failed to process resumes',
      message: error.message
    });
  }
});

module.exports = router;
