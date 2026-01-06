-- MySQL Database Schema for ATS System
-- Run this script to create the database and all tables

CREATE DATABASE IF NOT EXISTS ats_system CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE ats_system;

-- Create users table for role-based access control
CREATE TABLE IF NOT EXISTS users (
  id VARCHAR(36) PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role ENUM('HR', 'Interviewer', 'Admin') NOT NULL,
  status ENUM('active', 'inactive') DEFAULT 'active',
  full_name VARCHAR(255),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_email (email),
  INDEX idx_role (role),
  INDEX idx_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Create resumes table
CREATE TABLE IF NOT EXISTS resumes (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  file_name VARCHAR(255) NOT NULL,
  file_path VARCHAR(500),
  name VARCHAR(255),
  email VARCHAR(255),
  phone VARCHAR(50),
  location VARCHAR(255),
  skills JSON,
  experience JSON,
  education JSON,
  summary TEXT,
  certifications JSON,
  raw_text TEXT,
  total_experience DECIMAL(5,2),
  parent_id BIGINT NULL,
  version_number INT DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_name (name),
  INDEX idx_email (email),
  INDEX idx_location (location),
  INDEX idx_created_at (created_at DESC),
  INDEX idx_parent_id (parent_id),
  INDEX idx_version_number (version_number),
  INDEX idx_total_experience (total_experience),
  FOREIGN KEY (parent_id) REFERENCES resumes(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Create job_descriptions table
CREATE TABLE IF NOT EXISTS job_descriptions (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  title VARCHAR(255) NOT NULL,
  description TEXT NOT NULL,
  requirements TEXT,
  interviewers JSON,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_title (title),
  INDEX idx_created_at (created_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Create candidate_evaluations table
CREATE TABLE IF NOT EXISTS candidate_evaluations (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  resume_id BIGINT NOT NULL,
  job_description_id BIGINT NOT NULL,
  candidate_name VARCHAR(255),
  contact_number VARCHAR(50),
  email VARCHAR(255),
  resume_text TEXT,
  job_description TEXT,
  overall_match DECIMAL(5,2) DEFAULT 0,
  skills_match DECIMAL(5,2) DEFAULT 0,
  skills_details TEXT,
  experience_match DECIMAL(5,2) DEFAULT 0,
  experience_details TEXT,
  education_match DECIMAL(5,2) DEFAULT 0,
  education_details TEXT,
  status VARCHAR(50) DEFAULT 'pending',
  rejection_reason TEXT,
  interviewer_id VARCHAR(36) NULL,
  interview_date DATETIME NULL,
  interviewer_feedback JSON NULL,
  interviewer_status ENUM('pending', 'selected', 'rejected', 'on_hold') DEFAULT 'pending',
  interviewer_hold_reason TEXT NULL,
  hr_final_status ENUM('pending', 'selected', 'rejected', 'on_hold') DEFAULT 'pending',
  hr_final_reason TEXT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY unique_resume_job (resume_id, job_description_id),
  INDEX idx_resume_id (resume_id),
  INDEX idx_job_description_id (job_description_id),
  INDEX idx_overall_match (overall_match DESC),
  INDEX idx_status (status),
  INDEX idx_interviewer_id (interviewer_id),
  INDEX idx_interviewer_status (interviewer_status),
  INDEX idx_hr_final_status (hr_final_status),
  INDEX idx_interview_date (interview_date),
  INDEX idx_created_at (created_at DESC),
  FOREIGN KEY (resume_id) REFERENCES resumes(id) ON DELETE CASCADE,
  FOREIGN KEY (job_description_id) REFERENCES job_descriptions(id) ON DELETE CASCADE,
  FOREIGN KEY (interviewer_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Create file_uploads table for storing Talygen API upload responses
CREATE TABLE IF NOT EXISTS file_uploads (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  resume_id BIGINT NULL,
  original_file_name VARCHAR(255) NOT NULL,
  file_name VARCHAR(255),
  file_path TEXT,
  file_thumb_path TEXT,
  folder_id VARCHAR(255),
  file_type VARCHAR(100),
  file_size DECIMAL(15,2),
  file_id TEXT,
  upload_status INT,
  error_msg TEXT,
  api_response JSON,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_resume_id (resume_id),
  INDEX idx_original_file_name (original_file_name),
  INDEX idx_created_at (created_at DESC),
  INDEX idx_upload_status (upload_status),
  FOREIGN KEY (resume_id) REFERENCES resumes(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Create interview_assignments table to track interview assignment history
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

-- Create interviewer_time_slots table for interviewer availability
CREATE TABLE IF NOT EXISTS interviewer_time_slots (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  interviewer_id VARCHAR(36) NOT NULL,
  start_time DATETIME NOT NULL,
  end_time DATETIME NOT NULL,
  is_booked TINYINT(1) DEFAULT 0,
  evaluation_id BIGINT NULL,
  job_description_id BIGINT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_interviewer_id (interviewer_id),
  INDEX idx_start_time (start_time),
  INDEX idx_end_time (end_time),
  INDEX idx_is_booked (is_booked),
  INDEX idx_job_description_id (job_description_id),
  FOREIGN KEY (interviewer_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (evaluation_id) REFERENCES candidate_evaluations(id) ON DELETE SET NULL,
  FOREIGN KEY (job_description_id) REFERENCES job_descriptions(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Create candidate_links table for public candidate Q&A links
CREATE TABLE IF NOT EXISTS candidate_links (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  token VARCHAR(64) NOT NULL UNIQUE,
  job_description_id BIGINT NOT NULL,
  candidate_name VARCHAR(255),
  candidate_email VARCHAR(255),
  status ENUM('pending', 'completed', 'expired') DEFAULT 'pending',
  evaluation_id BIGINT NULL,
  questions JSON NULL,
  expires_at DATETIME NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_token (token),
  INDEX idx_job_description_id (job_description_id),
  INDEX idx_status (status),
  FOREIGN KEY (job_description_id) REFERENCES job_descriptions(id) ON DELETE CASCADE,
  FOREIGN KEY (evaluation_id) REFERENCES candidate_evaluations(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;



ALTER TABLE `candidate_evaluations` 
ADD COLUMN `interview_start_url` VARCHAR(1000) NULL DEFAULT NULL AFTER `hr_final_reason`,
ADD COLUMN `interview_join_url` VARCHAR(500) NULL DEFAULT NULL AFTER `interview_start_url`;


ALTER TABLE `candidate_evaluations` 
ADD COLUMN `hr_remarks` VARCHAR(100) NULL DEFAULT NULL AFTER `hr_final_reason`;

ALTER TABLE `users` 
ADD COLUMN `status` ENUM('active', 'inactive') DEFAULT 'active' AFTER `role`,
ADD INDEX `idx_status` (`status`);


ALTER TABLE `interview_assignments` 
ADD COLUMN `interviewer_feedback` JSON NULL DEFAULT NULL AFTER `updated_at`,
ADD COLUMN `interviewer_status` ENUM('pending', 'selected', 'rejected', 'on_hold') NULL DEFAULT 'pending' AFTER `interviewer_feedback`,
ADD COLUMN `interviewer_hold_reason` TEXT NULL DEFAULT NULL AFTER `interviewer_status`,
ADD COLUMN `hr_final_status` ENUM('pending', 'selected', 'rejected', 'on_hold') NULL DEFAULT 'pending' AFTER `interviewer_hold_reason`,
ADD COLUMN `hr_final_reason` TEXT NULL DEFAULT NULL AFTER `hr_final_status`,
ADD COLUMN `hr_remarks` VARCHAR(100) NULL DEFAULT NULL AFTER `hr_final_reason`;





CREATE TABLE `ats_system_local`.`interview_details` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `candidate_evaluations_id` INT NOT NULL,
  `interviewer_time_slots_id` INT NULL,
  `interviewer_id` VARCHAR(36) NULL,
  `interviewer_feedback` JSON NULL,
  `interviewer_status` ENUM('pending', 'selected', 'rejected', 'on_hold') NULL DEFAULT 'pending',
  `interviewer_hold_reason` TEXT NULL DEFAULT NULL,
  PRIMARY KEY (`id`));


  ALTER TABLE `ats_system_local`.`candidate_evaluations` 
DROP FOREIGN KEY `candidate_evaluations_ibfk_3`;
ALTER TABLE `ats_system_local`.`candidate_evaluations` 
DROP COLUMN `interviewer_hold_reason`,
DROP COLUMN `interviewer_status`,
DROP COLUMN `interviewer_feedback`,
DROP COLUMN `interview_date`,
DROP COLUMN `interviewer_id`,
DROP INDEX `idx_interview_date` ,
DROP INDEX `idx_interviewer_status` ,
DROP INDEX `idx_interviewer_id` ;
;

ALTER TABLE `ats_system_local`.`interview_details` 
CHANGE COLUMN `id` `id` BIGINT NOT NULL ;

ALTER TABLE `ats_system_local`.`interview_details` 
CHANGE COLUMN `interviewer_id` `interviewer_id` VARCHAR(36) NULL DEFAULT NULL ;

ALTER TABLE `ats_system_local`.`interview_details` 
CHANGE COLUMN `id` `id` BIGINT NOT NULL AUTO_INCREMENT ;


-- SMTP Setting Table ---------05/01/2026--------------------Samson-------------
CREATE TABLE SMTPSetting (
    id BIGINT NOT NULL AUTO_INCREMENT,
    smtp_server VARCHAR(255) NOT NULL,
    smtp_user_name VARCHAR(255) NOT NULL,
    smtp_password VARCHAR(255) NOT NULL,
    from_email VARCHAR(255) NOT NULL,
    smtp_port VARCHAR(255) NOT NULL,
    is_secure_smtp TINYINT(1) NOT NULL,
    smtp_type VARCHAR(255) NOT NULL,
    created_by VARCHAR(255) NOT NULL,
    created_at DATETIME NOT NULL,
    status VARCHAR(10) NOT NULL,
    PRIMARY KEY (id)
) ENGINE=InnoDB
DEFAULT CHARSET=utf8mb4
COLLATE=utf8mb4_unicode_ci;

------------------------------------------------------------------------------------

CREATE TABLE Meeting_Settings (
    id BIGINT NOT NULL AUTO_INCREMENT,
    Type VARCHAR(255) NOT NULL,
    ZOOM_ACCOUNT_ID VARCHAR(255) NULL,
    ZOOM_CLIENT_ID VARCHAR(255)  NULL,
    ZOOM_CLIENT_SECRET VARCHAR(255)  NULL,
    Zoom_join_before_host TINYINT(1)  NULL,
    Zoom_waiting_room TINYINT(1)  NULL,
    Zoom_Email VARCHAR(255)  NULL,
    Modified_by VARCHAR(255) NOT NULL,
    Modified_at DATETIME NOT NULL,
    status VARCHAR(10) NOT NULL,
    PRIMARY KEY (id)
) ENGINE=InnoDB
DEFAULT CHARSET=utf8mb4
COLLATE=utf8mb4_unicode_ci;


-- AI Setting Table ---------05/01/2026--------------------Jaid-------------
CREATE TABLE AI_Settings (
    id BIGINT NOT NULL AUTO_INCREMENT,
    Type VARCHAR(255) NOT NULL,
    GROQ_API_Key VARCHAR(255) NULL,
    GROQ_STATUS TINYINT(1)  NULL,
    Modified_by VARCHAR(255) NOT NULL,
    Modified_at DATETIME NOT NULL,
    status VARCHAR(10) NOT NULL,
    PRIMARY KEY (id)
) ENGINE=InnoDB
DEFAULT CHARSET=utf8mb4
COLLATE=utf8mb4_unicode_ci;
