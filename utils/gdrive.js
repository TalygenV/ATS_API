// Google Drive Utility (OAuth-based)
// This module provides Google Drive file operations using OAuth authentication
// Previously used Service Account, but switched to OAuth due to storage quota limitations
// OAuth uses a regular Google account which has full storage access

const { uploadFileBuffer, downloadFile, getFileMetadata, deleteFile } = require('./gdrive-oauth');

/**
 * Google Drive utility functions
 * Re-exports OAuth-based functions and provides legacy function names for backward compatibility
 */
module.exports = {
  uploadFileBuffer,
  downloadFile,
  getFileMetadata,
  deleteFile,
  /**
   * Legacy upload function for backward compatibility
   * Reads file from disk and uploads to Google Drive
   * 
   * @param {string} filePath - Path to file on local filesystem
   * @param {string} fileName - Name for the uploaded file
   * @returns {Promise<Object>} Upload result with file ID and metadata
   */
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
    // Determine MIME type from file extension
    const mimeType = mimeTypes[ext] || 'application/octet-stream';
    return uploadFileBuffer(fileBuffer, fileName, mimeType);
  },
  /**
   * Initialize Google Drive OAuth
   * Legacy function - initialization is now handled automatically by gdrive-oauth
   * 
   * @returns {Promise<void>}
   */
  initializeDrive: async () => {
    // This is now handled automatically by gdrive-oauth
    const { initializeOAuth } = require('./gdrive-oauth');
    return initializeOAuth();
  },
  /**
   * Find or create a folder in Google Drive
   * Searches for existing folder by name, creates it if not found
   * 
   * @param {string} folderName - Name of the folder to find or create
   * @returns {Promise<string>} Folder ID
   */
  findOrCreateFolder: async (folderName) => {
    const { findOrCreateFolder } = require('./gdrive-oauth');
    return findOrCreateFolder(folderName);
  }
};
