const express = require('express');
const crypto = require('crypto');
const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;
const { query, queryOne } = require('../config/database');
const { generateQuestionsFromJD } = require('../utils/questionGenerator');
const { extractTextFromFile, parseResumeWithGemini } = require('../utils/resumeParser');
const { matchResumeWithJobDescriptionAndQA } = require('../utils/resumeMatcher');
const { hasRecentApplication } = require('../utils/applicationValidator');
const { findOriginalResume, getNextVersionNumber } = require('../utils/duplicateChecker');
const { sendEmail, sendInterviewAssignmentToInterviewer, sendInterviewAssignmentToCandidate } = require('../utils/emailService');

const router = express.Router();

// Multer storage for candidate resume uploads (public, no auth)
const getUploadDir = () => {
  if (process.env.NETLIFY || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.VERCEL) {
    return '/tmp';
  }
  return path.join(__dirname, '../uploads/resumes');
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
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    const originalExt = path.extname(file.originalname);
    cb(null, `candidate_${uniqueSuffix}${originalExt}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
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

// HR/Admin creates a candidate link for a job description
// Now returns existing link if one exists for the job post (one link per job post)
router.post('/generate', async (req, res) => {
  try {
    const { job_description_id, candidate_name, candidate_email, expires_in_days } = req.body;

    if (!job_description_id) {
      return res.status(400).json({
        success: false,
        error: 'job_description_id is required'
      });
    }

    const job = await queryOne(
      'SELECT * FROM job_descriptions WHERE id = ?',
      [job_description_id]
    );

    if (!job) {
      return res.status(404).json({
        success: false,
        error: 'Job description not found'
      });
    }

    // Check if a link already exists for this job post (one link per job post)
    const existingLink = await queryOne(
      'SELECT * FROM candidate_links WHERE job_description_id = ? AND status != "expired" ORDER BY created_at DESC LIMIT 1',
      [job_description_id]
    );

    if (existingLink) {
      // Return existing link
      const frontendBaseUrl = process.env.FRONTEND_BASE_URL || process.env.APP_BASE_URL || '';
      const candidateUrl = frontendBaseUrl
        ? `${frontendBaseUrl.replace(/\/$/, '')}/candidate/${existingLink.token}`
        : `/candidate/${existingLink.token}`;

      let questions = [];
      if (existingLink.questions) {
        try {
          const parsed = JSON.parse(existingLink.questions);
          if (Array.isArray(parsed)) {
            questions = parsed;
          }
        } catch (e) {
          console.error('Error parsing existing link questions:', e);
        }
      }

      return res.json({
        success: true,
        message: 'Existing candidate link retrieved',
        data: {
          id: existingLink.id,
          token: existingLink.token,
          url: candidateUrl,
          questions: questions
        }
      });
    }

    // No existing link found, create a new one
    const fullJobDescription = `${job.title}\n\n${job.description}\n\n${job.requirements || ''}`;

    // Generate questions using existing utility
    let flatQuestions = [];

    try {
      const questionsData = await generateQuestionsFromJD(fullJobDescription, {
        title: job.title,
        seniority: null,
        yearsOfExperience: null
      });

      // Flatten questions into a simple array of question texts for the candidate UI
      if (questionsData && Array.isArray(questionsData.categories)) {
        questionsData.categories.forEach(cat => {
          if (cat && Array.isArray(cat.questions)) {
            cat.questions.forEach(q => {
              const text = q?.text || q?.question || null;
              if (text && typeof text === 'string') {
                flatQuestions.push(text.trim());
              }
            });
          }
        });
      }
    } catch (genError) {
      console.error('Error generating questions from JD, using fallback questions:', genError);
      flatQuestions = [];
    }

    // Fallback: if Gemini or parsing fails, still provide some basic JD-based questions
    if (!flatQuestions || flatQuestions.length === 0) {
      flatQuestions = [
        'Total overall professional experience (in years)',
        `Total experience in key technologies mentioned for ${job.title} (in years)`,
        'Primary programming languages you have worked with (list with years of experience for each)',
        'Databases you have used in production (list with years of experience)',
        'Briefly describe your most relevant project for this role'
      ];
    }

    const token = crypto.randomBytes(24).toString('hex');
    let expiresAt = null;
    if (expires_in_days) {
      const days = parseInt(expires_in_days, 10);
      if (!isNaN(days) && days > 0) {
        const now = new Date();
        now.setDate(now.getDate() + days);
        expiresAt = now.toISOString().slice(0, 19).replace('T', ' ');
      }
    }

    const result = await query(
      `INSERT INTO candidate_links (
        token, job_description_id, candidate_name, candidate_email, status, questions, expires_at
      ) VALUES (?, ?, ?, ?, 'pending', ?, ?)` ,
      [
        token,
        job_description_id,
        candidate_name || null,
        candidate_email || null,
        JSON.stringify(flatQuestions || []),
        expiresAt
      ]
    );

    const linkId = result.insertId;
    const frontendBaseUrl = process.env.FRONTEND_BASE_URL || process.env.APP_BASE_URL || '';
    const candidateUrl = frontendBaseUrl
      ? `${frontendBaseUrl.replace(/\/$/, '')}/candidate/${token}`
      : `/candidate/${token}`;

    // Optionally email link to candidate
    if (candidate_email) {
      const subject = `Interview Pre-screen for ${job.title}`;
      const html = `
        <!DOCTYPE html>
        <html>
        <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
          <h2>Complete Your Application</h2>
          <p>Hello ${candidate_name || 'Candidate'},</p>
          <p>Please use the link below to upload your resume and answer a few short questions for the position <strong>${job.title}</strong>:</p>
          <p><a href="${candidateUrl}" target="_blank">${candidateUrl}</a></p>
        </body>
        </html>
      `;

      try {
        await sendEmail({
          to: candidate_email,
          subject,
          html
        });
      } catch (emailError) {
        console.error('Error sending candidate link email:', emailError);
      }
    }

    res.json({
      success: true,
      message: 'Candidate link generated successfully',
      data: {
        id: linkId,
        token,
        url: candidateUrl,
        questions: flatQuestions
      }
    });
  } catch (error) {
    console.error('Error generating candidate link:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to generate candidate link',
      message: error.message
    });
  }
});

// Get link by job_description_id (for HR/Admin to view existing link)
router.get('/job/:job_description_id', async (req, res) => {
  try {
    const { job_description_id } = req.params;

    const link = await queryOne(
      `SELECT cl.*, 
        JSON_OBJECT('id', jd.id, 'title', jd.title, 'description', jd.description, 'requirements', jd.requirements) as job
       FROM candidate_links cl
       LEFT JOIN job_descriptions jd ON cl.job_description_id = jd.id
       WHERE cl.job_description_id = ? AND cl.status != 'expired'
       ORDER BY cl.created_at DESC LIMIT 1`,
      [job_description_id]
    );

    if (!link) {
      return res.json({
        success: true,
        data: null,
        message: 'No active link found for this job post'
      });
    }

    // Check if link has expired
    if (link.expires_at && new Date(link.expires_at) < new Date()) {
      return res.json({
        success: true,
        data: null,
        message: 'Link has expired'
      });
    }

    let questions = [];
    if (link.questions) {
      try {
        const parsed = JSON.parse(link.questions);
        if (Array.isArray(parsed)) {
          questions = parsed;
        } else if (parsed && Array.isArray(parsed.categories)) {
          parsed.categories.forEach(cat => {
            if (cat && Array.isArray(cat.questions)) {
              cat.questions.forEach(q => {
                const text = q?.text || q?.question || null;
                if (text && typeof text === 'string') {
                  questions.push(text.trim());
                }
              });
            }
          });
        }
      } catch (e) {
        console.error('Error parsing stored questions JSON:', e);
        questions = [];
      }
    }

    const job = link.job ? JSON.parse(link.job) : null;
    const frontendBaseUrl = process.env.FRONTEND_BASE_URL || process.env.APP_BASE_URL || '';
    const candidateUrl = frontendBaseUrl
      ? `${frontendBaseUrl.replace(/\/$/, '')}/candidate/${link.token}`
      : `/candidate/${link.token}`;

    res.json({
      success: true,
      data: {
        id: link.id,
        token: link.token,
        url: candidateUrl,
        status: link.status,
        job,
        questions
      }
    });
  } catch (error) {
    console.error('Error fetching candidate link by job ID:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch candidate link',
      message: error.message
    });
  }
});

// Public: get link details (job + questions)
router.get('/:token', async (req, res) => {
  try {
    const { token } = req.params;

    const link = await queryOne(
      `SELECT cl.*, 
        JSON_OBJECT('id', jd.id, 'title', jd.title, 'description', jd.description, 'requirements', jd.requirements) as job
       FROM candidate_links cl
       LEFT JOIN job_descriptions jd ON cl.job_description_id = jd.id
       WHERE cl.token = ?`,
      [token]
    );

    if (!link) {
      return res.status(404).json({
        success: false,
        error: 'Invalid or expired link'
      });
    }

    if (link.status === 'expired') {
      return res.status(410).json({
        success: false,
        error: 'This link has expired'
      });
    }

    if (link.expires_at && new Date(link.expires_at) < new Date()) {
      // Automatically expire
      await query(
        'UPDATE candidate_links SET status = "expired" WHERE id = ?',
        [link.id]
      );
      return res.status(410).json({
        success: false,
        error: 'This link has expired'
      });
    }

    let questions = [];
    if (link.questions) {
      try {
        const parsed = JSON.parse(link.questions);
        if (Array.isArray(parsed)) {
          // Already stored as flat list of question texts
          questions = parsed;
        } else if (parsed && Array.isArray(parsed.categories)) {
          // Backward‑compat: old records that kept full categories object
          parsed.categories.forEach(cat => {
            if (cat && Array.isArray(cat.questions)) {
              cat.questions.forEach(q => {
                const text = q?.text || q?.question || null;
                if (text && typeof text === 'string') {
                  questions.push(text.trim());
                }
              });
            }
          });
        }
      } catch (e) {
        console.error('Error parsing stored questions JSON:', e);
        questions = [];
      }
    }
    const job = link.job ? JSON.parse(link.job) : null;

    res.json({
      success: true,
      data: {
        id: link.id,
        token: link.token,
        status: link.status,
        candidate_name: link.candidate_name,
        candidate_email: link.candidate_email,
        job,
        questions
      }
    });
  } catch (error) {
    console.error('Error fetching candidate link:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch candidate link',
      message: error.message
    });
  }
});

// Public: candidate submits resume + Q&A via link
router.post('/:token/submit', upload.single('resume'), async (req, res) => {
  const startTime = Date.now();
  let filePath = null;

  try {
    const { token } = req.params;

    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: 'Resume file is required'
      });
    }

    const link = await queryOne(
      'SELECT * FROM candidate_links WHERE token = ?',
      [token]
    );

    if (!link) {
      return res.status(404).json({
        success: false,
        error: 'Invalid or expired link'
      });
    }

    // Allow link to be reused - only check for expired status
    if (link.status === 'expired') {
      return res.status(410).json({
        success: false,
        error: 'This link has expired'
      });
    }

    if (link.expires_at && new Date(link.expires_at) < new Date()) {
      await query(
        'UPDATE candidate_links SET status = "expired" WHERE id = ?',
        [link.id]
      );
      return res.status(410).json({
        success: false,
        error: 'This link has expired'
      });
    }

    const job = await queryOne(
      'SELECT * FROM job_descriptions WHERE id = ?',
      [link.job_description_id]
    );

    if (!job) {
      return res.status(404).json({
        success: false,
        error: 'Job description not found'
      });
    }

    const { question_answers } = req.body;
    let questionAnswers = {};
    if (question_answers) {
      questionAnswers = typeof question_answers === 'string'
        ? JSON.parse(question_answers)
        : question_answers;
    }

    filePath = req.file.path;
    const fileName = req.file.originalname;
    const mimetype = req.file.mimetype;

    const resumeText = await extractTextFromFile(filePath, mimetype);
    const parsedData = await parseResumeWithGemini(resumeText, fileName);

    const normalizedEmail = parsedData.email ? parsedData.email.toLowerCase().trim() : (link.candidate_email || null);
    
    // Check if candidate has applied within the last 6 months
    if (normalizedEmail) {
      const hasRecent = await hasRecentApplication(normalizedEmail);
      if (hasRecent) {
        // Clean up file before returning error
        try {
          await fs.unlink(filePath);
        } catch (e) {
          // Ignore cleanup errors
        }
        return res.status(400).json({
          success: false,
          error: 'This candidate has already applied within the last 6 months'
        });
      }
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

    const fullJobDescription = `${job.title}\n\n${job.description}\n\n${job.requirements || ''}`;

    // Save resume with version number
    const resumeResult = await query(
      `INSERT INTO resumes (
        file_name, file_path, name, email, phone, location,
        skills, experience, education, summary, certifications,
        raw_text, total_experience, parent_id, version_number
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        fileName,
        filePath,
        parsedData.name || link.candidate_name || null,
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

    const resumeId = resumeResult.insertId;

    // Evaluate with resume + JD + Q&A
    const matchResults = await matchResumeWithJobDescriptionAndQA(
      resumeText,
      fullJobDescription,
      parsedData,
      questionAnswers
    );

    const evalResult = await query(
      `INSERT INTO candidate_evaluations (
        resume_id, job_description_id, candidate_name, contact_number, email,
        resume_text, job_description, overall_match, skills_match, skills_details,
        experience_match, experience_details, education_match, education_details,
        status, rejection_reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        resumeId,
        link.job_description_id,
        parsedData.name || link.candidate_name || null,
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

    const evaluationId = evalResult.insertId;

    // Don't update link status - keep it reusable for multiple candidates
    // Link remains active so multiple candidates can use the same link

    // If score > 70, fetch available interviewer slots for mapped interviewers
    let availableSlots = [];
    if (matchResults.overall_match >= 70) {
      const mappedInterviewers = job.interviewers ? JSON.parse(job.interviewers) : [];
      if (mappedInterviewers && mappedInterviewers.length > 0) {
        const placeholders = mappedInterviewers.map(() => '?').join(',');
        const params = [...mappedInterviewers, link.job_description_id];
        const rows = await query(
          `SELECT 
             s.*,
             JSON_OBJECT(
               'id', u.id,
               'email', u.email,
               'full_name', u.full_name
             ) as interviewer
           FROM interviewer_time_slots s
           LEFT JOIN users u ON s.interviewer_id = u.id
           WHERE s.is_booked = 0
             AND s.start_time > NOW()
             AND s.interviewer_id IN (${placeholders})
             AND (s.job_description_id IS NULL OR s.job_description_id = ?)
           ORDER BY s.start_time ASC`,
          params
        );

        availableSlots = rows.map(row => ({
          ...row,
          interviewer: row.interviewer ? JSON.parse(row.interviewer) : null
        }));
      }
    }

    // Clean up file from disk
    try {
      if (filePath) {
        await fs.unlink(filePath);
      }
    } catch (cleanupError) {
      console.warn('Could not clean up candidate file:', cleanupError.message);
    }

    const totalTime = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`Candidate evaluation via link completed in ${totalTime}s (ID: ${evaluationId})`);

    res.json({
      success: true,
      data: {
        evaluation_id: evaluationId,
        overall_match: matchResults.overall_match,
        skills_match: matchResults.skills_match,
        experience_match: matchResults.experience_match,
        education_match: matchResults.education_match,
        status: matchResults.status,
        rejection_reason: matchResults.rejection_reason || null,
        can_select_slot: matchResults.overall_match >= 70,
        available_slots: availableSlots
      }
    });
  } catch (error) {
    if (filePath) {
      try {
        await fs.unlink(filePath);
      } catch (cleanupError) {
        // ignore
      }
    }

    console.error('Error submitting candidate link:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to submit application',
      message: error.message
    });
  }
});

// Public: candidate books a slot after successful evaluation
router.post('/:token/book-slot', async (req, res) => {
  try {
    const { token } = req.params;
    const { slot_id, evaluation_id } = req.body;

    if (!slot_id || !evaluation_id) {
      return res.status(400).json({
        success: false,
        error: 'slot_id and evaluation_id are required'
      });
    }

    const link = await queryOne(
      'SELECT * FROM candidate_links WHERE token = ?',
      [token]
    );

    if (!link || link.status === 'expired') {
      return res.status(400).json({
        success: false,
        error: 'Invalid or expired link'
      });
    }

    // Check if link has expired
    if (link.expires_at && new Date(link.expires_at) < new Date()) {
      return res.status(410).json({
        success: false,
        error: 'This link has expired'
      });
    }

    const evaluation = await queryOne(
      `SELECT ce.*, 
        jd.title as job_title,
        jd.interviewers,
        r.name as candidate_name,
        r.email as candidate_email
       FROM candidate_evaluations ce
       LEFT JOIN job_descriptions jd ON ce.job_description_id = jd.id
       LEFT JOIN resumes r ON ce.resume_id = r.id
       WHERE ce.id = ? AND ce.job_description_id = ?`,
      [evaluation_id, link.job_description_id]
    );

    if (!evaluation) {
      return res.status(404).json({
        success: false,
        error: 'Evaluation not found or does not belong to this job post'
      });
    }

    if (Number(evaluation.overall_match) < 70) {
      return res.status(400).json({
        success: false,
        error: 'Slot selection is only allowed for candidates with score >= 70%'
      });
    }

    const slot = await queryOne(
      `SELECT s.*, u.email as interviewer_email, u.full_name as interviewer_name
       FROM interviewer_time_slots s
       LEFT JOIN users u ON s.interviewer_id = u.id
       WHERE s.id = ? AND s.is_booked = 0`,
      [slot_id]
    );

    if (!slot) {
      return res.status(404).json({
        success: false,
        error: 'Selected slot is no longer available'
      });
    }

    // Ensure interviewer is mapped to job (if mapping exists)
    if (evaluation.interviewers) {
      try {
        const mappedInterviewers = JSON.parse(evaluation.interviewers) || [];
        if (mappedInterviewers.length > 0 && !mappedInterviewers.includes(slot.interviewer_id)) {
          return res.status(400).json({
            success: false,
            error: 'Selected interviewer is not mapped to this job description'
          });
        }
      } catch (e) {
        // ignore parsing error, treat as no mapping
      }
    }

    // Mark slot as booked
    const updateResult = await query(
      `UPDATE interviewer_time_slots 
       SET is_booked = 1, evaluation_id = ?, job_description_id = ?
       WHERE id = ? AND is_booked = 0`,
      [evaluation_id, evaluation.job_description_id, slot_id]
    );

    if (updateResult.affectedRows === 0) {
      return res.status(409).json({
        success: false,
        error: 'Slot was just booked by someone else. Please choose another slot.'
      });
    }

    // Update evaluation with interviewer and interview date
    await query(
      `UPDATE candidate_evaluations
       SET interviewer_id = ?, interview_date = ?, interviewer_status = 'pending'
       WHERE id = ?`,
      [slot.interviewer_id, slot.start_time, evaluation_id]
    );

    // Determine a system user to record assignment (first Admin or HR)
    const systemUser = await queryOne(
      "SELECT id FROM users WHERE role IN ('Admin', 'HR') ORDER BY created_at ASC LIMIT 1"
    );

    if (systemUser) {
      await query(
        `INSERT INTO interview_assignments (evaluation_id, interviewer_id, interview_date, assigned_by, notes)
         VALUES (?, ?, ?, ?, ?)`,
        [evaluation_id, slot.interviewer_id, slot.start_time, systemUser.id, 'Candidate self-scheduled']
      );
    }

    const candidateName = evaluation.candidate_name || evaluation.name || 'Candidate';
    const candidateEmail = evaluation.candidate_email || evaluation.email || link.candidate_email;
    const jobTitle = evaluation.job_title || 'Position';

    // Notify interviewer
    if (slot.interviewer_email) {
      await sendInterviewAssignmentToInterviewer({
        interviewerEmail: slot.interviewer_email,
        interviewerName: slot.interviewer_name || slot.interviewer_email,
        candidateName,
        candidateEmail,
        jobTitle,
        interviewDate: slot.start_time
      });
    }

    // Notify candidate
    if (candidateEmail) {
      await sendInterviewAssignmentToCandidate({
        candidateEmail,
        candidateName,
        jobTitle,
        interviewDate: slot.start_time,
        interviewerName: slot.interviewer_name || slot.interviewer_email
      });
    }

    // Notify HR/Admin
    try {
      const hrAdminUsers = await query(
        "SELECT email FROM users WHERE role IN ('HR', 'Admin')"
      );
      const hrAdminEmails = hrAdminUsers.map(u => u.email).filter(Boolean);
      if (hrAdminEmails.length > 0) {
        const subject = `Interview Scheduled (Candidate Self-Selected): ${candidateName} - ${jobTitle}`;
        const html = `
          <!DOCTYPE html>
          <html>
          <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
            <h2>Interview Scheduled by Candidate</h2>
            <p>The candidate has selected an interview slot:</p>
            <ul>
              <li><strong>Candidate:</strong> ${candidateName}</li>
              <li><strong>Candidate Email:</strong> ${candidateEmail || 'N/A'}</li>
              <li><strong>Job Position:</strong> ${jobTitle}</li>
              <li><strong>Interviewer:</strong> ${slot.interviewer_name || slot.interviewer_email}</li>
              <li><strong>Date & Time:</strong> ${new Date(slot.start_time).toLocaleString('en-US')}</li>
            </ul>
          </body>
          </html>
        `;

        await Promise.all(
          hrAdminEmails.map(email =>
            sendEmail({
              to: email,
              subject,
              html
            })
          )
        );
      }
    } catch (notifyError) {
      console.error('Error sending HR/Admin self-schedule emails:', notifyError);
    }

    res.json({
      success: true,
      message: 'Interview slot booked successfully'
    });
  } catch (error) {
    console.error('Error booking slot via candidate link:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to book interview slot',
      message: error.message
    });
  }
});

module.exports = router;


