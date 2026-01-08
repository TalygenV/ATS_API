const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;
const os = require('os');
const { query, queryOne } = require('../config/database');
const { authenticate, requireWriteAccess, authorize } = require('../middleware/auth');
const { sendInterviewFeedbackToHR } = require('../utils/emailService');
const { extractTextFromFile, parseResumeWithGemini } = require('../utils/resumeParser');
const { matchResumeWithJobDescriptionAndQA } = require('../utils/resumeMatcher');
const { convertResultToUTC, fromUTCString } = require('../utils/datetimeUtils');

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

// Configure multer for file uploads
// const getUploadDir = () => {
//   // Check if running on Netlify (serverless environment)
//   if (process.env.NETLIFY || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.VERCEL) {
//     return '/tmp';
//   }
//   return path.join(__dirname, '../uploads/resumes');
// };

const getUploadDir = () => {
  // Check if running on Netlify (serverless environment)
  if (process.env.NETLIFY || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.VERCEL) {
    return '/tmp';
  }
  // Use system temp directory with a subdirectory for organization
  return path.join(os.tmpdir(), 'ats_uploads', 'resumes');
};

const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    const uploadDir = getUploadDir();
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
    cb(null, `eval_${uniqueSuffix}${originalExt}`);
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

// Error handler for multer
const handleMulterError = (err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({
        success: false,
        error: 'File too large. Maximum file size is 10MB.'
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

    // Parse JSON fields safely and convert datetime to UTC
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
      return convertResultToUTC(parsed);
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

router.post('/evaluate-with-qa',  upload.single('resume'), handleMulterError, async (req, res) => {
  const startTime = Date.now();
  console.log('\n========== EVALUATION WITH Q&A STARTED ==========');
  console.log(`Timestamp: ${new Date().toISOString()}`);
  
  let filePath = null;
  
  try {
    // Validate required fields
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: 'Resume file is required'
      });
    }

    const { job_description, question_answers } = req.body;

    if (!job_description) {
      // Clean up file on error
      if (req.file) {
        try {
          await fs.unlink(req.file.path);
        } catch (e) {
          // Ignore cleanup errors
        }
      }
      return res.status(400).json({
        success: false,
        error: 'Job description is required'
      });
    }

    // Parse question_answers JSON if provided
    let questionAnswers = {};
    if (question_answers) {
      try {
        questionAnswers = typeof question_answers === 'string' 
          ? JSON.parse(question_answers) 
          : question_answers;
      } catch (parseError) {
        console.error('Error parsing question_answers:', parseError);
        // Clean up file on error
        if (req.file) {
          try {
            await fs.unlink(req.file.path);
          } catch (e) {
            // Ignore cleanup errors
          }
        }
        return res.status(400).json({
          success: false,
          error: 'Invalid question_answers JSON format'
        });
      }
    }

    filePath = req.file.path;
    const fileName = req.file.originalname;
    const mimetype = req.file.mimetype;

    console.log(`📄 Processing resume: ${fileName}`);
    console.log(`📝 Job description length: ${job_description.length} characters`);
    console.log(`❓ Q&A responses: ${Object.keys(questionAnswers).length} questions`);

    // Extract text from file
    console.log(`   📄 Extracting text from file...`);
    const resumeText = await extractTextFromFile(filePath, mimetype);
    console.log(`   ✅ Text extracted (${resumeText.length} characters)`);

    // Parse resume with Groq
    console.log(`   🤖 Parsing resume with Groq AI...`);
    const parsedData = await parseResumeWithGemini(resumeText, fileName);
    console.log(`   ✅ Resume parsed - Name: ${parsedData.name || 'N/A'}, Email: ${parsedData.email || 'N/A'}`);

    // Match resume with job description and Q&A
    console.log(`   🎯 Matching resume with job description and Q&A...`);
    const matchResults = await matchResumeWithJobDescriptionAndQA(
      resumeText,
      job_description,
      parsedData,
      questionAnswers
    );

    console.log(`   📊 Match scores - Overall: ${matchResults.overall_match}%, Skills: ${matchResults.skills_match}%, Experience: ${matchResults.experience_match}%, Education: ${matchResults.education_match}%`);

    // Clean up uploaded file
    try {
      await fs.unlink(filePath);
      console.log(`   🗑️  Cleaned up temporary file: ${filePath}`);
    } catch (cleanupError) {
      console.warn(`   ⚠️  Could not clean up file: ${cleanupError.message}`);
    }

    const totalTime = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`✅ SUCCESS - Evaluation completed in ${totalTime}s`);
    console.log(`==========================================\n`);

    // Return the same format as matchResumeWithJobDescription with additional candidate information
    res.json({
      success: true,
      data: {
        overall_match: matchResults.overall_match,
        skills_match: matchResults.skills_match,
        skills_details: matchResults.skills_details,
        experience_match: matchResults.experience_match,
        experience_details: matchResults.experience_details,
        education_match: matchResults.education_match,
        education_details: matchResults.education_details,
        status: matchResults.status,
        rejection_reason: matchResults.rejection_reason || null,
        skills: safeParseJSON(parsedData.skills, []),
        experience: safeParseJSON(parsedData.experience, []),
        education: safeParseJSON(parsedData.education, []),
        certifications: safeParseJSON(parsedData.certifications, []),
        candidate_info: {
          First_Name: parsedData.First_Name || '',
          Last_Name: parsedData.Last_Name || '',
          Email: parsedData.Email || parsedData.email || '',
          Mobile_Number: parsedData.Mobile_Number || parsedData.phone || '',
          Date_Of_Birth: parsedData.Date_Of_Birth || ''
        }
      }
    });
  } catch (error) {
    // Clean up file on error
    if (filePath) {
      try {
        await fs.unlink(filePath);
        console.log(`🗑️  Cleaned up file on error: ${filePath}`);
      } catch (e) {
        // Ignore cleanup errors
      }
    }

    const totalTime = ((Date.now() - startTime) / 1000).toFixed(2);
    console.error(`\n❌ EVALUATION FAILED after ${totalTime}s`);
    console.error('Error:', error.message);
    console.error('Stack:', error.stack);
    console.log(`==========================================\n`);
    
    res.status(500).json({
      success: false,
      error: 'Failed to evaluate resume',
      message: error.message
    });
  }
});

