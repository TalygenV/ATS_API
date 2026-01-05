const express = require('express');
const router = express.Router();
const { authenticate, requireAdmin } = require('../middleware/auth');
const { query, queryOne } = require('../config/database');

// Get SMTP settings (Admin only)
router.get('/smtp', authenticate, requireAdmin, async (req, res) => {
  try {
    // Get the most recent active SMTP setting
    const smtpSetting = await queryOne(
      `SELECT id, smtp_server, smtp_user_name, smtp_password, from_email, 
              smtp_port, is_secure_smtp, smtp_type, status, created_at
       FROM SMTPSetting 
       WHERE status = 'active' 
       ORDER BY created_at DESC 
       LIMIT 1`
    );

    if (!smtpSetting) {
      return res.json({
        success: true,
        data: null,
        message: 'No SMTP settings found'
      });
    }

    // Convert is_secure_smtp from TINYINT to boolean
    smtpSetting.is_secure_smtp = Boolean(smtpSetting.is_secure_smtp);

    res.json({
      success: true,
      data: smtpSetting
    });
  } catch (error) {
    console.error('Error fetching SMTP settings:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch SMTP settings',
      message: error.message
    });
  }
});

// Update SMTP settings (Admin only)
router.put('/smtp', authenticate, requireAdmin, async (req, res) => {
  try {
    const {
      smtp_server,
      smtp_user_name,
      smtp_password,
      from_email,
      smtp_port,
      is_secure_smtp,
      smtp_type
    } = req.body;

    // Validate required fields
    if (!smtp_server || !smtp_user_name || !smtp_password || !from_email || !smtp_port || !smtp_type) {
      return res.status(400).json({
        success: false,
        error: 'All fields are required'
      });
    }

    // Check if there's an existing active setting
    const existingSetting = await queryOne(
      `SELECT id FROM SMTPSetting WHERE status = 'active' ORDER BY created_at DESC LIMIT 1`
    );

    if (existingSetting) {
      // Deactivate the old setting
      await query(
        `UPDATE SMTPSetting SET status = 'inactive' WHERE id = ?`,
        [existingSetting.id]
      );
    }

    // Create new active setting
    const result = await query(
      `INSERT INTO SMTPSetting 
       (smtp_server, smtp_user_name, smtp_password, from_email, smtp_port, 
        is_secure_smtp, smtp_type, created_by, created_at, status) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), 'active')`,
      [
        smtp_server,
        smtp_user_name,
        smtp_password,
        from_email,
        smtp_port,
        is_secure_smtp ? 1 : 0,
        smtp_type,
        req.user.id // created_by
      ]
    );

    // Fetch the newly created setting
    const newSetting = await queryOne(
      `SELECT id, smtp_server, smtp_user_name, smtp_password, from_email, 
              smtp_port, is_secure_smtp, smtp_type, status, created_at
       FROM SMTPSetting 
       WHERE id = ?`,
      [result.insertId]
    );

    // Convert is_secure_smtp from TINYINT to boolean
    newSetting.is_secure_smtp = Boolean(newSetting.is_secure_smtp);

    res.json({
      success: true,
      data: newSetting,
      message: 'SMTP settings updated successfully'
    });
  } catch (error) {
    console.error('Error updating SMTP settings:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update SMTP settings',
      message: error.message
    });
  }
});

// Get Zoom settings (Admin only)
router.get('/zoom', authenticate, requireAdmin, async (req, res) => {
  try {
    // Get the most recent active Zoom setting with Type = 'zoom'
    const zoomSetting = await queryOne(
      `SELECT id, Type, ZOOM_ACCOUNT_ID, ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET, 
              Zoom_join_before_host, Zoom_waiting_room, Zoom_Email, status, Modified_at
       FROM Meeting_Settings 
       WHERE status = 'active' AND Type = 'zoom'
       ORDER BY Modified_at DESC 
       LIMIT 1`
    );

    if (!zoomSetting) {
      return res.json({
        success: true,
        data: null,
        message: 'No Zoom settings found'
      });
    }

    // Convert TINYINT fields to boolean
    zoomSetting.Zoom_join_before_host = Boolean(zoomSetting.Zoom_join_before_host);
    zoomSetting.Zoom_waiting_room = Boolean(zoomSetting.Zoom_waiting_room);

    res.json({
      success: true,
      data: zoomSetting
    });
  } catch (error) {
    console.error('Error fetching Zoom settings:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch Zoom settings',
      message: error.message
    });
  }
});

// Update Zoom settings (Admin only)
router.put('/zoom', authenticate, requireAdmin, async (req, res) => {
  try {
    const {
      ZOOM_ACCOUNT_ID,
      ZOOM_CLIENT_ID,
      ZOOM_CLIENT_SECRET,
      Zoom_join_before_host,
      Zoom_waiting_room,
      Zoom_Email
    } = req.body;

    // Validate required fields
    if (!ZOOM_ACCOUNT_ID || !ZOOM_CLIENT_ID || !ZOOM_CLIENT_SECRET) {
      return res.status(400).json({
        success: false,
        error: 'Zoom Account ID, Client ID, and Client Secret are required'
      });
    }

    // Check if there's an existing active setting with Type = 'zoom'
    const existingSetting = await queryOne(
      `SELECT id FROM Meeting_Settings 
       WHERE status = 'active' AND Type = 'zoom' 
       ORDER BY Modified_at DESC LIMIT 1`
    );

    if (existingSetting) {
      // Deactivate the old setting
      await query(
        `UPDATE Meeting_Settings SET status = 'inactive' WHERE id = ?`,
        [existingSetting.id]
      );
    }

    // Create new active setting
    const result = await query(
      `INSERT INTO Meeting_Settings 
       (Type, ZOOM_ACCOUNT_ID, ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET, 
        Zoom_join_before_host, Zoom_waiting_room, Zoom_Email, 
        Modified_by, Modified_at, status) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), 'active')`,
      [
        'zoom', // Type
        ZOOM_ACCOUNT_ID,
        ZOOM_CLIENT_ID,
        ZOOM_CLIENT_SECRET,
        Zoom_join_before_host ? 1 : 0,
        Zoom_waiting_room ? 1 : 0,
        Zoom_Email || null,
        req.user.id // Modified_by
      ]
    );

    // Fetch the newly created setting
    const newSetting = await queryOne(
      `SELECT id, Type, ZOOM_ACCOUNT_ID, ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET, 
              Zoom_join_before_host, Zoom_waiting_room, Zoom_Email, status, Modified_at
       FROM Meeting_Settings 
       WHERE id = ?`,
      [result.insertId]
    );

    // Convert TINYINT fields to boolean
    newSetting.Zoom_join_before_host = Boolean(newSetting.Zoom_join_before_host);
    newSetting.Zoom_waiting_room = Boolean(newSetting.Zoom_waiting_room);

    res.json({
      success: true,
      data: newSetting,
      message: 'Zoom settings updated successfully'
    });
  } catch (error) {
    console.error('Error updating Zoom settings:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update Zoom settings',
      message: error.message
    });
  }
});

module.exports = router;
