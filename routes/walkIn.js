const express = require('express');
const { query, queryOne, pool } = require('../config/database');
const { authenticate, requireWriteAccess } = require('../middleware/auth');
const { convertResultToUTC, fromUTCString, toUTCString } = require('../utils/datetimeUtils');
const { generateInterViewLink } = require('../utils/zoomLinkGenerate');
const {
  sendInterviewAssignmentToInterviewer,
  sendInterviewAssignmentToCandidate
} = require('../utils/emailService');

const router = express.Router();

router.get('/', authenticate, async (req, res) => {
    try {
      const sql = `
            SELECT 
                wd.id as walkinDriveId ,
                wd.drive_name,
                wd.drive_description ,
                wd.drive_description ,
                wd.to_date ,
                wd.from_date ,
                wd.dobDescription_id ,
                wd.status as WalkinDriveStatus ,
                jd.title ,
                jd.description ,
                jd.requirements ,
                jd.status as jdStatus ,
                jd.industryAvg ,
                JSON_ARRAYAGG(u.full_name) AS interviewer_names
            FROM walkin_drive wd
            JOIN job_descriptions jd 
                ON jd.id = wd.dobDescription_id
            JOIN JSON_TABLE(
                jd.interviewers,
                '$[*]' COLUMNS (
                    interviewer_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci PATH '$'
                )
            ) jt
                ON 1=1
            JOIN users u 
                ON u.id COLLATE utf8mb4_0900_ai_ci = jt.interviewer_id
            GROUP BY wd.id;
            `; 
      const rows = await query(sql);
  
      const data = rows.map(jd => ({
        ...jd,
        interviewer_names: jd.interviewer_names ? JSON.parse(jd.interviewer_names) : [],
        resume_count: Number(jd.walkinDriveId) || 0
      }));
  
      res.json({
        success: true,
        count: data.length,
        data
      });
  
    } catch (error) {
      console.error('Error fetching Walkin Drive:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to fetch Walkin Drive',
        error: error.message
      });
    }
  });

  // Create new Walkin drive (only HR and Admin can create)
router.post('/', authenticate, requireWriteAccess, async (req, res) => {
    try {
      const { drive_name, drive_description, from_date, to_date, dobDescription_id ,status} = req.body;
  
      if (!drive_name || !drive_description || !dobDescription_id || !from_date || !to_date) {
        return res.status(400).json({
          error: 'Title and description are required'
        });
      }
  
      const result = await query(
        'INSERT INTO walkin_drive (drive_name, drive_description, from_date, to_date, dobDescription_id,status) VALUES (?, ?, ?, ?, ?,?)',
        [drive_name.trim(), drive_description.trim(), from_date, to_date, dobDescription_id,status]
      );
  
      const Drives = await queryOne(
        'SELECT * FROM walkin_drive WHERE id = ?',
        [result.insertId]
      );
  
      // Parse JSON fields and convert datetime to UTC
      const parsedDrives = {
        ...Drives,
       };
  
      res.json({
        success: true,
        message: 'walkin drive created successfully',
        data: convertResultToUTC(parsedDrives)
      });
    } catch (error) {
      console.error('Error creating walkin drive:', error);
      res.status(500).json({
        error: 'Failed to create walkin drive',
        message: error.message
      });
    }
  });
  
  // Update Walkin drive (only HR and Admin can update)
  router.put('/:id', authenticate, requireWriteAccess, async (req, res) => {
    try {
      const { id } = req.params;
      const { drive_name, drive_description, from_date, to_date, dobDescription_id,status} = req.body;
  
      if (!drive_name || !drive_description || !dobDescription_id || !from_date || !to_date) {
        return res.status(400).json({
          error: 'Title and description are required'
        });
      }
      // Build update query dynamically
      let updateFields = ['drive_name = ?', 'drive_description = ?'];
      let updateValues = [drive_name.trim(), drive_description.trim()];
  
      if (from_date !== undefined) {
        updateFields.push('from_date = ?');
        updateValues.push(fromUTCString(from_date));
      }
  
      if (to_date !== undefined) {
        updateFields.push('to_date = ?');
        updateValues.push(fromUTCString(to_date));
      }
  
      if (dobDescription_id !== undefined) {
        updateFields.push('dobDescription_id = ?');
        updateValues.push(dobDescription_id);
      }
      if (status !== undefined) {
        updateFields.push('status = ?');
        updateValues.push(status);
      }
    
      updateValues.push(id);
  
      const result = await query(
        `UPDATE walkin_drive SET ${updateFields.join(', ')} WHERE id = ?`,
        updateValues
      );
  
      if (result.affectedRows === 0) {
        return res.status(404).json({ error: 'walkin drive not found' });
      }
  
      const walkinDrive = await queryOne(
        'SELECT * FROM walkin_drive WHERE id = ?',
        [id]
      );
  
      // Parse JSON fields and convert datetime to UTC
      const parsedwalkinDrive = {
        ...walkinDrive,
        interviewers: walkinDrive.interviewers ? JSON.parse(walkinDrive.interviewers) : []
      };
  
      res.json({
        success: true,
        message: 'Walkin drive updated successfully',
        data: convertResultToUTC(parsedwalkinDrive)
      });
    } catch (error) {
      console.error('Error updating Walkin drive:', error);
      res.status(500).json({
        error: 'Failed to update Walkin drive',
        message: error.message
      });
    }
  });