// Get evaluation by ID (all authenticated users can view)
router.get('/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    console.log(`📋 Fetching evaluation ID: ${id} for user: ${req.user.email}`);
  

    //change id with resume_id 
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
      WHERE ce.resume_id = ?`,
      [id]
    );

    if (!evaluation) {
      return res.status(200).json({ error: 'Evaluation not found' });
    }

    // Visibility check: Interviewers can only see their assigned candidates
    if (req.user.role === 'Interviewer') {
      const hasAccess = await queryOne(
        'SELECT 1 FROM interview_details WHERE candidate_evaluations_id = ? AND interviewer_id COLLATE utf8mb4_unicode_ci = ? COLLATE utf8mb4_unicode_ci',
        [evaluation.id, req.user.id]
      );
      if (!hasAccess) {
        return res.status(200).json({
          success: false,
          error: 'Access denied. This candidate is not assigned to you.'
        });
      }
    }

    // Get interview details for this evaluation
    const interviewDetails = await query(
      `SELECT 
        id.id,
        id.interviewer_id,
        id.interviewer_time_slots_id,
        id.interviewer_status,
        id.interviewer_feedback,
        id.interviewer_hold_reason,
        its.start_time as interview_date,
        its.end_time as interview_end_time,
        JSON_OBJECT(
          'id', u.id,
          'email', u.email,
          'full_name', u.full_name
        ) as interviewer
      FROM interview_details id
      INNER JOIN interviewer_time_slots its ON id.interviewer_time_slots_id = its.id
      LEFT JOIN users u ON id.interviewer_id COLLATE utf8mb4_unicode_ci = u.id COLLATE utf8mb4_unicode_ci
      WHERE id.candidate_evaluations_id = ?
      ORDER BY its.start_time ASC`,
      [evaluation.id]
    );

    // Parse interview details
    const parsedInterviewDetails = interviewDetails.map(detail => ({
      ...detail,
      interviewer: detail.interviewer ? JSON.parse(detail.interviewer) : null,
      interviewer_feedback: detail.interviewer_feedback ? JSON.parse(detail.interviewer_feedback) : null
    }));

    // Parse JSON fields
    const parsedEvaluation = {
      ...evaluation,
      resume: safeParseJSON(evaluation.resume, null),
      job_description: safeParseJSON(evaluation.job_description, null),
      interview_details: convertResultToUTC(parsedInterviewDetails)
    };

    // Parse nested JSON in resume
    if (parsedEvaluation.resume) {
      parsedEvaluation.resume.skills = safeParseJSON(parsedEvaluation.resume.skills, []);
      parsedEvaluation.resume.experience = safeParseJSON(parsedEvaluation.resume.experience, []);
      parsedEvaluation.resume.education = safeParseJSON(parsedEvaluation.resume.education, []);
    }
    
    // Convert datetime fields to UTC
    const convertedEvaluation = convertResultToUTC(parsedEvaluation);
    
    console.log('Fetched evaluation:', {
      id: parsedEvaluation.id,
      resume_id: parsedEvaluation.resume_id,
      has_resume: !!parsedEvaluation.resume,
      has_job_description: !!parsedEvaluation.job_description
    });

    res.json({
      success: true,
      data: convertedEvaluation
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
      'SELECT * FROM candidate_evaluations WHERE id = ?',
      [id]
    );

    if (!evaluation) {
      return res.status(404).json({
        success: false,
        error: 'Evaluation not found'
      });
    }

    // Check if interviewer is assigned via interview_details
    const interviewDetail = await queryOne(
      'SELECT * FROM interview_details WHERE candidate_evaluations_id = ? AND interviewer_id COLLATE utf8mb4_unicode_ci = ? COLLATE utf8mb4_unicode_ci',
      [id, req.user.id]
    );

    if (!interviewDetail) {
      return res.status(200).json({
        success: false,
        error: 'This candidate is not assigned to you'
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
      // for (const [key, value] of Object.entries(ratings)) {
      //   const numValue = Number(value);
      //   if (isNaN(numValue) || numValue < 1 || numValue > 10) {
      //     return res.status(400).json({
      //       success: false,
      //       error: `Rating "${key}" must be a number between 1 and 10`
      //     });
      //   }
      // }
      feedbackJson = JSON.stringify(ratings);
    }

    // Update interview_details with feedback
    let sql = `UPDATE interview_details 
               SET interviewer_feedback = ?, interviewer_status = ?`;
    const params = [feedbackJson, status];

    if (status === 'on_hold') {
      sql += ', interviewer_hold_reason = ?';
      params.push(hold_reason.trim());
    } else {
      sql += ', interviewer_hold_reason = NULL';
    }

    sql += ' WHERE id = ?';
    params.push(interviewDetail.id);

    await query(sql, params);


    // here we update history table as well as with feedback

    let sqlForHistory = `UPDATE interview_assignments 
               SET interviewer_feedback = ?, interviewer_status = ?`;
    const paramsForHistory = [feedbackJson, status];

    if (status === 'on_hold') {
      sqlForHistory += ', interviewer_hold_reason = ?';
      paramsForHistory.push(hold_reason.trim());
    } else {
      sqlForHistory += ', interviewer_hold_reason = NULL';
    }

    sqlForHistory += ' WHERE evaluation_id = ? AND interviewer_id COLLATE utf8mb4_unicode_ci = ? COLLATE utf8mb4_unicode_ci ORDER BY created_at DESC LIMIT 1';
    paramsForHistory.push(id, req.user.id);

    await query(sqlForHistory, paramsForHistory);

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
    // if (hrAdminEmails.length > 0) {
    //   await sendInterviewFeedbackToHR({
    //     hrAdminEmails,
    //     candidateName: updatedEvaluation.candidate_name || updatedEvaluation.name || 'Candidate',
    //     jobTitle: updatedEvaluation.job_title || 'Position',
    //     interviewerName: req.user.full_name || req.user.email,
    //     status
    //   });
    // }

    // Parse JSON fields
    const parsedEvaluation = {
      ...updatedEvaluation,
      interviewer_feedback: updatedEvaluation.interviewer_feedback 
        ? JSON.parse(updatedEvaluation.interviewer_feedback) 
        : null
    };

    // Convert datetime fields to UTC
    const convertedEvaluation = convertResultToUTC(parsedEvaluation);

    res.json({
      success: true,
      message: 'Interview feedback submitted successfully',
      data: convertedEvaluation
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
    const { hrRemarks, status, reason } = req.body;

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

    // Check if any interviewer selected the candidate (for override validation)
    const interviewDetails = await query(
      'SELECT interviewer_status FROM interview_details WHERE candidate_evaluations_id = ?',
      [id]
    );
    const hasAnyInterviewerSelected = interviewDetails.some(id => id.interviewer_status === 'selected');

    // Validate reason:
    // 1. Required for rejected or on_hold
    // 2. Required for selected if no interviewer selected (override case)
    const requiresReason = 
      status === 'rejected' || 
      status === 'on_hold' ||
      (status === 'selected' && !hasAnyInterviewerSelected);

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
    let sql = `UPDATE candidate_evaluations SET hr_final_status = ? , hr_remarks = ?`;
    const params = [status , hrRemarks];

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

        // here we update history table as well as with feedback

    let sqlForHistory = `UPDATE interview_assignments 
               SET hr_final_status = ? , hr_remarks = ?`;
    const paramsForHistory =  [status , hrRemarks];

    if (status === 'on_hold') {
      sqlForHistory += ', hr_final_reason = ?';
      paramsForHistory.push(hold_reason.trim());
    } else {
        sqlForHistory += ', hr_final_reason = NULL';
    }

    sqlForHistory += ' WHERE evaluation_id = ? order by created_at desc limit 1';
    paramsForHistory.push(id);

    await query(sqlForHistory, paramsForHistory);

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

    // Convert datetime fields to UTC
    const convertedEvaluation = convertResultToUTC(parsedEvaluation);

    res.json({
      success: true,
      message: 'Final decision updated successfully',
      data: convertedEvaluation
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
    const { interviewer_status, status, sort_by } = req.query;

//     let sql = `
//       SELECT 
//         ce.*,
//         (
//   SELECT COUNT(*)
//   FROM resumes r3
//   WHERE r3.parent_id = r.parent_id
//      OR r3.id = r.parent_id
//      OR r3.id = r.id
// ) AS total_versions
//         JSON_OBJECT(
//           'id', r.id,
//           'name', r.name,
//           'email', r.email,
//           'phone', r.phone,
//           'file_name', r.file_name,
//           'location', r.location,
//           'total_experience', r.total_experience,
//           'parent_id', r.parent_id,
//           'version_number', r.version_number,
//           'created_at', r.created_at
//         ) as resume,
//         JSON_OBJECT(
//           'id', u.id,
//           'email', u.email,
//           'full_name', u.full_name
//         ) as interviewer
//       FROM candidate_evaluations ce
//       LEFT JOIN resumes r ON ce.resume_id = r.id
//       LEFT JOIN users u ON ce.interviewer_id = u.id
//       WHERE ce.job_description_id = ?
//     `;
  let sql = `
  SELECT 
    ce.*,
  (
  SELECT COUNT(*)
  FROM resumes r3
  WHERE
    (
      r.parent_id IS NULL
      AND (r3.id = r.id OR r3.parent_id = r.id)
    )
    OR
    (
      r.parent_id IS NOT NULL
      AND (r3.id = r.parent_id OR r3.parent_id = r.parent_id)
    )
) AS total_versions,
    JSON_OBJECT(
      'id', r.id,
      'name', r.name,
      'email', r.email,
      'phone', r.phone,
      'file_name', r.file_name,
      'location', r.location,
      'total_experience', r.total_experience,
      'parent_id', r.parent_id,
      'version_number', r.version_number,
      'created_at', r.created_at
    ) AS resume

  FROM candidate_evaluations ce
LEFT JOIN resumes r ON ce.resume_id = r.id
Left JOIN interview_details id ON id.candidate_evaluations_id = ce.id
  WHERE ce.job_description_id = ?
`;

const params = [job_description_id];

    // Visibility rules: Interviewers can only see their assigned candidates
if (req.user.role === 'Interviewer') {
  sql += `
    AND EXISTS (
      SELECT 1
      FROM interview_details id
      WHERE id.candidate_evaluations_id = ce.id
        AND id.interviewer_id COLLATE utf8mb4_unicode_ci = ? COLLATE utf8mb4_unicode_ci
    )
  `;
  params.push(req.user.id);
}



    
    // Status filtering - check all status fields
    if (interviewer_status) {
      if (interviewer_status === 'selected') {
        sql += ' AND (id.interviewer_status = ? OR ce.hr_final_status = ?)';
        params.push('selected', 'selected');
      } else if (interviewer_status === 'rejected') {
        sql += ' AND (id.interviewer_status = ? OR ce.hr_final_status = ?)';
        params.push('rejected', 'rejected');
      } else if (interviewer_status === 'on_hold') {
        sql += ' AND (id.interviewer_status = ? OR ce.hr_final_status = ?)';
        params.push('on_hold', 'on_hold');
      } else {
        sql += ' AND (ce.status = ? OR id.interviewer_status = ? OR ce.hr_final_status = ?)';
        params.push(interviewer_status, interviewer_status, interviewer_status);
      }
    }

        if (status) {
   
        sql += ' AND (ce.status = ?)';
        params.push(status );
      
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
      return convertResultToUTC(parsed);
    });
    const isInterviewer = req.user.role === 'Interviewer';
