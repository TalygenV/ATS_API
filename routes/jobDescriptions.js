const express = require('express');
const { query, queryOne } = require('../config/database');
const { authenticate, requireWriteAccess } = require('../middleware/auth');
const { generateQuestionsFromJD, extractJobDescriptionInfo } = require('../utils/questionGenerator');
const { convertResultToUTC } = require('../utils/datetimeUtils');


const router = express.Router();


router.get('/', authenticate, async (req, res) => {
  try {
    const interviewTimeSlot = Number(process.env.INTERVIEW_TIME_SLOT || 30);
    const isInterviewer = req.user.role === 'Interviewer';

    const params = [];

    /*
      PARAM ORDER (VERY IMPORTANT)

      Query B (zero-candidate jobs):
        1) isInterviewer flag (0 / 1)
        2) interviewerId (or NULL)
    */

    params.push(isInterviewer ? 1 : 0);
    params.push(isInterviewer ? req.user.id : null);

    // for UNION query B
params.push(isInterviewer ? 1 : 0);
params.push(isInterviewer ? req.user.id : null);

//console.log('Params:', params, params.length);

    const sql = `
WITH latest_resumes AS (
  SELECT r1.id
  FROM resumes r1
  JOIN (
    SELECT 
      COALESCE(parent_id, id) AS root_id,
      MAX(version_number) AS max_version
    FROM resumes
    GROUP BY COALESCE(parent_id, id)
  ) x
    ON x.root_id = COALESCE(r1.parent_id, r1.id)
   AND x.max_version = r1.version_number
)

SELECT *
FROM (

  /* ===================== QUERY A : JOBS WITH CANDIDATES ===================== */

  SELECT 
    jd.*,

    COUNT(DISTINCT lr.id) AS resume_count,

    COUNT(DISTINCT CASE WHEN ce.status = 'accepted' THEN ce.email END) AS accepted,
    COUNT(DISTINCT CASE WHEN ce.status = 'pending' THEN ce.email END) AS pending,
    COUNT(DISTINCT CASE WHEN ce.status = 'rejected' THEN ce.email END) AS rejected,

    COUNT(DISTINCT CASE 
      WHEN lr.id IS NOT NULL AND ce.hr_final_status = 'on_hold'
      THEN ce.email END
    ) AS onhold,

    COUNT(DISTINCT CASE 
      WHEN lr.id IS NOT NULL AND ce.hr_final_status = 'rejected'
      THEN ce.email END
    ) AS finalRejected,

    COUNT(DISTINCT CASE 
      WHEN lr.id IS NOT NULL AND ce.hr_final_status = 'selected'
      THEN ce.email END
    ) AS finalSelected,

    COUNT(DISTINCT CASE 
      WHEN lr.id IS NOT NULL
       AND ce.hr_final_status = 'pending'
       AND its.start_time IS NOT NULL
       AND UTC_TIMESTAMP() >
           DATE_ADD(its.start_time, INTERVAL ${interviewTimeSlot} MINUTE)
      THEN ce.email END
    ) AS totalDecisionPending,

    COUNT(DISTINCT CASE 
      WHEN lr.id IS NOT NULL
       AND its.start_time IS NOT NULL
       AND id.interviewer_feedback IS NULL
       AND its.start_time > UTC_TIMESTAMP()
       AND ce.hr_final_status NOT IN ('selected','rejected','on_hold')
      THEN ce.email END
    ) AS scheduledInterview,

    COUNT(DISTINCT CASE 
      WHEN its.start_time IS NULL
      THEN ce.email END
    ) AS totalPending

  FROM job_descriptions jd
  RIGHT JOIN candidate_evaluations ce
    ON ce.job_description_id = jd.id
  LEFT JOIN interview_details id
    ON id.candidate_evaluations_id = ce.id
  LEFT JOIN interviewer_time_slots its
    ON its.id = id.interviewer_time_slots_id
  LEFT JOIN latest_resumes lr
    ON lr.id = ce.resume_id
 WHERE (
  ? = 0
  OR (
    jd.interviewers IS NOT NULL
    AND JSON_CONTAINS(jd.interviewers, JSON_QUOTE(?))
  )
)


  GROUP BY jd.id
  

  UNION ALL

  /* ===================== QUERY B : JOBS WITH ZERO CANDIDATES ===================== */

  SELECT
    jd.*,
    0 AS resume_count,
    0 AS accepted,
    0 AS pending,
    0 AS rejected,
    0 AS onhold,
    0 AS finalRejected,
    0 AS finalSelected,
    0 AS totalDecisionPending,
    0 AS scheduledInterview,
    0 AS totalPending

  FROM job_descriptions jd
  WHERE NOT EXISTS (
    SELECT 1
    FROM candidate_evaluations ce
    WHERE ce.job_description_id = jd.id
  )
  AND (
    ? = 0
    OR JSON_CONTAINS(jd.interviewers, JSON_QUOTE(?))
  )

) result
ORDER BY result.created_at DESC
`;

    const rows = await query(sql, params);

    const data = rows.map(jd => ({
      ...jd,
      interviewers: jd.interviewers ? JSON.parse(jd.interviewers) : [],
      resume_count: Number(jd.resume_count) || 0
    }));

    res.json({
      success: true,
      count: data.length,
      data
    });

  } catch (error) {
    console.error('Error fetching job descriptions:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch job descriptions',
      error: error.message
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

    // Parse JSON fields and convert datetime to UTC
    const parsedJobDescription = {
      ...jobDescription,
      interviewers: jobDescription.interviewers ? JSON.parse(jobDescription.interviewers) : []
    };

    res.json({
      success: true,
      data: convertResultToUTC(parsedJobDescription)
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
    const { title, description, requirements, interviewers, status } = req.body;

    if (!title || !description) {
      return res.status(400).json({
        error: 'Title and description are required'
      });
    }

    // Validate status if provided
    const validStatuses = ['Open', 'On Hold'];
    const jobStatus = status && validStatuses.includes(status) ? status : 'Open';

    // Validate interviewers if provided
    let interviewersJson = null;
    if (interviewers) {
      if (!Array.isArray(interviewers)) {
        return res.status(400).json({
          error: 'Interviewers must be an array'
        });
      }
      // Validate that all interviewer IDs exist, are Interviewer role, and are active
      if (interviewers.length > 0) {
        const placeholders = interviewers.map(() => '?').join(',');
        const validInterviewers = await query(
          `SELECT id FROM users WHERE id IN (${placeholders}) AND role = 'Interviewer' AND status = 'active'`,
          interviewers
        );
        if (validInterviewers.length !== interviewers.length) {
          return res.status(400).json({
            error: 'One or more invalid interviewer IDs provided or interviewers are inactive'
          });
        }
      }
      interviewersJson = JSON.stringify(interviewers);
    }

    const result = await query(
      'INSERT INTO job_descriptions (title, description, requirements, interviewers, status) VALUES (?, ?, ?, ?, ?)',
      [title.trim(), description.trim(), requirements ? requirements.trim() : null, interviewersJson, jobStatus]
    );

    const jobDescription = await queryOne(
      'SELECT * FROM job_descriptions WHERE id = ?',
      [result.insertId]
    );

    // Parse JSON fields and convert datetime to UTC
    const parsedJobDescription = {
      ...jobDescription,
      interviewers: jobDescription.interviewers ? JSON.parse(jobDescription.interviewers) : []
    };

    res.json({
      success: true,
      message: 'Job description created successfully',
      data: convertResultToUTC(parsedJobDescription)
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
    const { title, description, requirements, interviewers, status } = req.body;

    if (!title || !description) {
      return res.status(400).json({
        error: 'Title and description are required'
      });
    }

    // Validate status if provided
    if (status !== undefined) {
      const validStatuses = ['Open', 'On Hold'];
      if (!validStatuses.includes(status)) {
        return res.status(400).json({
          error: 'Status must be either "Open" or "On Hold"'
        });
      }
    }

    // Validate interviewers if provided
    let interviewersJson = null;
    if (interviewers !== undefined) {
      if (!Array.isArray(interviewers)) {
        return res.status(400).json({
          error: 'Interviewers must be an array'
        });
      }
      // Validate that all interviewer IDs exist, are Interviewer role, and are active
      if (interviewers.length > 0) {
        const placeholders = interviewers.map(() => '?').join(',');
        const validInterviewers = await query(
          `SELECT id FROM users WHERE id IN (${placeholders}) AND role = 'Interviewer' AND status = 'active'`,
          interviewers
        );
        if (validInterviewers.length !== interviewers.length) {
          return res.status(400).json({
            error: 'One or more invalid interviewer IDs provided or interviewers are inactive'
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

    if (status !== undefined) {
      updateFields.push('status = ?');
      updateValues.push(status);
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

    // Parse JSON fields and convert datetime to UTC
    const parsedJobDescription = {
      ...jobDescription,
      interviewers: jobDescription.interviewers ? JSON.parse(jobDescription.interviewers) : []
    };

    res.json({
      success: true,
      message: 'Job description updated successfully',
      data: convertResultToUTC(parsedJobDescription)
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

router.post('/generate-questions',  async (req, res) => {
  try {
    const { jobDescription, title, seniority, yearsOfExperience } = req.body;

    if (!jobDescription || typeof jobDescription !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'jobDescription (string) is required in request body'
      });
    }

    // Generate questions and extract job description information in parallel
    const [questions, extractedInfo] = await Promise.all([
      generateQuestionsFromJD(jobDescription, {
        title,
        seniority,
        yearsOfExperience
      }),
      extractJobDescriptionInfo(jobDescription)
    ]);

    res.json({
      success: true,
      data: {
        questions: questions,
        jobInfo: extractedInfo
      }
    });
  } catch (error) {
    console.error('Error generating questions from job description:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to generate questions from job description',
      message: error.message
    });
  }
});

module.exports = router;
