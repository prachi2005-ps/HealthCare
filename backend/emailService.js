const sgMail = require('@sendgrid/mail');
const fs = require('fs');
const path = require('path');
const db = require('./db');

const apiKey = process.env.SENDGRID_API_KEY;
const fromEmail = process.env.SENDGRID_FROM_EMAIL || 'no-reply@clinic.com';

const isSendGridConfigured = !!apiKey;

if (isSendGridConfigured) {
  sgMail.setApiKey(apiKey);
}

/**
 * Queues an email into the database.
 */
async function queueEmail(recipientEmail, subject, body) {
  const id = Math.random().toString(36).substring(2, 15);
  await db.run(
    'INSERT INTO email_queue (id, recipient_email, subject, body, status, retry_count) VALUES (?, ?, ?, ?, ?, ?)',
    [id, recipientEmail, subject, body, 'pending', 0]
  );
  console.log(`[Email Queued] To: ${recipientEmail} | Subject: ${subject}`);
  return id;
}

/**
 * Processes the queued emails (sends pending or retries failed ones).
 */
async function processQueue() {
  const emails = await db.all(
    "SELECT * FROM email_queue WHERE status = 'pending' OR (status = 'failed' AND retry_count < 3) ORDER BY created_at ASC"
  );

  for (const email of emails) {
    let sentSuccessfully = false;
    let sendError = null;

    try {
      if (isSendGridConfigured) {
        try {
          const msg = {
            to: email.recipient_email,
            from: fromEmail,
            subject: email.subject,
            text: email.body,
            html: `<div style="font-family: sans-serif; line-height: 1.5; color: #333;">
                    <h2>${email.subject}</h2>
                    <p style="white-space: pre-line;">${email.body}</p>
                   </div>`
          };
          await sgMail.send(msg);
          console.log(`[SendGrid Email Sent] To: ${email.recipient_email} | Subject: ${email.subject}`);
          sentSuccessfully = true;
        } catch (sgError) {
          sendError = sgError.message;
          console.error(`[SendGrid Email Error] Failed sending to ${email.recipient_email}:`, sgError.message);
        }
      }

      if (!sentSuccessfully) {
        // Fallback: log to a file for local development
        const logPath = path.resolve(__dirname, 'sent_emails.log');
        const logContent = `\n==================================================\n` +
          `Date: ${new Date().toISOString()}\n` +
          `To: ${email.recipient_email}\n` +
          `Subject: ${email.subject}\n` +
          `Body:\n${email.body}\n` +
          (sendError ? `(SendGrid Failure: ${sendError})\n` : '') +
          `==================================================\n`;
        
        fs.appendFileSync(logPath, logContent, 'utf8');
        console.log(`[Email Logged to file as fallback] To: ${email.recipient_email} | Subject: ${email.subject}`);
      }

      if (sentSuccessfully || !isSendGridConfigured) {
        // Successfully sent via SendGrid or running in offline mode: mark as sent
        await db.run("UPDATE email_queue SET status = 'sent', last_error = NULL WHERE id = ?", [email.id]);
      } else {
        // SendGrid failed to send: mark as failed and increment retry count so the worker can retry
        await db.run(
          "UPDATE email_queue SET status = 'failed', retry_count = retry_count + 1, last_error = ? WHERE id = ?",
          [sendError || 'SendGrid failed to send', email.id]
        );
      }
    } catch (error) {
      console.error(`[Email Process Error] Failed processing email ID ${email.id} to ${email.recipient_email}:`, error.message);
      await db.run(
        "UPDATE email_queue SET status = 'failed', retry_count = retry_count + 1, last_error = ? WHERE id = ?",
        [error.message, email.id]
      );
    }
  }
}

module.exports = {
  queueEmail,
  processQueue
};
