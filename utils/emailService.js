// const nodemailer = require('nodemailer');

const transporter  = require("./transpoter");

// // Email configuration from environment variables
// const EMAIL_HOST = process.env.EMAIL_HOST || 'smtp.gmail.com';
// const EMAIL_PORT = process.env.EMAIL_PORT || 587;
// const EMAIL_USER = process.env.EMAIL_USER;
// const EMAIL_PASSWORD = process.env.EMAIL_PASSWORD;
// const EMAIL_FROM = process.env.EMAIL_FROM || EMAIL_USER;

// // Create transporter (only if email credentials are configured)
// let transporter = null;

// if (EMAIL_USER && EMAIL_PASSWORD) {
//   transporter = nodemailer.createTransport({
//     host: EMAIL_HOST,
//     port: EMAIL_PORT,
//     secure: EMAIL_PORT === 465,
//     auth: {
//       user: EMAIL_USER,
//       pass: EMAIL_PASSWORD
//     }
//   });
// }


/**
 * Send email notification
 * @param {Object} options - Email options
 * @param {string} options.to - Recipient email
 * @param {string} options.subject - Email subject
 * @param {string} options.html - Email HTML content
 * @param {string} options.text - Email plain text content (optional)
 * @returns {Promise<boolean>} - Returns true if email sent successfully
 */
async function sendEmail({ to, subject, html, text }) {
  if (!transporter) {
    console.warn('Email service not configured. Email would have been sent to:', to);
    console.warn('Subject:', subject);
    console.warn('To configure email, set EMAIL_HOST, EMAIL_PORT, EMAIL_USER, EMAIL_PASSWORD in .env');
    return false;
  }

  try {
    const mailOptions = {
      to,
      subject,
      html,
      text: text || html.replace(/<[^>]*>/g, '') // Strip HTML tags for plain text
    };

    const info = await transporter.sendMail(mailOptions);
    console.log('Email sent successfully:', info.messageId);
    return true;
  } catch (error) {
    console.error('Error sending email:', error);
    return false;
  }
}

/**
 * Send interview assignment notification to interviewer
 * @param {Object} options
 * @param {string} options.interviewerEmail
 * @param {string} options.interviewerName
 * @param {string} options.candidateName
 * @param {string} options.candidateEmail
 * @param {string} options.jobTitle
 * @param {Date} options.interviewDate
 * @returns {Promise<boolean>}
 */
