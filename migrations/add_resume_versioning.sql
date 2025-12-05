-- Migration: Add Resume Versioning Support
-- This migration adds version_number field to the resumes table to support resume versioning

USE ats_system;

-- Add version_number column to resumes table
ALTER TABLE resumes 
ADD COLUMN version_number INT DEFAULT 1 AFTER parent_id;

-- Add index for better query performance when fetching versions
ALTER TABLE resumes 
ADD INDEX idx_version_number (version_number);

-- Update existing resumes to have version_number = 1 (they are all original versions)
UPDATE resumes SET version_number = 1 WHERE version_number IS NULL OR version_number = 0;

-- For resumes with parent_id, we need to calculate their version numbers
-- This query finds all resumes with the same parent_id and assigns sequential version numbers
-- Note: This is a complex update that requires a subquery
-- We'll handle this in the application code for existing data, but new uploads will be handled correctly
