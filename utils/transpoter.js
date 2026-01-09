// SMTP Transporter Utility
// This module manages SMTP email transporter configuration
// Retrieves SMTP settings from database and caches the transporter for performance
// Supports dynamic SMTP configuration changes without server restart

const nodemailer = require("nodemailer");
const { queryOne } = require("../config/database");

// Cache variables to avoid recreating transporter on every email send
let cachedTransporter = null;
let cachedSmtpId = null;
let cachedFrom = null;

/**
 * Get SMTP transporter instance with caching
 * Retrieves active SMTP configuration from database and creates/reuses transporter
 * Caches transporter to improve performance and reduce database queries
 * 
 * @returns {Promise<Object>} Object containing transporter and from email address
 * @throws {Error} If no active SMTP configuration is found in database
 */
async function getSmtpTransporter() {
  const smtp = await queryOne(`
    SELECT *
    FROM smtpsetting
    WHERE status = 'active'
    ORDER BY id DESC
    LIMIT 1
  `);
 
  // Validate that active SMTP configuration exists
  if (!smtp) {
    throw new Error("No active SMTP configuration found");
  }

  // Reuse cached transporter if SMTP configuration hasn't changed
  // This improves performance by avoiding transporter recreation
  if (cachedTransporter && cachedSmtpId === smtp.id) {
    return {
      transporter: cachedTransporter,
      from: cachedFrom,
    };
  }

  // Create new nodemailer transporter with SMTP settings from database
  const transporter = nodemailer.createTransport({
    host: smtp.smtp_server,
    port: smtp.smtp_port,
    secure: smtp.is_secure_smtp === 1 ? true : false, // true for port 465 (SSL), false for 587 (TLS)
    auth: {
      user: smtp.smtp_user_name,
      pass: smtp.smtp_password,
    },
    tls: {
      rejectUnauthorized: false, // Allow self-signed certificates
    },
  });

  // SMTP verification can be enabled for testing
  // await transporter.verify();

  // Build FROM email address with optional display name
  // Format: "Display Name" <email@example.com> or just email@example.com
  const from = smtp.from_name
    ? `"${smtp.from_name}" <${smtp.from_email}>`
    : smtp.from_email;

  // Cache transporter and configuration for future use
  cachedTransporter = transporter;
  cachedSmtpId = smtp.id;
  cachedFrom = from;

  return { transporter, from };
}

module.exports = getSmtpTransporter;
