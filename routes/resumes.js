const express = require('express');
const axios = require('axios');
const { query, queryOne } = require('../config/database');
const { authenticate, requireWriteAccess } = require('../middleware/auth');

const router = express.Router();

// Helper function to safely parse JSON fields
const safeParseJSON = (value, defaultValue = null) => {
  if (value === null || value === undefined) {
    return defaultValue;
  }
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch (e) {
      return defaultValue;
    }
  }
  return value;
};

// Get all resumes (all authenticated users can view)
router.get('/', authenticate, async (req, res) => {
  try {
    const resumes = await query(
      'SELECT * FROM resumes ORDER BY created_at DESC'
    );

    // Parse JSON fields
    const parsedResumes = resumes.map(resume => ({
      ...resume,
      skills: resume.skills ? JSON.parse(resume.skills) : [],
      experience: resume.experience ? JSON.parse(resume.experience) : [],
      education: resume.education ? JSON.parse(resume.education) : [],
      certifications: resume.certifications ? JSON.parse(resume.certifications) : []
    }));

    res.json({
      success: true,
      count: parsedResumes.length,
      data: parsedResumes
    });
  } catch (error) {
    console.error('Error fetching resumes:', error);
    res.status(500).json({
      error: 'Failed to fetch resumes',
      message: error.message
    });
  }
});

// Get resume by ID (all authenticated users can view)
router.get('/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;

    const resume = await queryOne(
      'SELECT * FROM resumes WHERE id = ?',
      [id]
    );

    if (!resume) {
      return res.status(404).json({ error: 'Resume not found' });
    }

    // Parse JSON fields safely
    const parsedResume = {
      ...resume,
      skills: safeParseJSON(resume.skills, []),
      experience: safeParseJSON(resume.experience, []),
      education: safeParseJSON(resume.education, []),
      certifications: safeParseJSON(resume.certifications, [])
    };

    res.json({
      success: true,
      data: parsedResume
    });
  } catch (error) {
    console.error('Error fetching resume:', error);
    res.status(500).json({
      error: 'Failed to fetch resume',
      message: error.message
    });
  }
});

// Search resumes (all authenticated users can view)
router.get('/search/:query', authenticate, async (req, res) => {
  try {
    const { query: searchQuery } = req.params;
    const searchTerm = `%${searchQuery}%`;

    const resumes = await query(
      `SELECT * FROM resumes 
       WHERE name LIKE ? OR email LIKE ? OR location LIKE ?
       ORDER BY created_at DESC`,
      [searchTerm, searchTerm, searchTerm]
    );

    // Parse JSON fields
    const parsedResumes = resumes.map(resume => ({
      ...resume,
      skills: resume.skills ? JSON.parse(resume.skills) : [],
      experience: resume.experience ? JSON.parse(resume.experience) : [],
      education: resume.education ? JSON.parse(resume.education) : [],
      certifications: resume.certifications ? JSON.parse(resume.certifications) : []
    }));

    res.json({
      success: true,
      count: parsedResumes.length,
      data: parsedResumes
    });
  } catch (error) {
    console.error('Error searching resumes:', error);
    res.status(500).json({
      error: 'Failed to search resumes',
      message: error.message
    });
  }
});