// Delete Walkin drive (only HR and Admin can delete)
router.delete('/:id', authenticate, requireWriteAccess, async (req, res) => {
    try {
      const { id } = req.params;
  
      const result = await query(
        'DELETE FROM walkin_drive WHERE id = ?',
        [id]
      );
  
      if (result.affectedRows === 0) {
        return res.status(404).json({ error: 'Walkin drive not found' });
      }
  
      res.json({
        success: true,
        message: 'Walkin drive deleted successfully'
      });
    } catch (error) {
      console.error('Error deleting Walkin drive:', error);
      res.status(500).json({
        error: 'Failed to delete Walkin drive',
        message: error.message
      });
    }
  });


  router.get('/jobDescList', authenticate, requireWriteAccess, async (req, res) => {
    try {
      //const { role, active_only = 'true' } = req.query;
      
      let sql = 'SELECT * FROM job_descriptions WHERE 1=1';
      
      const jobDescList = await query(sql);
      
      res.json({
        success: true,
        count: jobDescList.length,
        data: convertResultToUTC(jobDescList)
      });
    } catch (error) {
      console.error('Error fetching job Description List:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to fetch job Description List',
        message: error.message
      });
    }
  });

router.get('/single/:id', authenticate, async (req, res) => {
    try {
      const sql = `
            SELECT 
                wd.id as walkinDriveId ,
                wd.drive_name,
                wd.drive_description ,
                wd.drive_description ,
                wd.to_date ,
                wd.from_date ,
                wd.dobDescription_id ,
                wd.status as WalkinDriveStatus ,
                jd.title ,
                jd.description ,
                jd.requirements ,
                jd.status as jdStatus ,
                jd.industryAvg ,
                JSON_ARRAYAGG(u.full_name) AS interviewer_names
            FROM walkin_drive wd
            JOIN job_descriptions jd 
                ON jd.id = wd.dobDescription_id
            JOIN JSON_TABLE(
                jd.interviewers,
                '$[*]' COLUMNS (
                    interviewer_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci PATH '$'
                )
            ) jt
                ON 1=1
            JOIN users u 
                ON u.id COLLATE utf8mb4_0900_ai_ci = jt.interviewer_id
                where wd.dobDescription_id = ?
            GROUP BY wd.id
           
            ;
            `; 
      const rows = await query(sql, [req.params.id]);
  
      const data = rows.map(jd => ({
        ...jd,
        interviewer_names: jd.interviewer_names ? JSON.parse(jd.interviewer_names) : [],
        resume_count: Number(jd.walkinDriveId) || 0
      }));
  
      res.json({
        success: true,
        count: data.length,
        data
      });
  
    } catch (error) {
      console.error('Error fetching Walkin Drive:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to fetch Walkin Drive',
        error: error.message
      });
    }
  });  

  router.post('/assignWalkInInterView', authenticate, requireWriteAccess, async (req, res) => {
    const { evaluation_id, interviewer_ids, start_time, is_video_call } = req.body;

    if (
      !evaluation_id ||
      !Array.isArray(interviewer_ids) ||
      interviewer_ids.length === 0 ||
      !start_time
    ) {
      return res.status(400).json({
        success: false,
        error: 'Invalid payload: evaluation_id, interviewer_ids array, and start_time are required'
      });
    }

    try {
      const slotMinutes = Number(process.env.INTERVIEW_TIME_SLOT || 30);
      const startDateTime = fromUTCString(start_time);
      if (!startDateTime || isNaN(startDateTime.getTime())) {
        return res.status(200).json({
          success: false,
          error: 'Invalid start_time format'
        });
      }
      const endDateTime = new Date(startDateTime.getTime() + slotMinutes * 60000);
      const startTimeUTC = toUTCString(startDateTime);
      const endTimeUTC = toUTCString(endDateTime);

      // Get evaluation with candidate and job details
      const evaluation = await queryOne(
        `SELECT ce.*,
          r.name as candidate_name, r.email as candidate_email,
          jd.title as job_title
         FROM candidate_evaluations ce
         LEFT JOIN resumes r ON ce.resume_id = r.id
         LEFT JOIN job_descriptions jd ON ce.job_description_id = jd.id
         WHERE ce.id = ?`,
        [evaluation_id]
      );

      if (!evaluation) {
        return res.status(200).json({
          success: false,
          error: 'Evaluation not found'
        });
      }

      // Validate each interviewer exists and is Interviewer
      for (const interviewerId of interviewer_ids) {
        const interviewer = await queryOne(
          'SELECT id, email, role, full_name, status FROM users WHERE id = ? AND role = ? AND status = ?',
          [interviewerId, 'Interviewer', 'active']
        );
        if (!interviewer) {
          return res.status(200).json({
            success: false,
            error: `Invalid or inactive interviewer ID: ${interviewerId}`
          });
        }
      }

      /* ---------------------------------------------------
         2️⃣ FREE OLD SLOTS (reassignment) – do this FIRST so overlap check does not see this candidate’s own slot
      --------------------------------------------------- */
      const oldInterviewDetails = await query(
        `SELECT interviewer_time_slots_id FROM interview_details WHERE candidate_evaluations_id = ?`,
        [evaluation_id]
      );
      const oldSlotIds = (oldInterviewDetails || [])
        .map((d) => d.interviewer_time_slots_id)
        .filter(Boolean);

      if (oldSlotIds.length > 0) {
        await query(
          `UPDATE interviewer_time_slots SET is_booked = 0, evaluation_id = NULL WHERE id IN (${oldSlotIds.map(() => '?').join(',')})`,
          oldSlotIds
        );
      }

      await query(
        'DELETE FROM interview_details WHERE candidate_evaluations_id = ?',
        [evaluation_id]
      );

      /* ---------------------------------------------------
         3️⃣ OVERLAP CHECK – only booked slots (e.g. 04:19–04:49 booked ⇒ 04:03–04:33 not allowed)
      --------------------------------------------------- */
      const interviewerPlaceholders = interviewer_ids.map(() => '?').join(',');
      const overlappingSlots = await query(
        `SELECT id FROM interviewer_time_slots
         WHERE interviewer_id IN (${interviewerPlaceholders})
           AND is_booked = 1
           AND start_time < ?
           AND end_time > ?`,
        [...interviewer_ids, endTimeUTC, startTimeUTC]
      );

      if (overlappingSlots.length > 0) {
        return res.status(200).json({
          success: false,
          error: 'The selected time overlaps with an existing booking. Please choose a different time.'
        });
      }

      /* ---------------------------------------------------
         4️⃣ CREATE SLOTS (one per interviewer, plain INSERT)
      --------------------------------------------------- */
      const slot_ids = [];
      for (const interviewerId of interviewer_ids) {
        await query(
          `INSERT INTO interviewer_time_slots (interviewer_id, start_time, end_time, is_booked)
           VALUES (?, ?, ?, 0)`,
          [interviewerId, startTimeUTC, endTimeUTC]
        );
        const row = await queryOne(
          `SELECT id FROM interviewer_time_slots
           WHERE interviewer_id = ? AND start_time = ? AND end_time = ?
           ORDER BY id DESC LIMIT 1`,
          [interviewerId, startTimeUTC, endTimeUTC]
        );
        if (!row) {
          return res.status(500).json({
            success: false,
            error: 'Failed to retrieve created slot for interviewer ' + interviewerId
          });
        }
        slot_ids.push(row.id);
      }

         const interviewDateUTC = startTimeUTC;

      const assignmentNote = oldInterviewDetails.length > 0 ? 'Walk-in reassignment' : 'Walk-in assignment';
      for (let i = 0; i < interviewer_ids.length; i++) {
        await query(
          `INSERT INTO interview_assignments (evaluation_id, interviewer_id, interview_date, assigned_by, notes)
           VALUES (?, ?, ?, ?, ?)`,
          [evaluation_id, interviewer_ids[i], interviewDateUTC, req.user.id, assignmentNote]
        );
        await query(
          `INSERT INTO interview_details (candidate_evaluations_id, interviewer_time_slots_id, interviewer_id, interviewer_status)
           VALUES (?, ?, ?, 'pending')`,
          [evaluation_id, slot_ids[i], interviewer_ids[i]]
        );
        await query(
          `UPDATE interviewer_time_slots SET is_booked = 1, evaluation_id = ?, job_description_id = ? WHERE id = ? AND is_booked = 0`,
          [evaluation_id, evaluation.job_description_id, slot_ids[i]]
        );
      }

   

      

      const createdSlots = await query(
        `SELECT * FROM interviewer_time_slots WHERE id IN (${slot_ids.map(() => '?').join(',')}) ORDER BY start_time ASC`,
        slot_ids
      );

      res.json({
        success: true,
        message: 'Slots generated and interview assigned successfully',
        data: convertResultToUTC(createdSlots)
      });
    } catch (error) {
      console.error('Error in assignWalkInInterView:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to assign walk-in interview',
        error: error.message
      });
    }
  });




module.exports = router;
