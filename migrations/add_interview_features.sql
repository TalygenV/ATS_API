-- Migration: Add Interview Assignment Features
-- Run this script to update existing database with new interview features

USE ats_system;

-- Add interviewers column to job_descriptions table
-- Check if column exists before adding (MySQL 5.7+ compatible)
SET @dbname = DATABASE();
SET @tablename = 'job_descriptions';
SET @columnname = 'interviewers';
SET @preparedStatement = (SELECT IF(
  (
    SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE
      (TABLE_SCHEMA = @dbname)
      AND (TABLE_NAME = @tablename)
      AND (COLUMN_NAME = @columnname)
  ) > 0,
  'SELECT 1',
  CONCAT('ALTER TABLE ', @tablename, ' ADD COLUMN ', @columnname, ' JSON NULL AFTER requirements')
));
PREPARE alterIfNotExists FROM @preparedStatement;
EXECUTE alterIfNotExists;
DEALLOCATE PREPARE alterIfNotExists;

-- Add interview-related columns to candidate_evaluations table
-- Note: For production, you may want to add these columns one by one with existence checks
ALTER TABLE candidate_evaluations 
ADD COLUMN interviewer_id VARCHAR(36) NULL AFTER rejection_reason,
ADD COLUMN interview_date DATETIME NULL AFTER interviewer_id,
ADD COLUMN interviewer_feedback JSON NULL AFTER interview_date,
ADD COLUMN interviewer_status ENUM('pending', 'selected', 'rejected', 'on_hold') DEFAULT 'pending' AFTER interviewer_feedback,
ADD COLUMN interviewer_hold_reason TEXT NULL AFTER interviewer_status,
ADD COLUMN hr_final_status ENUM('pending', 'selected', 'rejected', 'on_hold') DEFAULT 'pending' AFTER interviewer_hold_reason,
ADD COLUMN hr_final_reason TEXT NULL AFTER hr_final_status;

-- Add foreign key constraint for interviewer_id
ALTER TABLE candidate_evaluations
ADD CONSTRAINT fk_interviewer FOREIGN KEY (interviewer_id) REFERENCES users(id) ON DELETE SET NULL;

-- Add indexes for new columns
-- Note: These will fail if indexes already exist, which is fine
ALTER TABLE candidate_evaluations
ADD INDEX idx_interviewer_id (interviewer_id),
ADD INDEX idx_interviewer_status (interviewer_status),
ADD INDEX idx_hr_final_status (hr_final_status),
ADD INDEX idx_interview_date (interview_date);

-- Create interview_assignments table
CREATE TABLE IF NOT EXISTS interview_assignments (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  evaluation_id BIGINT NOT NULL,
  interviewer_id VARCHAR(36) NOT NULL,
  interview_date DATETIME NOT NULL,
  assigned_by VARCHAR(36) NOT NULL,
  notes TEXT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_evaluation_id (evaluation_id),
  INDEX idx_interviewer_id (interviewer_id),
  INDEX idx_interview_date (interview_date),
  INDEX idx_assigned_by (assigned_by),
  FOREIGN KEY (evaluation_id) REFERENCES candidate_evaluations(id) ON DELETE CASCADE,
  FOREIGN KEY (interviewer_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (assigned_by) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

