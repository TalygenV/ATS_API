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

module.exports = router;
