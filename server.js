// Main Server File
// Express.js server for the ATS (Applicant Tracking System) API
// Handles routing, middleware, and error handling

const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const multer = require('multer');
const uploadRoutes = require('./routes/upload');
const resumeRoutes = require('./routes/resumes');
const jobDescriptionRoutes = require('./routes/jobDescriptions');
const evaluationRoutes = require('./routes/evaluations');
const authRoutes = require('./routes/auth');
const interviewRoutes = require('./routes/interviews');
const candidateLinkRoutes = require('./routes/candidateLinks');
const configRoutes = require('./routes/config');

// Load environment variables from .env file
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware configuration
// CORS - Enable Cross-Origin Resource Sharing for frontend access
app.use(cors());
// JSON parser - Parse JSON request bodies
app.use(express.json());
// URL encoded parser - Parse URL-encoded request bodies
app.use(express.urlencoded({ extended: true }));

// API Routes
// Mount route handlers for different API endpoints
app.use('/api/auth', authRoutes);                    // Authentication routes (login, register)
app.use('/api/upload', uploadRoutes);               // File upload routes (single/bulk resume uploads)
app.use('/api/resumes', resumeRoutes);              // Resume management routes (CRUD operations)
app.use('/api/job-descriptions', jobDescriptionRoutes); // Job description routes (CRUD operations)
app.use('/api/evaluations', evaluationRoutes);       // Candidate evaluation routes
app.use('/api/interviews', interviewRoutes);         // Interview scheduling and management routes
app.use('/api/candidate-links', candidateLinkRoutes); // Candidate link generation and submission routes
app.use('/api/config', configRoutes);               // Configuration routes

// Health check endpoint
// Used to verify that the API server is running and accessible
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'ATS API is running' });
});

// Error handling middleware (must be after routes)
// Catches and handles errors from route handlers
app.use((error, req, res, next) => {
  // Handle multer file upload errors
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({
        success: false,
        error: 'File too large. Maximum file size is 10MB.'
      });
    }
    if (error.code === 'LIMIT_FILE_COUNT') {
      return res.status(400).json({
        success: false,
        error: 'Too many files. Maximum is 50 files.'
      });
    }
    return res.status(400).json({
      success: false,
      error: error.message || 'File upload error'
    });
  }
  
  // Handle other application errors
  if (error) {
    console.error('Error:', error);
    return res.status(error.status || 500).json({
      success: false,
      error: error.message || 'Internal server error'
    });
  }
  
  next();
});

// Start the server
// Listen on the configured PORT (default: 3000)
app.listen(PORT, () => {
  // Server started successfully
});

