const serverless = require('serverless-http');
const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const multer = require('multer');
const path = require('path');

// Load environment variables
dotenv.config();

const app = express();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Import routes
const uploadRoutes = require('../../routes/upload');
const resumeRoutes = require('../../routes/resumes');
const jobDescriptionRoutes = require('../../routes/jobDescriptions');
const evaluationRoutes = require('../../routes/evaluations');
const authRoutes = require('../../routes/auth');
const interviewRoutes = require('../../routes/interviews');
const candidateLinkRoutes = require('../../routes/candidateLinks');

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/upload', uploadRoutes);
app.use('/api/resumes', resumeRoutes);
app.use('/api/job-descriptions', jobDescriptionRoutes);
app.use('/api/evaluations', evaluationRoutes);
app.use('/api/interviews', interviewRoutes);
app.use('/api/candidate-links', candidateLinkRoutes);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'ATS API is running on Netlify' });
});

// Error handling middleware (must be after routes)
app.use((error, req, res, next) => {
  // Handle multer errors
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
  
  // Handle other errors
  if (error) {
    console.error('Error:', error);
    return res.status(error.status || 500).json({
      success: false,
      error: error.message || 'Internal server error'
    });
  }
  
  next();
});

// Export the serverless handler
module.exports.handler = serverless(app);

