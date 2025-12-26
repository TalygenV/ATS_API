const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { query, queryOne } = require('../config/database');
const { authenticate, requireAdmin, requireWriteAccess } = require('../middleware/auth');
const { convertResultToUTC } = require('../utils/datetimeUtils');

const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-this-in-production';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';

// Register new user (Admin only)
router.post('/register', authenticate, requireAdmin, async (req, res) => {
  try {
    const { email, password, role, full_name } = req.body;

    // Validate input
    if (!email || !password || !role) {
      return res.status(400).json({
        success: false,
        error: 'Email, password, and role are required'
      });
    }

    // Validate role
    if (!['HR', 'Interviewer', 'Admin'].includes(role)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid role. Must be HR, Interviewer, or Admin'
      });
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid email format'
      });
    }

    // Check if user already exists
    const existingUser = await queryOne(
      'SELECT email FROM users WHERE email = ?',
      [email.toLowerCase().trim()]
    );

    if (existingUser) {
      return res.status(400).json({
        success: false,
        error: 'User with this email already exists'
      });
    }

    // Hash password
    const saltRounds = 10;
    const passwordHash = await bcrypt.hash(password, saltRounds);

    // Create user
    const userId = uuidv4();
    await query(
      'INSERT INTO users (id, email, password_hash, role, full_name) VALUES (?, ?, ?, ?, ?)',
      [userId, email.toLowerCase().trim(), passwordHash, role, full_name || null]
    );

    // Get created user (without password)
    const userData = await queryOne(
      'SELECT id, email, role, full_name, status FROM users WHERE id = ?',
      [userId]
    );

    res.json({
      success: true,
      message: 'User registered successfully',
      data: userData
    });
  } catch (error) {
    console.error('Error registering user:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to register user',
      message: error.message
    });
  }
});

// Login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        error: 'Email and password are required'
      });
    }

    // Get user from database
    const user = await queryOne(
      'SELECT id, email, password_hash, role, full_name, status FROM users WHERE email = ?',
      [email.toLowerCase().trim()]
    );

    if (!user) {
      return res.status(401).json({
        success: false,
        error: 'Invalid email or password'
      });
    }

    // Check if user is active
    if (user.status !== 'active') {
      return res.status(403).json({
        success: false,
        error: 'Your account has been deactivated. Please contact an administrator.'
      });
    }

    // Verify password
    const passwordMatch = await bcrypt.compare(password, user.password_hash);

    if (!passwordMatch) {
      return res.status(401).json({
        success: false,
        error: 'Invalid email or password'
      });
    }

    // Generate JWT token
    const token = jwt.sign(
      {
        id: user.id,
        email: user.email,
        role: user.role
      },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN }
    );

    // Remove password from response
    delete user.password_hash;

    res.json({
      success: true,
      message: 'Login successful',
      data: {
        user: {
          id: user.id,
          email: user.email,
          role: user.role,
          full_name: user.full_name
        },
        session: {
          access_token: token,
          expires_in: JWT_EXPIRES_IN
        }
      }
    });
  } catch (error) {
    console.error('Error logging in:', error);
    
    // Handle database connection errors
    if (error.code === 'ETIMEDOUT' || error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
      return res.status(503).json({
        success: false,
        error: 'Database connection error',
        message: 'Unable to connect to the database. Please try again later or contact support.'
      });
    }
    
    res.status(500).json({
      success: false,
      error: 'Failed to login',
      message: error.message
    });
  }
});

// Get current user (requires authentication token)
router.get('/me', authenticate, async (req, res) => {
  try {
    // User is already attached to req by authenticate middleware
    res.json({
      success: true,
      data: {
        id: req.user.id,
        email: req.user.email,
        role: req.user.role,
        full_name: req.user.full_name
      }
    });
  } catch (error) {
    console.error('Error fetching current user:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch user',
      message: error.message
    });
  }
});

