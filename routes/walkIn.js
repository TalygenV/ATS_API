const express = require('express');
const { query, queryOne } = require('../config/database');
const { authenticate, requireWriteAccess } = require('../middleware/auth');
const { convertResultToUTC } = require('../utils/datetimeUtils');

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
        updateValues.push(from_date);
      }
  
      if (to_date !== undefined) {
        updateFields.push('to_date = ?');
        updateValues.push(to_date);
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

module.exports = router;
