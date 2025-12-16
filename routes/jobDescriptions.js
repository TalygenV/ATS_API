const express = require('express');
const { query, queryOne } = require('../config/database');
const { authenticate, requireWriteAccess } = require('../middleware/auth');
const { generateQuestionsFromJD } = require('../utils/questionGenerator');
const { convertResultToUTC } = require('../utils/datetimeUtils');

const router = express.Router();

// Get all job descriptions (all authenticated users can view)
// router.get('/', authenticate, async (req, res) => {
//   try {
   
// //     let params = []
// //      let sql =  `  SELECT 
// //     jd.*,
// //     COUNT(DISTINCT ce.resume_id) AS resume_count,
// //     (
      
// //         SELECT COUNT(DISTINCT ce2.email) 
// //         FROM candidate_evaluations ce2
// //         WHERE ce2.status = 'accepted'
// //         AND ce2.job_description_id = jd.id
// //     ) AS accepted,
// //     (
// //        SELECT COUNT(DISTINCT ce2.email) 
// //        FROM candidate_evaluations ce2
// //         WHERE ce2.status = 'pending'
// //         AND ce2.job_description_id = jd.id
// //     ) AS pending,
// //     (
// //         SELECT COUNT(DISTINCT ce2.email) 
// //         FROM candidate_evaluations ce2
// //         WHERE ce2.status = 'rejected'
// //         AND ce2.job_description_id = jd.id
// //     ) AS rejected
// // FROM job_descriptions jd
// // LEFT JOIN candidate_evaluations ce 
// //     ON jd.id = ce.job_description_id
// // GROUP BY jd.id
// // ORDER BY jd.created_at DESC`

//         let params = [];

//     // If the user is an Interviewer we will restrict joins & subqueries to that interviewer
//     const isInterviewer = req.user.role === 'Interviewer';

//     // Join condition (restrict ce rows to this interviewer when applicable)
//     const joinCondition = isInterviewer ? ' AND ce.interviewer_id = ?' : '';
//     if (isInterviewer) params.push(req.user.id); // for the LEFT JOIN condition

//     // Subquery extra condition to restrict counts to this interviewer when applicable
//     const subQueryInterviewerCond = isInterviewer ? ' AND ce2.interviewer_id = ?' : '';

//     const isHRorAdmin = req.user.role === 'HR' || req.user.role === 'Admin';

//     // If interviewer, we want to show only job_descriptions that have at least one candidate for them
//     // const havingClause = isInterviewer ? ' HAVING COUNT(DISTINCT ce.id) > 0' : '';
//       const havingClause = '';
      

//     // const sql = `
//     //   SELECT
//     //     jd.*,
//     //     COUNT(DISTINCT ce.resume_id) AS resume_count,
//     //     (
//     //       SELECT COUNT(DISTINCT ce2.email)
//     //       FROM candidate_evaluations ce2
//     //       WHERE ce2.status = 'accepted'
//     //         AND ce2.job_description_id = jd.id
//     //         ${subQueryInterviewerCond}
//     //     ) AS accepted,
//     //     (
//     //       SELECT COUNT(DISTINCT ce2.email)
//     //       FROM candidate_evaluations ce2
//     //       WHERE ce2.status = 'pending'
//     //         AND ce2.job_description_id = jd.id
//     //         ${subQueryInterviewerCond}
//     //     ) AS pending,
//     //     (
//     //       SELECT COUNT(DISTINCT ce2.email)
//     //       FROM candidate_evaluations ce2
//     //       WHERE ce2.status = 'rejected'
//     //         AND ce2.job_description_id = jd.id
//     //         ${subQueryInterviewerCond}
//     //     ) AS rejected
//     //   FROM job_descriptions jd
//     //   LEFT JOIN candidate_evaluations ce
//     //     ON jd.id = ce.job_description_id ${joinCondition}
//     //   GROUP BY jd.id
//     //   ${havingClause}
//     //   ORDER BY jd.created_at DESC
//     // `;


//     let sql = `SELECT 
//     jd.*,
//     COUNT(DISTINCT ce.resume_id) AS resume_count,
//     (
      
