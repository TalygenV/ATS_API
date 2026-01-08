-- Migration: Add status field to job_descriptions table
-- This field controls whether candidate links can be generated and used

ALTER TABLE `job_descriptions` 
ADD COLUMN `status` ENUM('Open', 'On Hold') DEFAULT 'Open' AFTER `requirements`,
ADD INDEX `idx_status` (`status`);

-- Set all existing job descriptions to 'Open' by default
UPDATE `job_descriptions` SET `status` = 'Open' WHERE `status` IS NULL;
