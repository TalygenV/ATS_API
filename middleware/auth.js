const jwt = require('jsonwebtoken');
const { queryOne } = require('../config/database');

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-this-in-production';

// Middleware to authenticate user
const authenticate = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        error: 'No authentication token provided'
      });
    }

    const token = authHeader.split(' ')[1];

    // Verify JWT token
    let decoded;
    try {
      decoded = jwt.verify(token, JWT_SECRET);
    } catch (error) {
      return res.status(401).json({
        success: false,
        error: 'Invalid or expired token'
      });
    }

    // Get user from database
    const userData = await queryOne(
      'SELECT id, email, role, full_name, status FROM users WHERE id = ?',
      [decoded.id]
    );

    if (!userData) {
      return res.status(404).json({
        success: false,
        error: 'User profile not found'
      });
    }

    // Check if user is active
    if (userData.status !== 'active') {
      return res.status(200).json({
        success: false,
        error: 'Your account has been deactivated. Please contact an administrator.'
      });
    }

    // Attach user to request object
    req.user = userData;
    next();
  } catch (error) {
    console.error('Authentication error:', error);
    res.status(500).json({
      success: false,
      error: 'Authentication failed',
      message: error.message
    });
  }
};

// Middleware to check if user has required role(s)
const authorize = (...allowedRoles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        error: 'User not authenticated'
      });
    }

    if (!allowedRoles.includes(req.user.role)) {
      return res.status(200).json({
        success: false,
        error: 'Insufficient permissions. Required role: ' + allowedRoles.join(' or ')
      });
    }

    next();
  };
};

// Middleware to check if user has write access (HR or Admin)
const requireWriteAccess = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({
      success: false,
      error: 'User not authenticated'
    });
  }

  if (!['HR', 'Admin'].includes(req.user.role)) {
    return res.status(200).json({
      success: false,
      error: 'Write access denied. Only HR and Admin can perform this action.'
    });
  }

  next();
};

// Middleware to check if user has full access (Admin only)
const requireAdmin = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({
      success: false,
      error: 'User not authenticated'
    });
  }

  if (req.user.role !== 'Admin') {
    return res.status(200).json({
      success: false,
      error: 'Admin access required'
    });
  }

  next();
};

module.exports = {
  authenticate,
  authorize,
  requireWriteAccess,
  requireAdmin
};