//         SELECT COUNT(DISTINCT ce2.email) 
//         FROM candidate_evaluations ce2
//         inner join resumes r2 on r2.id = ce2.resume_id and r2.parent_id is null
//         WHERE ce2.status = 'accepted'
//         AND ce2.job_description_id = jd.id
//             ${subQueryInterviewerCond}
//     ) AS accepted,
//     (
//        SELECT COUNT(DISTINCT ce2.email) 
//        FROM candidate_evaluations ce2
//          inner join resumes r2 on r2.id = ce2.resume_id and r2.parent_id is null
//         WHERE ce2.status = 'pending'
//         AND ce2.job_description_id = jd.id
//             ${subQueryInterviewerCond}
//     ) AS pending,
//     (
//         SELECT COUNT(DISTINCT ce2.email) 
//         FROM candidate_evaluations ce2
//           inner join resumes r2 on r2.id = ce2.resume_id and r2.parent_id is null
//         WHERE ce2.status = 'rejected'
//         AND ce2.job_description_id = jd.id
//             ${subQueryInterviewerCond}
//     ) AS rejected,
//      (
//         SELECT COUNT(DISTINCT ce2.email) 
//         FROM candidate_evaluations ce2
//           inner join resumes r2 on r2.id = ce2.resume_id and r2.parent_id is null
//         WHERE ce2.interviewer_status = 'on_hold'
//         or ce2.interviewer_status = 'selected'
//         Or
//         ce2.hr_final_status = 'on_hold'
//         AND ce2.job_description_id = jd.id
//     ) AS onhold,
    
//          (
//         SELECT COUNT(DISTINCT ce2.email) 
//         FROM candidate_evaluations ce2
//           inner join resumes r2 on r2.id = ce2.resume_id and r2.parent_id is null
//         WHERE 
//         ce2.hr_final_status = 'rejected'
//         AND ce2.job_description_id = jd.id
//     ) AS finalRejected,
//          (
//         SELECT COUNT(DISTINCT ce2.email) 
//         FROM candidate_evaluations ce2
//           inner join resumes r2 on r2.id = ce2.resume_id and r2.parent_id is null
//         WHERE ce2.hr_final_status = 'selected'
//         AND ce2.job_description_id = jd.id
//     ) AS finalSeclected,
//     (
//         SELECT COUNT(DISTINCT ce2.email) 
//         FROM candidate_evaluations ce2
//           inner join resumes r2 on r2.id = ce2.resume_id and r2.parent_id is null
//         WHERE ce2.interviewer_id is null 
//         AND ce2.job_description_id = jd.id
//     ) AS totaldesisionPending, 
//      (
//         SELECT COUNT(DISTINCT ce2.email) 
//         FROM candidate_evaluations ce2
        
//         WHERE ce2.interviewer_id is not null
//         AND ce2.interview_date  <= UTC_TIMESTAMP()
//         AND ce2.interviewer_feedback is null
//         AND ce2.job_description_id = jd.id
//     ) AS ScheduledInterview 
    
//     FROM job_descriptions jd
// LEFT JOIN candidate_evaluations ce 
// inner join resumes r on r.id = ce.resume_id and r.parent_id is null
//     ON jd.id = ce.job_description_id ${joinCondition}
// GROUP BY jd.id
// ORDER BY jd.created_at DESC`

//     // If interviewer, we pushed one param for the LEFT JOIN already.
//     // For subqueries we must push the interviewer id once per subquery condition used.
//     if (isInterviewer) {
//       // three subqueries -> push interviewer id three more times (order matters)
//       params.push(req.user.id, req.user.id, req.user.id);
//     }

//         const jobDescriptions = await query(sql, params);

  

//     // Parse JSON fields
//     const parsedJobDescriptions = jobDescriptions.map(jd => ({
//       ...jd,
//       interviewers: jd.interviewers ? JSON.parse(jd.interviewers) : [],
//       resume_count: parseInt(jd.resume_count) || 0
//     }));

//     res.json({
//       success: true,
//       count: parsedJobDescriptions.length,
//       data: parsedJobDescriptions
//     });
//   } catch (error) {
//     console.error('Error fetching job descriptions:', error);
//     res.status(500).json({
//       error: 'Failed to fetch job descriptions',
//       message: error.message
//     });
//   }
// });


