const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const multer = require('multer');
const uploadRoutes = require('./routes/upload');
const resumeRoutes = require('./routes/resumes');
const jobDescriptionRoutes = require('./routes/jobDescriptions');
const evaluationRoutes = require('./routes/evaluations');
const authRoutes = require('./routes/auth');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/upload', uploadRoutes);
app.use('/api/resumes', resumeRoutes);
app.use('/api/job-descriptions', jobDescriptionRoutes);
app.use('/api/evaluations', evaluationRoutes);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'ATS API is running' });
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

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

