const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const db = require('./db');

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI;
const LOCAL_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

let oauth2Client = null;
if (CLIENT_ID && CLIENT_SECRET) {
  oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
}

/**
 * Gets authentication URL for a user
 */
function getAuthUrl(userId) {
  if (!oauth2Client) return null;
  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: ['https://www.googleapis.com/auth/calendar.events'],
    state: userId
  });
}

/**
 * Saves tokens for a user after authorization callback
 */
async function saveUserTokens(userId, code) {
  if (!oauth2Client) throw new Error('Google OAuth is not configured on this server.');
  const { tokens } = await oauth2Client.getToken(code);
  
  await db.run(
    `INSERT INTO google_tokens (user_id, access_token, refresh_token, expiry_date, updated_at) 
     VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(user_id) DO UPDATE SET 
       access_token = excluded.access_token,
       refresh_token = COALESCE(excluded.refresh_token, google_tokens.refresh_token),
       expiry_date = excluded.expiry_date,
       updated_at = CURRENT_TIMESTAMP`,
    [userId, tokens.access_token, tokens.refresh_token, tokens.expiry_date]
  );
  return tokens;
}

/**
 * DB-backed wait-and-retry lock helper for Google OAuth Token refreshes.
 */
async function acquireRefreshLock(userId) {
  const maxRetries = 30; // Wait up to 4.5 seconds
  const delay = 150; // 150ms sleep between attempts

  for (let i = 0; i < maxRetries; i++) {
    try {
      // Clean up expired lock (older than 15 seconds) first
      await db.run('DELETE FROM token_refresh_locks WHERE user_id = ? AND locked_until < ?', [userId, Date.now()]);
      
      // Attempt to insert lock row
      await db.run(
        'INSERT INTO token_refresh_locks (user_id, locked_until) VALUES (?, ?)',
        [userId, Date.now() + 15000] // 15 seconds lock duration
      );
      return true; // Successfully acquired lock
    } catch (err) {
      // Lock is active. Sleep and retry.
      await new Promise(r => setTimeout(r, delay));
    }
  }
  return false; // Failed to acquire lock within time
}

/**
 * Releases the user refresh lock.
 */
async function releaseRefreshLock(userId) {
  try {
    await db.run('DELETE FROM token_refresh_locks WHERE user_id = ?', [userId]);
  } catch (err) {
    console.error(`[OAuth Lock] Failed to release refresh lock for ${userId}:`, err.message);
  }
}

/**
 * Gets client authorized for a specific user
 */
async function getAuthorizedClient(userId) {
  if (!oauth2Client) return null;
  
  let tokenRecord = await db.get('SELECT * FROM google_tokens WHERE user_id = ?', [userId]);
  if (!tokenRecord) return null;

  const client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
  
  const setCreds = (rec) => {
    client.setCredentials({
      access_token: rec.access_token,
      refresh_token: rec.refresh_token,
      expiry_date: rec.expiry_date
    });
  };
  
  setCreds(tokenRecord);

  // Check if token expired, refresh if possible
  if (tokenRecord.expiry_date && Date.now() >= tokenRecord.expiry_date) {
    if (tokenRecord.refresh_token) {
      // Acquire distributed lock for this user's token refresh
      const lockAcquired = await acquireRefreshLock(userId);
      if (!lockAcquired) {
        console.warn(`[OAuth Lock] Timeout waiting for token refresh lock for user ${userId}. Attempting to use existing token.`);
        return client; // Fallback to current credentials
      }

      try {
        // Load token record from DB again to check if another thread refreshed it while we waited
        tokenRecord = await db.get('SELECT * FROM google_tokens WHERE user_id = ?', [userId]);
        if (tokenRecord && tokenRecord.expiry_date && Date.now() >= tokenRecord.expiry_date) {
          console.log(`[OAuth Lock] Refreshing expired token for user ${userId}...`);
          const { credentials } = await client.refreshAccessToken();
          await db.run(
            `UPDATE google_tokens SET 
              access_token = ?, 
              expiry_date = ?, 
              updated_at = CURRENT_TIMESTAMP 
             WHERE user_id = ?`,
            [credentials.access_token, credentials.expiry_date, userId]
          );
          client.setCredentials(credentials);
        } else if (tokenRecord) {
          console.log(`[OAuth Lock] Concurrently refreshed token detected for user ${userId}. Using new access token.`);
          setCreds(tokenRecord);
        }
      } catch (err) {
        console.error(`Failed to refresh Google OAuth token for user ${userId}:`, err.message);
        return null;
      } finally {
        await releaseRefreshLock(userId);
      }
    } else {
      return null;
    }
  }

  return client;
}

/**
 * Helper to log operations locally if Google OAuth is not configured
 */
function logCalendarOperation(action, eventId, eventDetails) {
  const logPath = path.resolve(__dirname, 'google_calendar_sync.log');
  const logContent = `\n==================================================\n` +
    `Date: ${new Date().toISOString()}\n` +
    `Action: ${action.toUpperCase()}\n` +
    `Event ID: ${eventId || 'NEW'}\n` +
    `Event Details:\n${JSON.stringify(eventDetails, null, 2)}\n` +
    `==================================================\n`;
  
  fs.appendFileSync(logPath, logContent, 'utf8');
  console.log(`[Google Calendar Log] Action: ${action} | Event ID: ${eventId || 'NEW'}`);
}

