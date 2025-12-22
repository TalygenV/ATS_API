const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const fsPromises = require('fs').promises;
const FormData = require('form-data');
const axios = require('axios');
const { extractTextFromFile, parseResumeWithGemini } = require('../utils/resumeParser');
const { findOriginalResume, getNextVersionNumber } = require('../utils/duplicateChecker');
const { matchResumeWithJobDescription } = require('../utils/resumeMatcher');
const { hasRecentApplication , alreadyAssignInterView } = require('../utils/applicationValidator');
const { query, queryOne } = require('../config/database');
const { authenticate, requireWriteAccess } = require('../middleware/auth');
const { convertResultToUTC } = require('../utils/datetimeUtils');

const router = express.Router();

// Helper function to upload file to Talygen API and store response
const uploadToTalygen = async (filePath, fileName, mimetype, resumeId = null) => {
  try {
    let apiToken = process.env.TALYGEN_API_TOKEN;
    const apiUrl = process.env.TALYGEN_API_URL || 'https://appfilemedia.talygen.com/api/UploadStreamNew';

    if (!apiToken) {
      console.warn('⚠️  Talygen API token not configured, skipping Talygen upload');
      return null;
    }

    // Trim token in case there are extra spaces
    apiToken = apiToken.trim();

    // Log token status (first 4 chars only for debugging)
    const tokenPreview = apiToken.length > 4 ? apiToken.substring(0, 4) + '...' : '***';
    console.log(`📤 Uploading file to Talygen API: ${fileName} (Token: ${tokenPreview}, Length: ${apiToken.length})${resumeId ? ` [Resume ID: ${resumeId}]` : ''}`);

    // Create form data
    const formData = new FormData();
    formData.append('folderId', '0');
    formData.append('moduleName', 'DocStorage');
    formData.append('subModuleName', '');
    formData.append('additionalStorage', '');
    formData.append('additionalStorageFolderId', '');
    formData.append('fileDetails', '');
    formData.append('file', fs.createReadStream(filePath), fileName);

    // Make request to Talygen API
    // Note: Authorization header must include "Bearer " prefix
    const authHeader = apiToken.startsWith('Bearer ') ? apiToken : `Bearer ${apiToken}`;
    const response = await axios.post(apiUrl, formData, {
      headers: {
        'Authorization': authHeader,
        ...formData.getHeaders()
      },
      maxContentLength: Infinity,
      maxBodyLength: Infinity
    });

    console.log(`✅ File uploaded successfully to Talygen API`);

    const apiResponse = response.data;

    // Store response in database with resume_id if provided
    const result = await query(
      `INSERT INTO file_uploads (
        resume_id, original_file_name, file_name, file_path, file_thumb_path, folder_id,
        file_type, file_size, file_id, upload_status, error_msg, api_response
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        resumeId || null,
        fileName,
        apiResponse.FileName || null,
        apiResponse.FilePath || null,
        apiResponse.FileThumbPath || null,
        apiResponse.FolderId || null,
        apiResponse.FileType || null,
        apiResponse.FileSize || null,
        JSON.stringify(apiResponse.FileId || apiResponse.FileID || null),
        apiResponse.UploadStatus || null,
        apiResponse.ErrorMsg || null,
        JSON.stringify(apiResponse)
      ]
    );

    console.log(`✅ Talygen upload response saved to database (ID: ${result.insertId}${resumeId ? `, linked to Resume ID: ${resumeId}` : ''})`);

    return {
      fileUploadId: result.insertId,
      filePath: apiResponse.FilePath,
      apiResponse: apiResponse
    };
  } catch (error) {
    console.error(`⚠️  Error uploading to Talygen API:`, error.message);
    if (error.response) {
      console.error('API Response Status:', error.response.status);
      console.error('API Response Data:', error.response.data);
      console.error('API Response Headers:', error.response.headers);
      
      // If 401, provide helpful message
      if (error.response.status === 401) {
        console.error('❌ Authentication failed. Please check:');
        console.error('   1. TALYGEN_API_TOKEN is set in your .env file');
        console.error('   2. The token is correct and not expired');
        console.error('   3. The token format matches what the API expects');
      }
    } else if (error.request) {
      console.error('Request was made but no response received:', error.request);
    } else {
      console.error('Error setting up request:', error.message);
    }
    // Don't throw error - allow resume processing to continue even if Talygen upload fails
    return null;
  }
};

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
// Use /tmp for serverless environments (Netlify), otherwise use uploads directory
const getUploadDir = () => {
  // Check if running on Netlify (serverless environment)
  if (process.env.NETLIFY || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.VERCEL) {
    return '/tmp';
  }
  return path.join(__dirname, '../uploads/resumes');
};

const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    const uploadDir = getUploadDir();
    try {
      await fsPromises.mkdir(uploadDir, { recursive: true });
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

// Multer with memory storage for Talygen uploads (no disk storage)
const uploadMemory = multer({
  storage: multer.memoryStorage(),
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
      return res.status(200).json({
        success: false,
        error: 'File too large. Maximum file size is 10MB.'
      });
    }
    if (err.code === 'LIMIT_FILE_COUNT') {
      return res.status(200).json({
        success: false,
        error: 'Too many files. Maximum is 5 files for bulk upload.'
      });
    }
    return res.status(200).json({
      success: false,
      error: err.message || 'File upload error'
    });
  }
  if (err) {
    return res.status(200).json({
      success: false,
      error: err.message || 'Upload error'
    });
  }
  next();
};

// Helper function to process a single resume file
const processResumeFile = async (file, jobData) => {
  const filePath = file.path;
  const fileName = file.originalname;
  const mimetype = file.mimetype;

  // Extract text from file
  let resumeText;
  try {
    resumeText = await extractTextFromFile(filePath, mimetype);
  } catch (extractError) {
    console.error(`❌ Error extracting text from file ${fileName}:`, extractError.message);
    // Clean up file before throwing error
    try {
      await fsPromises.unlink(filePath);
    } catch (e) {
      // Ignore cleanup errors
    }
    throw new Error(`Failed to extract text from file: ${extractError.message}. The file may be corrupted or in an unsupported format.`);
  }

  // Validate that text was extracted successfully
  if (!resumeText || typeof resumeText !== 'string' || resumeText.trim().length === 0) {
    console.error(`❌ No text extracted from file ${fileName}. File may be empty, corrupted, or contain only images.`);
    // Clean up file before throwing error
    try {
      await fsPromises.unlink(filePath);
    } catch (e) {
      // Ignore cleanup errors
    }
    throw new Error(`No text could be extracted from the file "${fileName}". The file may be empty, corrupted, contain only images, or be in an unsupported format.`);
  }

  console.log(`📄 Extracted ${resumeText.length} characters from ${fileName}`);

  // Parse resume with Gemini
  const parsedData = await parseResumeWithGemini(resumeText, fileName);

  // Normalize email to lowercase for consistency
  const normalizedEmail = parsedData.email ? parsedData.email.toLowerCase().trim() : null;

  //  Check if candidate has applied within the last 6 months
  if (normalizedEmail) {
     // const hasRecent = await hasRecentApplication(normalizedEmail);
    const hasInterview = await alreadyAssignInterView(normalizedEmail);
    

     if (hasInterview) {
      // Clean up file before throwing error
      try {
        await fsPromises.unlink(filePath);
      } catch (e) {
        // Ignore cleanup errors
      }
      throw new Error('Candidate interview is already scheduled ');
    }


    // if (hasRecent) {
    //   // Clean up file before throwing error
    //   try {
    //     await fsPromises.unlink(filePath);
    //   } catch (e) {
    //     // Ignore cleanup errors
    //   }
    //   throw new Error('This candidate has already applied within the last 6 months');
    // }
  }

  // Check for duplicate resume and get versioning info
  const originalResumeId = await findOriginalResume(parsedData);
  let parentId = null;
  let versionNumber = 1;

  if (originalResumeId) {
    // This is a duplicate - create a new version
    parentId = originalResumeId;
    versionNumber = await getNextVersionNumber(originalResumeId);
    console.log(`📝 Duplicate detected! Creating version ${versionNumber} for candidate (Original ID: ${originalResumeId})`);
  }

  // Ensure we preserve the original filename with extension for download
  const originalFileName = fileName;

  console.log(`💾 Saving resume to database...`);
  // Save to MySQL with file path and version number
  const result = await query(
    `INSERT INTO resumes (
      file_name, file_path, name, email, phone, location, 
      skills, experience, education, summary, certifications, 
      raw_text, total_experience, parent_id, version_number
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      parentId,
      versionNumber
    ]
  );

  const savedResume = await queryOne(
    'SELECT * FROM resumes WHERE id = ?',
    [result.insertId]
  );
  console.log(`✅ Resume saved to database (ID: ${result.insertId})`);

  // Upload to Talygen API and store response (now with resume_id)
  let talygenUpload = null;
  try {
    talygenUpload = await uploadToTalygen(filePath, fileName, mimetype, result.insertId);
  } catch (talygenError) {
    console.error(`⚠️  Talygen upload failed, continuing with resume processing:`, talygenError.message);
  }

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
        parseInt(jobData.id),
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

  return {
    success: true,
    parsedResume,
    versionNumber,
    parentId,
    evaluationData,
    matchResults,
    talygenUpload
  };
};


// Single file upload (only HR and Admin can upload)
router.post('/single', authenticate, requireWriteAccess, upload.single('resume'), handleMulterError, async (req, res) => {
  const startTime = Date.now();
  console.log('\n========== SINGLE UPLOAD STARTED ==========');
  console.log(`Timestamp: ${new Date().toISOString()}`);
  console.log(`User: ${req.user.email} (${req.user.role})`);
  
  try {
    if (!req.file) {
      return res.status(200).json({ error: 'No file uploaded' });
    }

    const { job_description_id } = req.body;
    if (!job_description_id) {
      return res.status(200).json({ error: 'Job description ID is required' });
    }

    // Fetch job description
    const jobData = await queryOne(
      'SELECT * FROM job_descriptions WHERE id = ?',
      [job_description_id]
    );

    if (!jobData) {
      return res.status(404).json({ error: 'Job description not found' });
    }

    // Process resume using helper function
    const {
      parsedResume,
      versionNumber,
      parentId,
      evaluationData,
      matchResults,
      talygenUpload
    } = await processResumeFile(req.file, jobData);

    const totalTime = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`✅ SUCCESS - Upload completed in ${totalTime}s`);
    console.log(`==========================================\n`);

    res.json({
      success: true,
      message: parentId ? `Resume parsed and saved successfully (Version ${versionNumber} created)` : 'Resume parsed and saved successfully',
      data: {
        ...parsedResume,
        version_number: versionNumber,
        parent_id: parentId
      },
      isDuplicate: !!parentId,
      parentId: parentId,
      versionNumber: versionNumber,
      evaluation: evaluationData,
      matchScores: {
        overall_match: matchResults.overall_match,
        skills_match: matchResults.skills_match,
        experience_match: matchResults.experience_match,
        education_match: matchResults.education_match,
        status: matchResults.status
      },
      talygenUpload: talygenUpload ? {
        fileUploadId: talygenUpload.fileUploadId,
        filePath: talygenUpload.filePath
      } : null
    });
  } catch (error) {
    // Clean up file on error
    if (req.file) {
      try {
        await fsPromises.unlink(req.file.path);
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
    res.status(200).json({
      error: error.message,
   
    });
  }
});

// Multiple files upload (only HR and Admin can upload) - Maximum 5 files
router.post('/bulk', authenticate, requireWriteAccess, upload.array('resumes', 5), handleMulterError, async (req, res) => {
  const startTime = Date.now();
  console.log('\n========== BULK UPLOAD STARTED ==========');
  console.log(`Timestamp: ${new Date().toISOString()}`);
  console.log(`User: ${req.user.email} (${req.user.role})`);
  
  try {
    if (!req.files || req.files.length === 0) {
      console.log('❌ ERROR: No files uploaded');
      return res.status(200).json({ error: 'No files uploaded' });
    }

    // Enforce maximum 5 files limit for bulk upload
    const MAX_BULK_FILES = 5;
    if (req.files.length > MAX_BULK_FILES) {
      console.log(`❌ ERROR: Too many files. Maximum ${MAX_BULK_FILES} files allowed for bulk upload. Received: ${req.files.length}`);
      // Clean up uploaded files
      for (const file of req.files) {
        try {
          await fsPromises.unlink(file.path);
        } catch (e) {
          // Ignore cleanup errors
        }
      }
      return res.status(200).json({ 
        error: `Too many files. Maximum ${MAX_BULK_FILES} files allowed for bulk upload.`,
        received: req.files.length,
        maxAllowed: MAX_BULK_FILES
      });
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

    const results = [];
    const errors = [];

    console.log(`\n📝 Processing ${req.files.length} files...\n`);

    for (let i = 0; i < req.files.length; i++) {
      const file = req.files[i];
      const fileStartTime = Date.now();
      
      // Add a small delay between files to avoid overwhelming the API (except for the first file)
      if (i > 0) {
        await new Promise(resolve => setTimeout(resolve, 500)); // 500ms delay between files
      }
      
      try {
        console.log(`[${i + 1}/${req.files.length}] Processing: ${file.originalname}`);
        
        // Use helper function to process resume
        const {
          parsedResume,
          versionNumber,
          parentId,
          evaluationData,
          matchResults,
          talygenUpload
        } = await processResumeFile(file, jobData);

        const fileProcessingTime = ((Date.now() - fileStartTime) / 1000).toFixed(2);
        results.push({
          fileName: file.originalname,
          success: true,
          data: {
            ...parsedResume,
            version_number: versionNumber,
            parent_id: parentId
          },
          isDuplicate: !!parentId,
          parentId: parentId,
          versionNumber: versionNumber,
          evaluation: evaluationData,
          matchScores: {
            overall_match: matchResults.overall_match,
            skills_match: matchResults.skills_match,
            experience_match: matchResults.experience_match,
            education_match: matchResults.education_match,
            status: matchResults.status
          },
          talygenUpload: talygenUpload ? {
            fileUploadId: talygenUpload.fileUploadId,
            filePath: talygenUpload.filePath
          } : null
        });
        console.log(`   ✅ SUCCESS - Completed in ${fileProcessingTime}s\n`);
      } catch (error) {
        const fileProcessingTime = ((Date.now() - fileStartTime) / 1000).toFixed(2);
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
          await fsPromises.unlink(file.path);
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
    res.status(200).json({
      error: 'Failed to process resumes',
      message: error.message
    });
  }
});

// Upload file to Talygen API and store response
router.post('/talygen', authenticate, requireWriteAccess, uploadMemory.single('file'), handleMulterError, async (req, res) => {
  const startTime = Date.now();
  console.log('\n========== TALYGEN UPLOAD STARTED ==========');
  console.log(`Timestamp: ${new Date().toISOString()}`);
  console.log(`User: ${req.user.email} (${req.user.role})`);
  
  try {
    if (!req.file) {
      return res.status(200).json({ error: 'No file uploaded' });
    }

    const apiToken = process.env.TALYGEN_API_TOKEN;
    const apiUrl = process.env.TALYGEN_API_URL || 'https://appfilemedia.talygen.com/api/UploadStreamNew';

    if (!apiToken) {
      return res.status(500).json({ error: 'Talygen API token not configured' });
    }

    const fileBuffer = req.file.buffer; // File is in memory as buffer
    const fileName = req.file.originalname;
    const fileMimetype = req.file.mimetype;

    console.log(`📤 Uploading file to Talygen API: ${fileName} (${(fileBuffer.length / 1024).toFixed(2)} KB)`);

    // Create form data
    const formData = new FormData();
    formData.append('folderId', '0');
    formData.append('moduleName', 'DocStorage');
    formData.append('subModuleName', '');
    formData.append('additionalStorage', '');
    formData.append('additionalStorageFolderId', '');
    formData.append('fileDetails', '');
    // Append file buffer directly (no disk file)
    formData.append('file', fileBuffer, {
      filename: fileName,
      contentType: fileMimetype
    });

    // Make request to Talygen API
    // Note: Authorization header must include "Bearer " prefix
    let apiTokenTrimmed = apiToken.trim();
    const authHeader = apiTokenTrimmed.startsWith('Bearer ') ? apiTokenTrimmed : `Bearer ${apiTokenTrimmed}`;
    const response = await axios.post(apiUrl, formData, {
      headers: {
        'Authorization': authHeader,
        ...formData.getHeaders()
      },
      maxContentLength: Infinity,
      maxBodyLength: Infinity
    });

    console.log(`✅ File uploaded successfully to Talygen API`);

    const apiResponse = response.data;

    // Store response in database (standalone upload, no resume_id)
    console.log(`💾 Saving upload response to database...`);
    const result = await query(
      `INSERT INTO file_uploads (
        resume_id, original_file_name, file_name, file_path, file_thumb_path, folder_id,
        file_type, file_size, file_id, upload_status, error_msg, api_response
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        null, // Standalone upload, not linked to a resume
        fileName,
        apiResponse.FileName || null,
        apiResponse.FilePath || null,
        apiResponse.FileThumbPath || null,
        apiResponse.FolderId || null,
        apiResponse.FileType || null,
        apiResponse.FileSize || null,
        JSON.stringify(apiResponse.FileId || apiResponse.FileID || null),
        apiResponse.UploadStatus || null,
        apiResponse.ErrorMsg || null,
        JSON.stringify(apiResponse)
      ]
    );

    const savedUpload = await queryOne(
      'SELECT * FROM file_uploads WHERE id = ?',
      [result.insertId]
    );
    console.log(`✅ Upload response saved to database (ID: ${result.insertId})`);

    // No cleanup needed - file was in memory only, not saved to disk

    const totalTime = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`✅ SUCCESS - Upload completed in ${totalTime}s`);
    console.log(`==========================================\n`);

    res.json({
      success: true,
      message: 'File uploaded successfully to Talygen',
      data: {
        id: savedUpload.id,
        originalFileName: savedUpload.original_file_name,
        fileName: savedUpload.file_name,
        filePath: savedUpload.file_path,
        fileThumbPath: savedUpload.file_thumb_path,
        fileSize: savedUpload.file_size,
        uploadStatus: savedUpload.upload_status,
        createdAt: savedUpload.created_at
      },
      apiResponse: apiResponse
    });
  } catch (error) {
    // No cleanup needed - file was in memory only, not saved to disk

    const totalTime = ((Date.now() - startTime) / 1000).toFixed(2);
    console.error(`\n❌ TALYGEN UPLOAD FAILED after ${totalTime}s`);
    console.error('Error:', error.message);
    if (error.response) {
      console.error('API Response Status:', error.response.status);
      console.error('API Response Data:', error.response.data);
    }
    console.error('Stack:', error.stack);
    console.log(`==========================================\n`);
    
    res.status(500).json({
      error: 'Failed to upload file to Talygen',
      message: error.message,
      details: error.response?.data || null
    });
  }
});

// Download file from Talygen using stored FilePath
router.get('/talygen/:id/download', authenticate, async (req, res) => {
  try {
    const { id } = req.params;

    console.log(`📥 Downloading file from Talygen (Upload ID: ${id})`);

    const fileUpload = await queryOne(
      'SELECT * FROM file_uploads WHERE id = ?',
      [id]
    );

    if (!fileUpload) {
      return res.status(404).json({ error: 'File upload record not found' });
    }

    if (!fileUpload.file_path) {
      return res.status(404).json({ error: 'File path not available for this upload' });
    }

    // Download file from Talygen
    const response = await axios.get(fileUpload.file_path, {
      responseType: 'stream'
    });

    // Determine content type from file extension or response headers
    const path = require('path');
    const fileExt = path.extname(fileUpload.file_name || fileUpload.original_file_name || '').toLowerCase();
    const mimeTypes = {
      '.pdf': 'application/pdf',
      '.doc': 'application/msword',
      '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      '.txt': 'text/plain',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg'
    };
    const contentType = response.headers['content-type'] || mimeTypes[fileExt] || 'application/octet-stream';

    // Get filename for download
    const downloadFileName = fileUpload.file_name || fileUpload.original_file_name || `file-${id}${fileExt}`;

    // Set headers for file download
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${downloadFileName}"; filename*=UTF-8''${encodeURIComponent(downloadFileName)}`);

    // Pipe the response stream to the client
    response.data.pipe(res);

    console.log(`✅ File download initiated: ${downloadFileName}`);
  } catch (error) {
    console.error('Error downloading file from Talygen:', error);
    
    if (error.response) {
      console.error('API Response Status:', error.response.status);
      console.error('API Response Data:', error.response.data);
    }

    res.status(500).json({
      error: 'Failed to download file from Talygen',
      message: error.message
    });
  }
});

// Get list of uploaded files
router.get('/talygen', authenticate, async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    const files = await query(
      `SELECT id, original_file_name, file_name, file_path, file_thumb_path, 
              file_size, upload_status, created_at 
       FROM file_uploads 
       ORDER BY created_at DESC 
       LIMIT ? OFFSET ?`,
      [parseInt(limit), offset]
    );

    const totalCount = await queryOne(
      'SELECT COUNT(*) as count FROM file_uploads'
    );

    res.json({
      success: true,
      data: convertResultToUTC(files),
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: totalCount.count,
        totalPages: Math.ceil(totalCount.count / parseInt(limit))
      }
    });
  } catch (error) {
    console.error('Error fetching uploaded files:', error);
    res.status(500).json({
      error: 'Failed to fetch uploaded files',
      message: error.message
    });
  }
});

module.exports = router;