async function sendInterviewAssignmentToInterviewer({
  interviewerEmail,
  interviewerName,
  candidateName,
  candidateEmail,
  jobTitle,
  interviewDate,
  interViewLink
}) {
  

 
  const formattedDate = new Date(interviewDate).toLocaleString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });

  const subject = `New Interview Assignment: ${candidateName} - ${jobTitle}`;
  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background-color: #4CAF50; color: white; padding: 20px; text-align: center; }
        .content { padding: 20px; background-color: #f9f9f9; }
        .info-box { background-color: white; padding: 15px; margin: 10px 0; border-left: 4px solid #4CAF50; }
        .footer { text-align: center; padding: 20px; color: #666; font-size: 12px; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h2>New Interview Assignment</h2>
        </div>
        <div class="content">
          <p>Hello ${interviewerName || 'Interviewer'},</p>
          <p>You have been assigned to conduct an interview for the following candidate:</p>
          
          <div class="info-box">
            <strong>Candidate Name:</strong> ${candidateName || 'N/A'}<br>
            <strong>Candidate Email:</strong> ${candidateEmail || 'N/A'}<br>
            <strong>Job Position:</strong> ${jobTitle || 'N/A'}<br>
            <strong>Interview Date & Time:</strong> ${formattedDate}<br>
            <strong>Interview Link:</strong> ${interViewLink || 'N/A'}<br>
          </div>
          
          <p>Please log in to the ATS system to view the candidate's resume and prepare for the interview.</p>
          <p>After the interview, you will be able to submit your feedback and rating.</p>
        </div>
        <div class="footer">
          <p>This is an automated notification from the ATS System.</p>
        </div>
      </div>
    </body>
    </html>
  `;

  return await sendEmail({
    to: interviewerEmail,
    subject,
    html
  });
}

/**
 * Send interview assignment notification to candidate
 * @param {Object} options
 * @param {string} options.candidateEmail
 * @param {string} options.candidateName
 * @param {string} options.jobTitle
 * @param {Date} options.interviewDate
 * @param {string} options.interviewerName
 * @returns {Promise<boolean>}
 */
async function sendInterviewAssignmentToCandidate({
  candidateEmail,
  candidateName,
  jobTitle,
  interviewDate,
  interviewerName,
  interviewLink,
}) {
  // const formattedDate = new Date(interviewDate).toLocaleString('en-US', {
  //   weekday: 'long',
  //   year: 'numeric',
  //   month: 'long',
  //   day: 'numeric',
  //   hour: '2-digit',
  //   minute: '2-digit'
  // });

    const formattedDate = new Date(interviewDate).toLocaleDateString('en-IN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  const formattedTime = new Date(interviewDate).toLocaleTimeString('en-IN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });

    const subject = `Interview Invitation – ${jobTitle || ''}`;
   const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <title>Interview Invitation</title>
</head>
<body style="font-family: Calibri, Arial, sans-serif; color:#000; line-height:1.6;">
  <p>Dear ${candidateName || ''},</p>

  <p>Greetings from <strong>Cogniter Technologies</strong>.</p>

  <p>
    We are pleased to invite you for an interview for the
    <strong>${jobTitle || ''}</strong> position.
    Please find the interview details below:
  </p>

  <p><strong>Interview Details:</strong></p>

  <p>
    <strong>Topic:</strong> ${jobTitle || ""} – ${candidateName || ''}<br/>
    <strong>Date:</strong> ${formattedDate}<br/>
    <strong>Time:</strong> ${formattedTime} (IST)
  </p>

  <p>
    <strong> Meeting Link:</strong><br/>
    <a href="${interviewLink || '#'}" target="_blank">
      <button style="background-color: #0066ffff; color: white; padding: 10px 20px; border: none; border-radius: 5px; cursor: pointer;">Join  Meeting</button>
    </a>
  </p>

 

  <p>
    Kindly join the meeting on time and ensure you have a stable internet
    connection. Please keep your updated resume handy for reference.
  </p>

  <p>
    If you are unable to attend at the scheduled time, kindly inform us in advance.
  </p>

  <p>We look forward to speaking with you.</p>

  <br/>

  <p>
    <strong>Thanks & Regards,</strong><br/>
    Human Resource<br/>
    <span style="color:#C00000;">Cogniter Technologies</span><br/>
    <a href="mailto:jsingh@cogniter.com">jsingh@cogniter.com</a> |
    <a href="mailto:nikhilsharma@cogniter.com">nikhilsharma@cogniter.com</a> | 
    <a href="https://www.cogniter.com" target="_blank">www.cogniter.com</a>
  </p>
</body>
</html>
`;


  return await sendEmail({
    to: candidateEmail,
    subject,
    html
  });
}

/**
 * Send interview feedback notification to HR/Admin
 * @param {Object} options
 * @param {Array<string>} options.hrAdminEmails - Array of HR and Admin emails
 * @param {string} options.candidateName
 * @param {string} options.jobTitle
 * @param {string} options.interviewerName
 * @param {string} options.status - Interviewer's status decision
 * @returns {Promise<boolean>}
 */
async function sendInterviewFeedbackToHR({
  hrAdminEmails,
  candidateName,
  jobTitle,
  interviewerName,
  status
}) {
  const statusLabels = {
    selected: 'Selected',
    rejected: 'Rejected',
    on_hold: 'On Hold'
  };

  const subject = `Interview Feedback: ${candidateName} - ${jobTitle}`;
  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background-color: #FF9800; color: white; padding: 20px; text-align: center; }
        .content { padding: 20px; background-color: #f9f9f9; }
        .info-box { background-color: white; padding: 15px; margin: 10px 0; border-left: 4px solid #FF9800; }
        .status-badge { display: inline-block; padding: 5px 15px; border-radius: 20px; font-weight: bold; }
        .status-selected { background-color: #4CAF50; color: white; }
        .status-rejected { background-color: #f44336; color: white; }
        .status-on-hold { background-color: #FF9800; color: white; }
        .footer { text-align: center; padding: 20px; color: #666; font-size: 12px; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h2>Interview Feedback Received</h2>
        </div>
        <div class="content">
          <p>Hello HR/Admin Team,</p>
          <p>Interview feedback has been submitted for the following candidate:</p>
          
          <div class="info-box">
            <strong>Candidate Name:</strong> ${candidateName || 'N/A'}<br>
            <strong>Job Position:</strong> ${jobTitle || 'N/A'}<br>
            <strong>Interviewer:</strong> ${interviewerName || 'N/A'}<br>
            <strong>Interviewer's Decision:</strong> 
            <span class="status-badge status-${status}">${statusLabels[status] || status}</span>
          </div>
          
          <p>Please log in to the ATS system to review the detailed feedback and make the final decision.</p>
        </div>
        <div class="footer">
          <p>This is an automated notification from the ATS System.</p>
        </div>
      </div>
    </body>
    </html>
  `;

  // Send to all HR and Admin emails
  const results = await Promise.all(
    hrAdminEmails.map(email => 
      sendEmail({
        to: email,
        subject,
        html
      })
    )
  );

  return results.every(result => result === true);
}

module.exports = {
  sendEmail,
  sendInterviewAssignmentToInterviewer,
  sendInterviewAssignmentToCandidate,
  sendInterviewFeedbackToHR
};