router.get('/', authenticate, async (req, res) => {
  try {
    let params = [];

    // Role check
    const isInterviewer = req.user.role === 'Interviewer';

    // Interviewer restriction
    const joinCondition = isInterviewer ? ' AND ce.interviewer_id = ?' : '';
    if (isInterviewer) params.push(req.user.id);

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

      SELECT 
        jd.*,

        COUNT(DISTINCT lr.id) AS resume_count,

        COUNT(DISTINCT CASE 
          WHEN lr.id IS NOT NULL AND ce.status = 'accepted'
          THEN ce.email END
        ) AS accepted,

        COUNT(DISTINCT CASE 
          WHEN lr.id IS NOT NULL AND ce.status = 'pending'
          THEN ce.email END
        ) AS pending,

        COUNT(DISTINCT CASE 
          WHEN lr.id IS NOT NULL AND ce.status = 'rejected'
          THEN ce.email END
        ) AS rejected,

     COUNT(DISTINCT CASE 
  WHEN lr.id IS NOT NULL
   AND (
        ce.interviewer_status IN ('on_hold' , 'rejected')
        OR ce.hr_final_status = 'on_hold'
       )
   AND ce.hr_final_status NOT IN ('selected','rejected')
  THEN ce.email 
END) AS onhold,


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
   AND ce.hr_final_status NOT IN ('selected','rejected' , 'on_hold' )
   AND (
     -- Interviewer has selected but interview hasn't happened yet (or happened within 45 min)
     (ce.interviewer_status IN ('selected') 
      AND (ce.interview_date IS NULL 
           OR ce.interview_date <= DATE_ADD(UTC_TIMESTAMP(), INTERVAL 45 MINUTE)))
     OR 
     -- Interview has passed or is very soon (within 45 min) and feedback is pending
     (ce.interview_date IS NOT NULL 
      AND ce.interview_date <= DATE_ADD(UTC_TIMESTAMP(), INTERVAL 45 MINUTE)
      AND ce.interviewer_feedback IS NULL)
   )
   -- Exclude candidates with future interviews (those go to scheduledInterview)
   AND NOT (ce.interview_date IS NOT NULL 
            AND ce.interview_date > DATE_ADD(UTC_TIMESTAMP(), INTERVAL 45 MINUTE))
  THEN ce.email 
END)  AS totalDecisionPending,
            COUNT(DISTINCT CASE 
          WHEN lr.id IS NOT NULL AND ce.interviewer_id IS NULL
          THEN ce.email END
        ) AS totalPending,

        COUNT(DISTINCT CASE 
          WHEN lr.id IS NOT NULL
           AND ce.interviewer_id IS NOT NULL
           AND ce.interview_date IS NOT NULL
           AND ce.interviewer_feedback IS NULL
           AND ce.interview_date > DATE_ADD(UTC_TIMESTAMP(), INTERVAL 45 MINUTE)
           AND ce.hr_final_status NOT IN ('selected','rejected' , 'on_hold' )
          THEN ce.email END
        ) AS scheduledInterview

      FROM job_descriptions jd
      LEFT JOIN candidate_evaluations ce
        ON ce.job_description_id = jd.id
        ${joinCondition}
      LEFT JOIN latest_resumes lr
        ON lr.id = ce.resume_id

      GROUP BY jd.id
      ORDER BY jd.created_at DESC
    `;

    const rows = await query(sql, params);

    const parsedJobDescriptions = rows.map(jd => {
      const parsed = {
        ...jd,
        interviewers: jd.interviewers ? JSON.parse(jd.interviewers) : [],
        resume_count: Number(jd.resume_count) || 0
      };
      return convertResultToUTC(parsed);
    });

    res.json({
      success: true,
      count: parsedJobDescriptions.length,
      data: parsedJobDescriptions
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

    const questions = await generateQuestionsFromJD(jobDescription, {
      title,
      seniority,
      yearsOfExperience
    });

    res.json({
      success: true,
      data: questions
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