// Download original resume file (all authenticated users can download)
router.get('/:id/download', authenticate, async (req, res) => {
  const startTime = Date.now();
  console.log(`\n==========================================`);
  console.log(`📥 DOWNLOAD REQUEST - Resume ID: ${req.params.id}`);
  console.log(`==========================================`);
  
  try {
    const { id } = req.params;
    const fs = require('fs').promises;
    const path = require('path');

    console.log(`🔍 Step 1: Looking up resume with ID: ${id}`);
    const resume = await queryOne(
      'SELECT  file_name FROM resumes WHERE id = ?',
      [id]
    );

    if (!resume) {
      console.error(`❌ Resume not found with ID: ${id}`);
      return res.status(404).json({ error: 'Resume not found' });
    }

    console.log(`✅ Resume found:`);
    console.log(`   - File Name: ${resume.file_name}`);

    // First, try to find the file in file_uploads table (Talygen storage)
    // Use resume_id for direct connection
    console.log(`\n🔍 Step 2: Searching for file_upload record...`);
    console.log(`   - Searching by resume_id: ${id}`);
    
    let fileUpload = await queryOne(
      'SELECT * FROM file_uploads WHERE resume_id = ? ORDER BY created_at DESC LIMIT 1',
      [id]
    );

    // Fallback: If not found by resume_id, try filename matching (for backward compatibility)
    if (!fileUpload) {
      console.log(`   - Not found by resume_id, trying filename match (backward compatibility)...`);
      console.log(`   - Searching by exact match: original_file_name = "${resume.file_name}"`);
      
      fileUpload = await queryOne(
        'SELECT * FROM file_uploads WHERE original_file_name = ? ORDER BY created_at DESC LIMIT 1',
        [resume.file_name]
      );

      // If not found by exact match, try case-insensitive match
      if (!fileUpload) {
        console.log(`   - Exact match not found, trying case-insensitive match...`);
        fileUpload = await queryOne(
          'SELECT * FROM file_uploads WHERE LOWER(original_file_name) = LOWER(?) ORDER BY created_at DESC LIMIT 1',
          [resume.file_name]
        );
      }

      // If still not found, try matching by file_name column
      if (!fileUpload) {
        console.log(`   - Case-insensitive match not found, trying file_name column match...`);
        fileUpload = await queryOne(
          'SELECT * FROM file_uploads WHERE file_name = ? OR LOWER(file_name) = LOWER(?) ORDER BY created_at DESC LIMIT 1',
          [resume.file_name, resume.file_name]
        );
      }
    }

    if (fileUpload) {
      console.log(`✅ File upload record found:`);
      console.log(`   - ID: ${fileUpload.id}`);
      console.log(`   - Original File Name: ${fileUpload.original_file_name}`);
      console.log(`   - File Name: ${fileUpload.file_name || 'N/A'}`);
      console.log(`   - File Path (Live URL): ${fileUpload.file_path || 'N/A'}`);
      console.log(`   - File Type: ${fileUpload.file_type || 'N/A'}`);
      console.log(`   - Upload Status: ${fileUpload.upload_status || 'N/A'}`);
      console.log(`   - Created At: ${fileUpload.created_at || 'N/A'}`);
    } else {
      console.log(`⚠️  No file_upload record found for resume file: "${resume.file_name}"`);
    }

    if (fileUpload && fileUpload.file_path) {
      // File is stored in Talygen, download from the live URL
      console.log(`\n🌐 Step 3: Downloading from Talygen live URL...`);
      console.log(`   - Live URL: ${fileUpload.file_path}`);
      
      try {
        console.log(`   - Making HTTP GET request to live URL...`);
        const response = await axios.get(fileUpload.file_path, {
          responseType: 'stream',
          timeout: 30000, // 30 second timeout
          validateStatus: function (status) {
            return status >= 200 && status < 400; // Accept 2xx and 3xx status codes
          }
        });

        console.log(`✅ HTTP Response received:`);
        console.log(`   - Status Code: ${response.status}`);
        console.log(`   - Status Text: ${response.statusText}`);
        console.log(`   - Content-Type: ${response.headers['content-type'] || 'Not provided'}`);
        console.log(`   - Content-Length: ${response.headers['content-length'] || 'Not provided'}`);
        console.log(`   - All Headers:`, JSON.stringify(response.headers, null, 2));

        // Determine content type from file extension or response headers
        const fileExt = path.extname(fileUpload.file_name || fileUpload.original_file_name || resume.file_name || '').toLowerCase();
        console.log(`   - Detected File Extension: ${fileExt || 'None'}`);
        
        const mimeTypes = {
          '.pdf': 'application/pdf',
          '.doc': 'application/msword',
          '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          '.txt': 'text/plain',
          '.png': 'image/png',
          '.jpg': 'image/jpeg',
          '.jpeg': 'image/jpeg'
        };
        const contentType = response.headers['content-type'] || mimeTypes[fileExt] || 'application/octet-stream';
        console.log(`   - Final Content-Type: ${contentType}`);

        // Get filename for download
        const downloadFileName = fileUpload.file_name || fileUpload.original_file_name || resume.file_name || `resume-${id}${fileExt}`;
        console.log(`   - Download File Name: ${downloadFileName}`);

        // Set headers for file download
        res.setHeader('Content-Type', contentType);
        res.setHeader('Content-Disposition', `attachment; filename="${downloadFileName}"; filename*=UTF-8''${encodeURIComponent(downloadFileName)}`);
        
        console.log(`   - Response Headers Set:`);
        console.log(`     * Content-Type: ${contentType}`);
        console.log(`     * Content-Disposition: attachment; filename="${downloadFileName}"`);

        // Pipe the response stream to the client
        console.log(`   - Piping stream to client...`);
        response.data.pipe(res);

        // Handle stream events for debugging
        let totalBytesReceived = 0;
        response.data.on('data', (chunk) => {
          totalBytesReceived += chunk.length;
          console.log(`   - Stream chunk received: ${chunk.length} bytes (Total: ${totalBytesReceived} bytes)`);
        });

        response.data.on('end', () => {
          const totalTime = ((Date.now() - startTime) / 1000).toFixed(2);
          console.log(`✅ File stream completed successfully`);
          console.log(`   - Total bytes received: ${totalBytesReceived} bytes`);
          console.log(`⏱️  Total time: ${totalTime}s`);
          console.log(`==========================================\n`);
        });

        response.data.on('error', (streamError) => {
          console.error(`❌ Stream error:`, streamError);
          console.error(`   - Error message: ${streamError.message}`);
          console.error(`   - Error code: ${streamError.code || 'N/A'}`);
        });

        console.log(`✅ File download initiated from Talygen live URL`);
        return;
      } catch (talygenError) {
        console.error(`\n❌ Error downloading from Talygen live URL:`);
        console.error(`   - Error Message: ${talygenError.message}`);
        console.error(`   - Error Code: ${talygenError.code || 'N/A'}`);
        console.error(`   - Status Code: ${talygenError.response?.status || 'N/A'}`);
        console.error(`   - Status Text: ${talygenError.response?.statusText || 'N/A'}`);
        if (talygenError.response?.data) {
          const dataPreview = typeof talygenError.response.data === 'string' 
            ? talygenError.response.data.substring(0, 200) 
            : JSON.stringify(talygenError.response.data).substring(0, 200);
          console.error(`   - Response Data: ${dataPreview}`);
        }
        console.error(`   - Stack Trace:`, talygenError.stack);
        console.log(`⚠️  Falling back to local file download...`);
        // Fall through to local file download
      }
    } else {
      console.log(`\n⚠️  No file_upload record or file_path not available, using local file...`);
    }

    // Fallback: Try to download from local file system
    console.log(`\n💾 Step 4: Fallback to local file system...`);
    
    if (!resume.file_path) {
      console.error(`❌ No local file path available`);
      return res.status(404).json({ error: 'Original file not found. File may have been deleted.' });
    }

    console.log(`   - Local File Path: ${resume.file_path}`);

    // Check if file exists on disk
    try {
      console.log(`   - Checking if file exists on disk...`);
      await fs.access(resume.file_path);
      console.log(`   ✅ File exists on disk`);
      
      // Get file stats
      const stats = await fs.stat(resume.file_path);
      console.log(`   - File Size: ${stats.size} bytes`);
      console.log(`   - File Modified: ${stats.mtime}`);
    } catch (accessError) {
      console.error(`❌ File access error:`, accessError.message);
      return res.status(404).json({ error: 'Original file not found on server. The file may have been moved or deleted.' });
    }

    // Get file extension from the actual file path
    const fileExt = path.extname(resume.file_path).toLowerCase();
    console.log(`   - File Extension: ${fileExt || 'None'}`);
    
    const mimeTypes = {
      '.pdf': 'application/pdf',
      '.doc': 'application/msword',
      '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      '.txt': 'text/plain'
    };
    const contentType = mimeTypes[fileExt] || 'application/octet-stream';
    console.log(`   - Content-Type: ${contentType}`);

    // Get original filename from database
    let originalFileName = resume.file_name || `resume-${id}`;
    console.log(`   - Original File Name: ${originalFileName}`);
    
    // Ensure the filename has the correct extension matching the actual file
    const originalExt = path.extname(originalFileName).toLowerCase();
    if (originalExt !== fileExt) {
      // Remove any existing extension and add the correct one
      originalFileName = originalFileName.replace(/\.[^/.]+$/, '') + fileExt;
      console.log(`   - Adjusted File Name (extension corrected): ${originalFileName}`);
    }
    
    // Sanitize filename but preserve extension
    const nameWithoutExt = originalFileName.replace(/\.[^/.]+$/, '');
    const sanitizedName = nameWithoutExt.replace(/[^a-zA-Z0-9._-]/g, '_');
    const finalFileName = sanitizedName + fileExt;
    console.log(`   - Final Download File Name: ${finalFileName}`);

    // Set headers for file download with proper encoding
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${finalFileName}"; filename*=UTF-8''${encodeURIComponent(finalFileName)}`);
    
    console.log(`   - Response Headers Set:`);
    console.log(`     * Content-Type: ${contentType}`);
    console.log(`     * Content-Disposition: attachment; filename="${finalFileName}"`);

    // Read and send the file
    console.log(`   - Reading file from disk...`);
    const fileBuffer = await fs.readFile(resume.file_path);
    console.log(`   - File read successfully: ${fileBuffer.length} bytes`);
    console.log(`   - Sending file buffer to client...`);
    
    res.send(fileBuffer);
    
    const totalTime = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`✅ File downloaded from local storage: ${finalFileName}`);
    console.log(`⏱️  Total time: ${totalTime}s`);
    console.log(`==========================================\n`);
  } catch (error) {
    const totalTime = ((Date.now() - startTime) / 1000).toFixed(2);
    console.error(`\n❌ ERROR downloading resume:`);
    console.error(`   - Error Message: ${error.message}`);
    console.error(`   - Error Code: ${error.code || 'N/A'}`);
    console.error(`   - Error Name: ${error.name || 'N/A'}`);
    if (error.response) {
      console.error(`   - Response Status: ${error.response.status || 'N/A'}`);
      console.error(`   - Response Status Text: ${error.response.statusText || 'N/A'}`);
    }
    console.error(`   - Stack Trace:`, error.stack);
    console.error(`⏱️  Total time before error: ${totalTime}s`);
    console.error(`==========================================\n`);
    
    res.status(500).json({
      error: 'Failed to download resume',
      message: error.message
    });
  }
});

// Delete resume (only HR and Admin can delete)
router.delete('/:id', authenticate, requireWriteAccess, async (req, res) => {
  try {
    const { id } = req.params;

    const result = await query(
      'DELETE FROM resumes WHERE id = ?',
      [id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Resume not found' });
    }

    res.json({
      success: true,
      message: 'Resume deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting resume:', error);
    res.status(500).json({
      error: 'Failed to delete resume',
      message: error.message
    });
  }
});

module.exports = router;