const interviewerId = req.user.id;

    // Process evaluations with version information
    // Group by email/name to find all versions and select the latest one
    const versionGroups = new Map();
    
    // First pass: group evaluations by email/name to find all versions
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
        if (!versionGroups.has(groupKey)) {
          versionGroups.set(groupKey, []);
        }
        versionGroups.get(groupKey).push(eval);
      }
    }

    // Second pass: for each group, find the latest version and only include that one
    const processedEvaluations = [];
    const processedKeys = new Set();
    
    for (const eval of parsedEvaluations) {
      const email = eval.email?.toLowerCase().trim() || eval.resume?.email?.toLowerCase().trim();
      const name = eval.candidate_name?.toLowerCase().trim() || eval.resume?.name?.toLowerCase().trim();
      
      let groupKey = null;
      if (email) {
        groupKey = `email:${email}`;
      } else if (name) {
        groupKey = `name:${name}`;
      }

      if (groupKey && !processedKeys.has(groupKey)) {
        const group = versionGroups.get(groupKey);
        
        if (group && group.length > 1) {
          // Multiple versions exist - find the latest one
          // Sort by resume version_number DESC, then by resume created_at DESC
          const sortedGroup = [...group].sort((a, b) => {
            const versionA = a.resume?.version_number || 1;
            const versionB = b.resume?.version_number || 1;
            if (versionB !== versionA) {
             return versionB - versionA; // Higher version first
              // return versionA - versionB; // Higher version first
            }
            // If versions are equal, sort by resume created_at DESC (using UTC)
            const resumeDateA = fromUTCString(a.resume?.created_at || a.created_at) || new Date(0);
            const resumeDateB = fromUTCString(b.resume?.created_at || b.created_at) || new Date(0);
            return resumeDateB - resumeDateA;
            // return resumeDateA - resumeDateB;
          });
          
          const latestEval = sortedGroup[0];
          const versionNumber = latestEval.resume?.version_number || 1;
          const parentId = latestEval.resume?.parent_id;
          const isVersion = !!parentId;
          const totalVersions = group.length;

          processedEvaluations.push({
            ...latestEval,
            isDuplicate: true,
            isVersion: isVersion,
            versionNumber: versionNumber,
            parentId: parentId,
             totalVersions: latestEval.total_versions,
            duplicateCount: latestEval.total_versions - 1
            // totalVersions: totalVersions,
            // duplicateCount: totalVersions - 1
          });
        }
//         if (group && group.length > 1) {

//   let selectedEval;

//   if (isInterviewer) {
//     // interviewer ke liye: usko assigned record hi lo
//     const interviewerAssigned = group.filter(
//       g => g.interviewer_id === interviewerId
//     );

//     if (interviewerAssigned.length > 0) {
//       // agar multiple assigned ho to unme se latest
//       selectedEval = interviewerAssigned.sort((a, b) => {
//         const versionA = a.resume?.version_number || 1;
//         const versionB = b.resume?.version_number || 1;
//         return versionB - versionA;
//       })[0];
//     } else {
//       // interviewer ka koi record nahi → skip
//       processedKeys.add(groupKey);
//       continue;
//     }

//   } else {
//     // HR / Admin → global latest
//     selectedEval = [...group].sort((a, b) => {
//       const versionA = a.resume?.version_number || 1;
//       const versionB = b.resume?.version_number || 1;
//       if (versionB !== versionA) return versionB - versionA;

//       const resumeDateA = new Date(a.resume?.created_at || a.created_at || 0);
//       const resumeDateB = new Date(b.resume?.created_at || b.created_at || 0);
//       return resumeDateB - resumeDateA;
//     })[0];
//   }

//   processedEvaluations.push({
//     ...selectedEval,
//     isDuplicate: true,
//     isVersion: !!selectedEval.resume?.parent_id,
//     versionNumber: selectedEval.resume?.version_number || 1,
//     parentId: selectedEval.resume?.parent_id || null,
    
//     // totalVersions: group.length,
//     // duplicateCount: group.length - 1
//       totalVersions: selectedEval.total_versions,
//   duplicateCount: selectedEval.total_versions - 1
//   });
// }


         else if (group && group.length === 1) {
          // Only one version
          const eval = group[0];
          processedEvaluations.push({
            ...eval,
            isDuplicate: false,
            isVersion: false,
            versionNumber: eval.resume?.version_number || 1,
            parentId: eval.resume?.parent_id || null,
            totalVersions: 1,
            duplicateCount: 0
          });
        }
        
        processedKeys.add(groupKey);
      } else if (!groupKey && !processedKeys.has(`unique_${eval.id}`)) {
        // No email or name, treat as unique
        processedEvaluations.push({
          ...eval,
          isDuplicate: false,
          isVersion: false,
          versionNumber: eval.resume?.version_number || 1,
          parentId: eval.resume?.parent_id || null,
          totalVersions: 1,
          duplicateCount: 0
        });
        processedKeys.add(`unique_${eval.id}`);
      }
    }

    // Fetch interview_details for all evaluations
    const evaluationIds = processedEvaluations.map(e => e.id);
    let interviewDetailsMap = new Map();
    
    if (evaluationIds.length > 0) {
      const placeholders = evaluationIds.map(() => '?').join(',');
      const interviewDetails = await query(
        `SELECT 
          id.id,
          id.candidate_evaluations_id,
          id.interviewer_id,
          id.interviewer_time_slots_id,
          id.interviewer_status,
          id.interviewer_feedback,
          id.interviewer_hold_reason,
          its.start_time as interview_date,
          its.end_time as interview_end_time,
          JSON_OBJECT(
            'id', u.id,
            'email', u.email,
            'full_name', u.full_name
          ) as interviewer
        FROM interview_details id
        INNER JOIN interviewer_time_slots its ON id.interviewer_time_slots_id = its.id
        LEFT JOIN users u ON id.interviewer_id COLLATE utf8mb4_unicode_ci = u.id COLLATE utf8mb4_unicode_ci
        WHERE id.candidate_evaluations_id IN (${placeholders})
        ORDER BY its.start_time ASC`,
        evaluationIds
      );

      // Group interview details by evaluation_id
      interviewDetails.forEach(detail => {
        const evalId = detail.candidate_evaluations_id;
        if (!interviewDetailsMap.has(evalId)) {
          interviewDetailsMap.set(evalId, []);
        }
        const parsed = {
          id: detail.id,
          interviewer_id: detail.interviewer_id,
          interviewer_time_slots_id: detail.interviewer_time_slots_id,
          interviewer_status: detail.interviewer_status,
          interviewer_feedback: detail.interviewer_feedback ? JSON.parse(detail.interviewer_feedback) : null,
          interviewer_hold_reason: detail.interviewer_hold_reason,
          interview_date: detail.interview_date,
          interview_end_time: detail.interview_end_time,
          interviewer: detail.interviewer ? JSON.parse(detail.interviewer) : null
        };
        interviewDetailsMap.get(evalId).push(convertResultToUTC(parsed));
      });
    }

    // Attach interview_details to each evaluation
    const finalEvaluations = processedEvaluations.map(eval => ({
      ...eval,
      interview_details: interviewDetailsMap.get(eval.id) || [],
      // Keep backward compatibility: set interviewer and interview_date from first interview_detail if exists
      interviewer: interviewDetailsMap.get(eval.id)?.[0]?.interviewer || null,
      interview_date: interviewDetailsMap.get(eval.id)?.[0]?.interview_date || null,
      interviewer_id: interviewDetailsMap.get(eval.id)?.[0]?.interviewer_id || null,
      interviewer_status: interviewDetailsMap.get(eval.id)?.[0]?.interviewer_status || null,
      interviewer_feedback: interviewDetailsMap.get(eval.id)?.[0]?.interviewer_feedback || null,
      interviewer_hold_reason: interviewDetailsMap.get(eval.id)?.[0]?.interviewer_hold_reason || null
    }));

    res.json({
      success: true,
      count: finalEvaluations.length,
      data: finalEvaluations
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
// router.get('/:id/timeline', authenticate, async (req, res) => {
//   try {
//     const { id } = req.params;

//     // Get evaluation
//     const evaluation = await queryOne(
//       'SELECT * FROM candidate_evaluations WHERE id = ?',
//       [id]
//     );

//     if (!evaluation) {
//       return res.status(404).json({
//         success: false,
//         error: 'Evaluation not found'
//       });
//     }

//     // Visibility check: Interviewers can only see their assigned candidates
//     if (req.user.role === 'Interviewer' && evaluation.interviewer_id !== req.user.id) {
//       return res.status(403).json({
//         success: false,
//         error: 'Access denied. This candidate is not assigned to you.'
//       });
//     }

//     const timeline = [];

//     // 1. Resume uploaded / Evaluation created
//     timeline.push({
//       type: 'resume_uploaded',
//       title: 'Resume Uploaded',
//       description: 'Candidate resume was uploaded and evaluated',
//       timestamp: evaluation.created_at,
//       user: null,
//       details: {
//         overall_match: evaluation.overall_match,
//         skills_match: evaluation.skills_match,
//         experience_match: evaluation.experience_match,
//         education_match: evaluation.education_match
//       }
//     });

//     // 2. Get interview assignment history
//     const assignments = await query(
//       `SELECT ia.*,
//         JSON_OBJECT(
//           'id', u1.id,
//           'email', u1.email,
//           'full_name', u1.full_name
//         ) as interviewer,
//         JSON_OBJECT(
//           'id', u2.id,
//           'email', u2.email,
//           'full_name', u2.full_name
//         ) as assigned_by_user
//        FROM interview_assignments ia
//        LEFT JOIN users u1 ON ia.interviewer_id = u1.id
//        LEFT JOIN users u2 ON ia.assigned_by = u2.id
//        WHERE ia.evaluation_id = ?
//        ORDER BY ia.created_at ASC`,
//       [id]
//     );

//     assignments.forEach(assignment => {
//       const interviewer = assignment.interviewer ? JSON.parse(assignment.interviewer) : null;
//       const assignedBy = assignment.assigned_by_user ? JSON.parse(assignment.assigned_by_user) : null;
      
//       timeline.push({
//         type: assignment.notes === 'Reassigned' ? 'interviewer_reassigned' : 'interviewer_assigned',
//         title: assignment.notes === 'Reassigned' ? 'Interviewer Reassigned' : 'Interviewer Assigned',
//         description: assignment.notes === 'Reassigned' 
//           ? `Interview reassigned to ${interviewer?.full_name || interviewer?.email || 'Interviewer'}`
//           : `Assigned to ${interviewer?.full_name || interviewer?.email || 'Interviewer'}`,
//         timestamp: assignment.created_at,
//         user: assignedBy,
//         details: {
//           interviewer: interviewer,
//           interview_date: assignment.interview_date,
//           notes: assignment.notes
//         }
//       });

//       // Interview scheduled event
//       timeline.push({
//         type: 'interview_scheduled',
//         title: 'Interview Scheduled',
//         description: `Interview scheduled for ${fromUTCString(assignment.interview_date) ? fromUTCString(assignment.interview_date).toLocaleString('en-US', {
//           year: 'numeric',
//           month: 'long',
//           day: 'numeric',
//           hour: '2-digit',
//           minute: '2-digit'
//         }) : 'N/A'}`,
//         timestamp: assignment.interview_date,
//         user: null,
//         details: {
//           interviewer: interviewer,
//           interview_date: assignment.interview_date
//         }
//       });
//     });

//     // 3. Interviewer feedback submitted
//     if (evaluation.interviewer_status && evaluation.interviewer_status !== 'pending') {
//       const interviewer = await queryOne(
//         'SELECT id, email, full_name FROM users WHERE id = ?',
//         [evaluation.interviewer_id]
//       );

//       const feedback = evaluation.interviewer_feedback ? JSON.parse(evaluation.interviewer_feedback) : null;

//       timeline.push({
//         type: 'feedback_submitted',
//         title: 'Interview Feedback Submitted',
//         description: `Interviewer decision: ${evaluation.interviewer_status}`,
//         timestamp: evaluation.updated_at,
//         user: interviewer,
//         details: {
//           status: evaluation.interviewer_status,
//           ratings: feedback,
//           hold_reason: evaluation.interviewer_hold_reason
//         }
//       });
//     }

//     // 4. HR final decision
//     if (evaluation.hr_final_status && evaluation.hr_final_status !== 'pending') {
//       // Get who made the decision (we'll use updated_at to determine, but ideally we'd track this)
//       timeline.push({
//         type: 'hr_decision',
//         title: 'HR Final Decision',
//         description: `Final decision: ${evaluation.hr_final_status}`,
//         timestamp: evaluation.updated_at,
//         user: null, // Could be enhanced to track who made the decision
//         details: {
//           status: evaluation.hr_final_status,
//           reason: evaluation.hr_final_reason,
//           hr_remarks : evaluation.hr_remarks
//         }
//       });
//     }

//     // Sort timeline by timestamp (using UTC)
//     timeline.sort((a, b) => {
//       const dateA = fromUTCString(a.timestamp) || new Date(0);
//       const dateB = fromUTCString(b.timestamp) || new Date(0);
//       return dateA - dateB;
//     });
    
//     // Convert timeline timestamps to UTC ISO strings
//     timeline.forEach(item => {
//       if (item.timestamp) {
//         const dateObj = fromUTCString(item.timestamp);
//         if (dateObj) {
//           item.timestamp = dateObj.toISOString();
//         }
//       }
//     });

//     res.json({
//       success: true,
//       data: timeline
//     });
//   } catch (error) {
//     console.error('Error fetching timeline:', error);
//     res.status(500).json({
//       success: false,
//       error: 'Failed to fetch timeline',
//       message: error.message
//     });
//   }
// });

//new timeline api based on resume id perviosuly it was handle by evaluations
router.get('/:id/timeline', authenticate, async (req, res) => {
  try {
    const { id } = req.params;

    // Get evaluation
    const evaluation = await queryOne(
      'SELECT * FROM candidate_evaluations WHERE resume_id = ?',
      [id]
    );

    if (!evaluation) {
      return res.status(404).json({
        success: false,
        error: 'Evaluation not found'
      });
    }

    // Visibility check: Interviewers can only see their assigned candidates
    if (req.user.role === 'Interviewer') {
      const hasAccess = await queryOne(
        'SELECT 1 FROM interview_details WHERE candidate_evaluations_id = ? AND interviewer_id COLLATE utf8mb4_unicode_ci = ? COLLATE utf8mb4_unicode_ci',
        [evaluation.id, req.user.id]
      );
      if (!hasAccess) {
        return res.status(200).json({
          success: false,
          error: 'Access denied. This candidate is not assigned to you.'
        });
      }
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
      `select ia.* ,
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
from candidate_evaluations ce
 inner join interview_assignments ia
   LEFT JOIN users u1 ON ia.interviewer_id COLLATE utf8mb4_unicode_ci = u1.id COLLATE utf8mb4_unicode_ci
       LEFT JOIN users u2 ON ia.assigned_by COLLATE utf8mb4_unicode_ci = u2.id COLLATE utf8mb4_unicode_ci
 on ce.id = ia.evaluation_id
 where ce.resume_id = ?`,
 [id]
    )

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

      // Note: Interview scheduled events are now handled by interview_details section below
      // to avoid duplicates and use the current source of truth

      // Note: Interviewer feedback events are now handled by interview_details section below
      // to avoid duplicates and use the current source of truth (interview_details has the actual interviewer, not the assigner)

        if (assignment.hr_final_status && assignment.hr_final_status !== 'pending') {
              timeline.push({
        type: 'hr_decision',
        title: 'HR Final Decision',
        description: `Final decision: ${assignment.hr_final_status}`,
        timestamp: assignment.updated_at,
        user: null, // Could be enhanced to track who made the decision
        details: {
          status: assignment.hr_final_status,
          reason: assignment.hr_final_reason,
          hr_remarks : assignment.hr_remarks
        }
      });
        }
    });

    // 3. Get current interview details (multiple interviewers support)
    const interviewDetails = await query(
      `SELECT 
        id.id,
        id.interviewer_status,
        id.interviewer_feedback,
        id.interviewer_hold_reason,
        its.start_time as interview_date,
        its.end_time as interview_end_time,
        COALESCE(
          (SELECT MAX(ia.updated_at) 
           FROM interview_assignments ia 
           WHERE ia.evaluation_id = id.candidate_evaluations_id 
             AND ia.interviewer_id COLLATE utf8mb4_unicode_ci = id.interviewer_id COLLATE utf8mb4_unicode_ci
             AND ia.interviewer_status IS NOT NULL
           LIMIT 1),
          its.start_time
        ) as feedback_timestamp,
        JSON_OBJECT(
          'id', u.id,
          'email', u.email,
          'full_name', u.full_name
        ) as interviewer
      FROM interview_details id
      INNER JOIN interviewer_time_slots its ON id.interviewer_time_slots_id = its.id
      LEFT JOIN users u ON id.interviewer_id COLLATE utf8mb4_unicode_ci = u.id COLLATE utf8mb4_unicode_ci
      WHERE id.candidate_evaluations_id = ?
      ORDER BY its.start_time ASC`,
      [evaluation.id]
    );

    interviewDetails.forEach(detail => {
      const interviewer = detail.interviewer ? JSON.parse(detail.interviewer) : null;
      const interviewDate = detail.interview_date;

      // Add interview scheduled event if not already in timeline
      const alreadyScheduled = timeline.some(item => 
        item.type === 'interview_scheduled' && 
        item.details?.interviewer?.id === interviewer?.id &&
        item.timestamp === interviewDate
      );

      if (!alreadyScheduled && interviewDate) {
        timeline.push({
          type: 'interview_scheduled',
          title: 'Interview Scheduled',
          description: `Interview scheduled with ${interviewer?.full_name || interviewer?.email || 'Interviewer'} for ${fromUTCString(interviewDate) ? fromUTCString(interviewDate).toLocaleString('en-IN', {
            timeZone:'Asia/Kolkata',
            year: 'numeric',
            month: 'long',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
          } ) : 'N/A'} (IST)`,
          timestamp: interviewDate,
          user: null,
          details: {
            interviewer: interviewer,
            interview_date: interviewDate,
            interview_details_id: detail.id
          }
        });
      }

      // Add feedback if submitted
      if (detail.interviewer_status && detail.interviewer_status !== 'pending') {
        const feedback = detail.interviewer_feedback ? JSON.parse(detail.interviewer_feedback) : null;
        // Use feedback_timestamp (from interview_assignments.updated_at) if available, otherwise use interview_date
        const feedbackTimestamp = detail.feedback_timestamp || detail.interview_date;
        
        timeline.push({
          type: 'feedback_submitted',
          title: 'Interview Feedback Submitted',
          description: `Feedback from ${interviewer?.full_name || interviewer?.email || 'Interviewer'}: ${detail.interviewer_status}`,
          timestamp: feedbackTimestamp,
          user: interviewer,
          details: {
            interviewer: interviewer,
            status: detail.interviewer_status,
            ratings: feedback,
            hold_reason: detail.interviewer_hold_reason,
            interview_details_id: detail.id
          }
        });
      }
    });

   
    // if (evaluation.interviewer_status && evaluation.interviewer_status !== 'pending') {
    //   const interviewer = await queryOne(
    //     'SELECT id, email, full_name FROM users WHERE id = ?',
    //     [evaluation.interviewer_id]
    //   );

    //   const feedback = evaluation.interviewer_feedback ? JSON.parse(evaluation.interviewer_feedback) : null;

    //   timeline.push({
    //     type: 'feedback_submitted',
    //     title: 'Interview Feedback Submitted',
    //     description: `Interviewer decision: ${evaluation.interviewer_status}`,
    //     timestamp: evaluation.updated_at,
    //     user: interviewer,
    //     details: {
    //       status: evaluation.interviewer_status,
    //       ratings: feedback,
    //       hold_reason: evaluation.interviewer_hold_reason
    //     }
    //   });
    // }

    // 4. HR final decision
    // if (evaluation.hr_final_status && evaluation.hr_final_status !== 'pending') {
     
    //   timeline.push({
    //     type: 'hr_decision',
    //     title: 'HR Final Decision',
    //     description: `Final decision: ${evaluation.hr_final_status}`,
    //     timestamp: evaluation.updated_at,
    //     user: null, // Could be enhanced to track who made the decision
    //     details: {
    //       status: evaluation.hr_final_status,
    //       reason: evaluation.hr_final_reason,
    //       hr_remarks : evaluation.hr_remarks
    //     }
    //   });
    // }

    // Sort timeline by timestamp (using UTC)
    timeline.sort((a, b) => {
      const dateA = fromUTCString(a.timestamp) || new Date(0);
      const dateB = fromUTCString(b.timestamp) || new Date(0);
      return dateA - dateB;
    });
    
    // Convert timeline timestamps to UTC ISO strings
    timeline.forEach(item => {
      if (item.timestamp) {
        const dateObj = fromUTCString(item.timestamp);
        if (dateObj) {
          item.timestamp = dateObj.toISOString();
        }
      }
    });

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
