-- Migration: Add status field to users table
-- This field controls user login access and interview assignment eligibility

ALTER TABLE `users` 
ADD COLUMN `status` ENUM('active', 'inactive') DEFAULT 'active' AFTER `role`,
ADD INDEX `idx_status` (`status`);

-- Set all existing users to active by default
UPDATE `users` SET `status` = 'active' WHERE `status` IS NULL;

