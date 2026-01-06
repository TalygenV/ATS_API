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



// Get groq API keys (Admin only)
router.get('/groq', authenticate, requireAdmin, async (req, res) => {
  try {
    // Get all active groq settings, sorted by active status first, then by modified date
    const groqSettings = await query(
      `SELECT id, GROQ_API_Key as api_key, GROQ_STATUS as is_active, Modified_at
       FROM AI_Settings 
       WHERE status = 'active' AND Type = 'groq'
       ORDER BY GROQ_STATUS DESC, Modified_at DESC`
    );

    res.json({
      success: true,
      data: groqSettings.map(setting => ({
        ...setting,
        is_active: Boolean(setting.is_active)
      }))
    });
  } catch (error) {
    console.error('Error fetching groq settings:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch groq settings',
      message: error.message
    });
  }
});

// Add groq API key (Admin only)
router.post('/groq', authenticate, requireAdmin, async (req, res) => {
  try {
    const { api_key } = req.body;

    // Validate required fields
    if (!api_key) {
      return res.status(400).json({
        success: false,
        error: 'API key is required'
      });
    }

    // Check if the API key already exists
    const existingKey = await queryOne(
      `SELECT id FROM AI_Settings 
       WHERE GROQ_API_Key = ? AND status = 'active' AND Type = 'groq'`,
      [api_key]
    );

    if (existingKey) {
      return res.status(400).json({
        success: false,
        error: 'This API key already exists'
      });
    }

    // Insert new groq setting as inactive
       await query(
      `INSERT INTO AI_Settings 
       (Type, GROQ_API_Key, GROQ_STATUS, Modified_by, Modified_at, status) 
       VALUES (?, ?, ?, ?, NOW(), 'active')`,
      [
        'groq',
        api_key,
        0, // GROQ_STATUS inactive
        req.user.id // Modified_by
      ]
    );

  

    res.json({
      success: true,
      message: 'groq API key added successfully'
    });
  } catch (error) {
    console.error('Error adding groq API key:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to add groq API key',
      message: error.message
    });
  }
});

// Update groq API key status (Admin only)
router.patch('/groq/:id/status', authenticate, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { is_active } = req.body;

    const keyId = parseInt(id, 10);
    if (isNaN(keyId)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid key ID'
      });
    }

    // Validate is_active
    if (typeof is_active !== 'boolean') {
      return res.status(400).json({
        success: false,
        error: 'is_active must be a boolean'
      });
    }

    if (is_active) {
      // If enabling, disable all other active keys first
      await query(
        `UPDATE AI_Settings 
         SET GROQ_STATUS = 0, Modified_by = ?, Modified_at = NOW() 
         WHERE status = 'active' AND Type = 'groq' AND id != ?`,
        [req.user.id, keyId]
      );
    } else {
      // If disabling, check if it's the only active key
      const activeCount = await queryOne(
        `SELECT COUNT(*) as count FROM AI_Settings 
         WHERE status = 'active' AND Type = 'groq' AND GROQ_STATUS = 1`
      );
      if (activeCount.count <= 1) {
        return res.status(400).json({
          success: false,
          error: 'Cannot disable the last active groq API key'
        });
      }
    }

    // Update the status
    const result = await query(
      `UPDATE AI_Settings 
       SET GROQ_STATUS = ?, Modified_by = ?, Modified_at = NOW() 
       WHERE id = ? AND status = 'active' AND Type = 'groq'`,
      [
        is_active ? 1 : 0,
        req.user.id,
        keyId
      ]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({
        success: false,
        error: 'groq API key not found'
      });
    }

    res.json({
      success: true,
      message: 'groq API key status updated successfully'
    });
  } catch (error) {
    console.error('Error updating groq API key status:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update groq API key status',
      message: error.message
    });
  }
});



// Delete groq API key (Admin only) - Permanent delete
router.delete('/groq/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    const keyId = parseInt(id, 10);
    if (isNaN(keyId)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid key ID'
      });
    }

    // Check if the key exists and is active
    const existingKey = await queryOne(
      `SELECT id, GROQ_STATUS FROM AI_Settings 
       WHERE id = ? AND status = 'active' AND Type = 'groq'`,
      [keyId]
    );

    if (!existingKey) {
      return res.status(404).json({
        success: false,
        error: 'groq API key not found'
      });
    }

    // If it's the only active key, prevent deletion
    if (existingKey.GROQ_STATUS === 1) {
      const activeCount = await queryOne(
        `SELECT COUNT(*) as count FROM AI_Settings 
         WHERE status = 'active' AND Type = 'groq' AND GROQ_STATUS = 1`
      );
      if (activeCount.count <= 1) {
        return res.status(400).json({
          success: false,
          error: 'Cannot delete the last active groq API key'
        });
      }
    }

    // Permanent delete
    const result = await query(
      `DELETE FROM AI_Settings 
       WHERE id = ? AND status = 'active' AND Type = 'groq'`,
      [keyId]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({
        success: false,
        error: 'groq API key not found'
      });
    }

    res.json({
      success: true,
      message: 'groq API key deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting groq API key:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to delete groq API key',
      message: error.message
    });
  }
});



module.exports = router;
