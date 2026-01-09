// Authentication Middleware
// This module provides authentication and authorization middleware functions
// Handles JWT token verification and role-based access control

const jwt = require('jsonwebtoken');
const { queryOne } = require('../config/database');

// JWT secret key from environment variables or default (should be changed in production)
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-this-in-production';

/**
 * Middleware to authenticate user via JWT token
 * Verifies JWT token from Authorization header and loads user data from database
 * Attaches user object to request for use in route handlers
 * 
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next middleware function
 */
const authenticate = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        error: 'No authentication token provided'
      });
    }

    // Extract token from "Bearer <token>" format
    const token = authHeader.split(' ')[1];

    // Verify JWT token signature and expiration
    let decoded;
    try {
      decoded = jwt.verify(token, JWT_SECRET);
    } catch (error) {
      return res.status(401).json({
        success: false,
        error: 'Invalid or expired token'
      });
    }

    // Get user data from database using decoded user ID
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

    // Check if user account is active
    if (userData.status !== 'active') {
      return res.status(200).json({
        success: false,
        error: 'Your account has been deactivated. Please contact an administrator.'
      });
    }

    // Attach user data to request object for use in route handlers
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

/**
 * Middleware factory to check if user has required role(s)
 * Returns a middleware function that checks if user's role matches any of the allowed roles
 * 
 * @param {...string} allowedRoles - One or more allowed roles (e.g., 'HR', 'Admin', 'Interviewer')
 * @returns {Function} Express middleware function
 */
const authorize = (...allowedRoles) => {
  return (req, res, next) => {
    // Ensure user is authenticated first
    if (!req.user) {
      return res.status(401).json({
        success: false,
        error: 'User not authenticated'
      });
    }

    // Check if user's role is in the allowed roles list
    if (!allowedRoles.includes(req.user.role)) {
      return res.status(200).json({
        success: false,
        error: 'Insufficient permissions. Required role: ' + allowedRoles.join(' or ')
      });
    }

    next();
  };
};

/**
 * Middleware to check if user has write access (HR or Admin only)
 * Used to protect routes that modify data (create, update, delete operations)
 * 
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next middleware function
 */
const requireWriteAccess = (req, res, next) => {
  // Ensure user is authenticated
  if (!req.user) {
    return res.status(401).json({
      success: false,
      error: 'User not authenticated'
    });
  }

  // Check if user has HR or Admin role
  if (!['HR', 'Admin'].includes(req.user.role)) {
    return res.status(200).json({
      success: false,
      error: 'Write access denied. Only HR and Admin can perform this action.'
    });
  }

  next();
};

/**
 * Middleware to check if user has admin access (Admin only)
 * Used to protect routes that require full administrative privileges
 * 
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next middleware function
 */
const requireAdmin = (req, res, next) => {
  // Ensure user is authenticated
  if (!req.user) {
    return res.status(401).json({
      success: false,
      error: 'User not authenticated'
    });
  }

  // Check if user has Admin role
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