/**
 * Sync (create) calendar event for doctor and patient
 */
async function createCalendarEvent(appointment, doctorName, patientName, doctorEmail, patientEmail) {
  const eventDetails = {
    summary: `Medical Appointment: ${patientName} / Dr. ${doctorName}`,
    location: 'Clinic / Telehealth',
    description: `Pre-visit Urgency: ${appointment.urgency_level || 'Pending'}\nChief Complaint: ${appointment.chief_complaint || 'None'}\nSymptoms: ${appointment.symptoms}`,
    start: {
      dateTime: `${appointment.appointment_date}T${appointment.start_time}:00`,
      timeZone: LOCAL_TIMEZONE
    },
    end: {
      dateTime: `${appointment.appointment_date}T${appointment.end_time}:00`,
      timeZone: LOCAL_TIMEZONE
    },
    attendees: [
      { email: doctorEmail, displayName: `Dr. ${doctorName}` },
      { email: patientEmail, displayName: patientName }
    ]
  };

  // Try doctor first, then patient for authorized client
  const client = await getAuthorizedClient(appointment.doctor_id) || await getAuthorizedClient(appointment.patient_id);
  
  if (client) {
    try {
      const calendar = google.calendar({ version: 'v3', auth: client });
      const response = await calendar.events.insert({
        calendarId: 'primary',
        resource: eventDetails,
        sendUpdates: 'all'
      });
      console.log(`[Google Calendar Sync] Event created in Google Calendar: ${response.data.id}`);
      return response.data.id;
    } catch (err) {
      console.error('[Google Calendar Sync Error] Failed to insert event, logging locally:', err.message);
      const simulatedEventId = `gcal_${Math.random().toString(36).substring(2, 10)}`;
      logCalendarOperation('create', simulatedEventId, eventDetails);
      return simulatedEventId;
    }
  } else {
    // Simulated fallback
    const simulatedEventId = `gcal_${Math.random().toString(36).substring(2, 10)}`;
    logCalendarOperation('create', simulatedEventId, eventDetails);
    return simulatedEventId;
  }
}

/**
 * Update existing calendar event
 */
async function updateCalendarEvent(appointment, doctorName, patientName, doctorEmail, patientEmail) {
  if (!appointment.google_event_id) return;

  const eventDetails = {
    summary: `UPDATED: Medical Appointment - ${patientName} / Dr. ${doctorName}`,
    location: 'Clinic / Telehealth',
    description: `Pre-visit Urgency: ${appointment.urgency_level || 'Pending'}\nChief Complaint: ${appointment.chief_complaint || 'None'}\nSymptoms: ${appointment.symptoms}`,
    start: {
      dateTime: `${appointment.appointment_date}T${appointment.start_time}:00`,
      timeZone: LOCAL_TIMEZONE
    },
    end: {
      dateTime: `${appointment.appointment_date}T${appointment.end_time}:00`,
      timeZone: LOCAL_TIMEZONE
    },
    attendees: [
      { email: doctorEmail, displayName: `Dr. ${doctorName}` },
      { email: patientEmail, displayName: patientName }
    ]
  };

  const client = await getAuthorizedClient(appointment.doctor_id) || await getAuthorizedClient(appointment.patient_id);

  if (client && !appointment.google_event_id.startsWith('gcal_')) {
    try {
      const calendar = google.calendar({ version: 'v3', auth: client });
      await calendar.events.update({
        calendarId: 'primary',
        eventId: appointment.google_event_id,
        resource: eventDetails,
        sendUpdates: 'all'
      });
      console.log(`[Google Calendar Sync] Event updated: ${appointment.google_event_id}`);
    } catch (err) {
      console.error('[Google Calendar Sync Error] Failed to update event, logging locally:', err.message);
      logCalendarOperation('update', appointment.google_event_id, eventDetails);
    }
  } else {
    logCalendarOperation('update', appointment.google_event_id, eventDetails);
  }
}

/**
 * Delete calendar event
 */
async function deleteCalendarEvent(appointment) {
  if (!appointment.google_event_id) return;

  const client = await getAuthorizedClient(appointment.doctor_id) || await getAuthorizedClient(appointment.patient_id);

  if (client && !appointment.google_event_id.startsWith('gcal_')) {
    try {
      const calendar = google.calendar({ version: 'v3', auth: client });
      await calendar.events.delete({
        calendarId: 'primary',
        eventId: appointment.google_event_id,
        sendUpdates: 'all'
      });
      console.log(`[Google Calendar Sync] Event deleted: ${appointment.google_event_id}`);
    } catch (err) {
      console.error('[Google Calendar Sync Error] Failed to delete event, logging locally:', err.message);
      logCalendarOperation('delete', appointment.google_event_id, { status: 'cancelled' });
    }
  } else {
    logCalendarOperation('delete', appointment.google_event_id, { status: 'cancelled' });
  }
}

module.exports = {
  getAuthUrl,
  saveUserTokens,
  createCalendarEvent,
  updateCalendarEvent,
  deleteCalendarEvent,
  acquireRefreshLock,
  releaseRefreshLock
};
