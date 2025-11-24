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
  full_name VARCHAR(255),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_email (email),
  INDEX idx_role (role)
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
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_name (name),
  INDEX idx_email (email),
  INDEX idx_location (location),
  INDEX idx_created_at (created_at DESC),
  INDEX idx_parent_id (parent_id),
  INDEX idx_total_experience (total_experience),
  FOREIGN KEY (parent_id) REFERENCES resumes(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Create job_descriptions table
CREATE TABLE IF NOT EXISTS job_descriptions (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  title VARCHAR(255) NOT NULL,
  description TEXT NOT NULL,
  requirements TEXT,
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
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY unique_resume_job (resume_id, job_description_id),
  INDEX idx_resume_id (resume_id),
  INDEX idx_job_description_id (job_description_id),
  INDEX idx_overall_match (overall_match DESC),
  INDEX idx_status (status),
  INDEX idx_created_at (created_at DESC),
  FOREIGN KEY (resume_id) REFERENCES resumes(id) ON DELETE CASCADE,
  FOREIGN KEY (job_description_id) REFERENCES job_descriptions(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

