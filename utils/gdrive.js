// This file now uses OAuth instead of Service Account
// Service accounts have storage quota limitations that prevent file uploads
// OAuth uses a regular Google account which has full storage access
const { uploadFileBuffer, downloadFile, getFileMetadata, deleteFile } = require('./gdrive-oauth');

// Re-export all functions for backward compatibility
module.exports = {
  uploadFileBuffer,
  downloadFile,
  getFileMetadata,
  deleteFile,
  // Legacy function names for compatibility
  uploadFile: async (filePath, fileName) => {
    const fs = require('fs').promises;
    const fileBuffer = await fs.readFile(filePath);
    const path = require('path');
    const ext = path.extname(fileName).toLowerCase();
    const mimeTypes = {
      '.pdf': 'application/pdf',
      '.doc': 'application/msword',
      '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      '.txt': 'text/plain'
    };
    const mimeType = mimeTypes[ext] || 'application/octet-stream';
    return uploadFileBuffer(fileBuffer, fileName, mimeType);
  },
  initializeDrive: async () => {
    // This is now handled automatically by gdrive-oauth
    const { initializeOAuth } = require('./gdrive-oauth');
    return initializeOAuth();
  },
  findOrCreateFolder: async (folderName) => {
    const { findOrCreateFolder } = require('./gdrive-oauth');
    return findOrCreateFolder(folderName);
  }
};
