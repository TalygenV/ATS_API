const nodemailer = require("nodemailer");
const { queryOne } = require("../config/database");

let cachedTransporter = null;
let cachedSmtpId = null;
let cachedFrom = null;

async function getSmtpTransporter() {
  const smtp = await queryOne(`
    SELECT *
    FROM smtpsetting
    WHERE status = 'active'
    ORDER BY id DESC
    LIMIT 1
  `);
 
  if (!smtp) {
    throw new Error("No active SMTP configuration found");
  }

  // Reuse transporter if SMTP not changed
  if (cachedTransporter && cachedSmtpId === smtp.id) {
    return {
      transporter: cachedTransporter,
      from: cachedFrom,
    };
  }

  const transporter = nodemailer.createTransport({
    host: smtp.smtp_server,
    port: smtp.smtp_port,
    secure: smtp.is_secure_smtp === 1 ? true : false, // true for 465
    auth: {
      user: smtp.smtp_user_name,
      pass: smtp.smtp_password,
    },
    tls: {
      rejectUnauthorized: false,
    },
  });

  // Verify SMTP once
  // await transporter.verify();

  // Build FROM (important)
  const from = smtp.from_name
    ? `"${smtp.from_name}" <${smtp.from_email}>`
    : smtp.from_email;

  // Cache everything
  cachedTransporter = transporter;
  cachedSmtpId = smtp.id;
  cachedFrom = from;

  return { transporter, from };
}

module.exports = getSmtpTransporter;