// Logout
router.post('/logout', authenticate, async (req, res) => {
  try {
    // With JWT, logout is handled client-side by removing the token
    // No server-side action needed
    res.json({
      success: true,
      message: 'Logout successful'
    });
  } catch (error) {
    console.error('Error logging out:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to logout',
      message: error.message
    });
  }
});

// Get all users (for HR/Admin to select interviewers and manage users)
router.get('/users', authenticate, requireWriteAccess, async (req, res) => {
  try {
    const { role, active_only = 'true' } = req.query;
    
    let sql = 'SELECT id, email, role, full_name, status, created_at FROM users WHERE 1=1';
    const params = [];
    
    if (role) {
      sql += ' AND role = ?';
      params.push(role);
    }
    
    // If active_only is true and role is Interviewer, filter to only active interviewers
    // This is useful for interview assignment dropdowns
    if (active_only === 'true' && role === 'Interviewer') {
      sql += ' AND status = ?';
      params.push('active');
    }
    
    sql += ' ORDER BY full_name, email';
    
    const users = await query(sql, params);
    
    res.json({
      success: true,
      count: users.length,
      data: convertResultToUTC(users)
    });
  } catch (error) {
    console.error('Error fetching users:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch users',
      message: error.message
    });
  }
});

// Update user (Admin only) - can update password, full_name, and status
router.put('/users/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { password, full_name, status } = req.body;

    // Validate that at least one field is being updated
    if (!password && full_name === undefined && !status) {
      return res.status(400).json({
        success: false,
        error: 'At least one field (password, full_name, or status) must be provided'
      });
    }

    // Validate status if provided
    if (status && !['active', 'inactive'].includes(status)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid status. Must be "active" or "inactive"'
      });
    }

    // Check if user exists
    const existingUser = await queryOne(
      'SELECT id, email, role FROM users WHERE id = ?',
      [id]
    );

    if (!existingUser) {
      return res.status(404).json({
        success: false,
        error: 'User not found'
      });
    }

    // Build update query dynamically
    const updates = [];
    const params = [];

    if (password) {
      // Validate password length
      if (password.length < 6) {
        return res.status(400).json({
          success: false,
          error: 'Password must be at least 6 characters long'
        });
      }
      // Hash password
      const saltRounds = 10;
      const passwordHash = await bcrypt.hash(password, saltRounds);
      updates.push('password_hash = ?');
      params.push(passwordHash);
    }

    if (full_name !== undefined) {
      updates.push('full_name = ?');
      params.push(full_name || null);
    }

    if (status) {
      updates.push('status = ?');
      params.push(status);
    }

    // Add user id to params
    params.push(id);

    // Execute update
    await query(
      `UPDATE users SET ${updates.join(', ')} WHERE id = ?`,
      params
    );

    // Get updated user (without password)
    const userData = await queryOne(
      'SELECT id, email, role, full_name, status, created_at FROM users WHERE id = ?',
      [id]
    );

    res.json({
      success: true,
      message: 'User updated successfully',
      data: convertResultToUTC(userData)
    });
  } catch (error) {
    console.error('Error updating user:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update user',
      message: error.message
    });
  }
});

// Get all assigned interviewer list by job discription (for HR/Admin to select interviewers)
router.get('/already-assigned-interviewer-list/:id', authenticate, requireWriteAccess, async (req, res) => {
  try {
     const job_description_id = req.params.id
    
    let sql = `SELECT 
  jd.id AS job_id,
  u.id AS id,
  u.full_name,
  u.email,
  u.role,
  u.status
FROM job_descriptions jd
JOIN users u
  ON JSON_CONTAINS(jd.interviewers, JSON_QUOTE(u.id))
WHERE jd.id = ? AND u.status ='active' 
 ORDER BY u.full_name, u.email;
`
    const params = [ job_description_id ];
    

    
    const users = await query(sql, params);
    
    res.json({
      success: true,
      count: users.length,
      data: convertResultToUTC(users)
    });
  } catch (error) {
    console.error('Error fetching users:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch users',
      message: error.message
    });
  }
});

module.exports = router;
