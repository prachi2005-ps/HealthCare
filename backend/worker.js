const db = require('./db');
const emailService = require('./emailService');

// Background interval references
let emailQueueInterval = null;
let medicationReminderInterval = null;
let upcomingAppointmentInterval = null;

/**
 * Checks for pending medication reminders and queues emails.
 */
async function checkMedicationReminders() {
  console.log('[Worker] Checking medication reminders...');
  const today = new Date().toISOString().split('T')[0];

  try {
    // Find active reminders: today is between start_date and end_date
    const reminders = await db.all(
      `SELECT r.*, u.email, u.full_name 
       FROM medication_reminders r
       JOIN users u ON r.patient_id = u.id
       WHERE ? >= r.start_date AND ? <= r.end_date`,
      [today, today]
    );

    for (const reminder of reminders) {
      let shouldRemind = false;
      const now = new Date();
      
      if (!reminder.last_reminded_at) {
        shouldRemind = true;
      } else {
        const lastReminded = new Date(reminder.last_reminded_at);
        const hoursSinceLast = (now - lastReminded) / (1000 * 60 * 60);

        if (reminder.frequency === 'daily') {
          // If last reminded was a different calendar day
          const lastDateStr = lastReminded.toISOString().split('T')[0];
          if (lastDateStr !== today) {
            shouldRemind = true;
          }
        } else if (reminder.frequency === 'twice_daily') {
          // If last reminded was more than 8 hours ago
          if (hoursSinceLast >= 8) {
            shouldRemind = true;
          }
        } else if (reminder.frequency === 'weekly') {
          // If last reminded was more than 7 days (168 hours) ago
          if (hoursSinceLast >= 168) {
            shouldRemind = true;
          }
        }
      }

      if (shouldRemind) {
        const subject = `Medication Reminder: ${reminder.medication_name}`;
        const body = `Hello ${reminder.full_name},

This is a scheduled reminder to take your prescribed medication:
- Medication: ${reminder.medication_name}
- Dosage: ${reminder.dosage}
- Instruction/Frequency: ${reminder.frequency}

Please follow your doctor's instructions. If you experience adverse side effects, contact the clinic immediately.

Be well,
Clinic Health Manager`;

        // Queue the email
        await emailService.queueEmail(reminder.email, subject, body);

        // Update last_reminded_at
        await db.run(
          'UPDATE medication_reminders SET last_reminded_at = ? WHERE id = ?',
          [now.toISOString(), reminder.id]
        );
      }
    }
  } catch (err) {
    console.error('[Worker Error] Medication reminders run encountered an error:', err.message);
  }
}

/**
 * Triggers the email queue processor.
 */
async function processEmailQueue() {
  console.log('[Worker] Processing email queue...');
  try {
    await emailService.processQueue();
  } catch (err) {
    console.error('[Worker Error] Email queue processing failed:', err.message);
  }
}

/**
 * Checks for upcoming appointments scheduled for tomorrow and sends reminders to both patient and doctor.
 */
async function checkUpcomingAppointments() {
  console.log('[Worker] Checking for upcoming appointments tomorrow...');
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = tomorrow.toISOString().split('T')[0];

  try {
    // Find appointments booked for tomorrow that haven't been reminded
    const appointments = await db.all(
      `SELECT a.*, 
              p.email as patient_email, p.full_name as patient_name,
              d.email as doctor_email, d.full_name as doctor_name
       FROM appointments a
       JOIN users p ON a.patient_id = p.id
       JOIN users d ON a.doctor_id = d.id
       WHERE a.appointment_date = ? AND a.status = 'booked' AND a.appointment_reminder_sent = 0`,
      [tomorrowStr]
    );

    for (const app of appointments) {
      // Send reminder to Patient
      const patientSubject = `Reminder: Upcoming Appointment with Dr. ${app.doctor_name} Tomorrow`;
      const patientBody = `Dear ${app.patient_name},

This is a friendly reminder that you have a consultation scheduled with Dr. ${app.doctor_name} tomorrow, ${app.appointment_date}, at ${app.start_time} - ${app.end_time}.

Symptom Review Summary:
- Chief Complaint: ${app.chief_complaint || 'None'}
- Urgency Level: ${app.urgency_level || 'Low'}

If you need to reschedule or cancel, please contact the clinic administrator.

Warm regards,
Clinic Care Team`;
      await emailService.queueEmail(app.patient_email, patientSubject, patientBody);

      // Send reminder to Doctor
      const doctorSubject = `Upcoming Appointment: ${app.patient_name} Tomorrow`;
      const doctorBody = `Dear Dr. ${app.doctor_name},

This is a reminder of your upcoming consultation tomorrow, ${app.appointment_date}, at ${app.start_time} - ${app.end_time} with patient ${app.patient_name}.

AI Pre-Visit Review:
- Urgency Level: ${app.urgency_level || 'Low'}
- Chief Complaint: ${app.chief_complaint || 'None'}

Please review their symptoms inside your dashboard before the appointment.

Regards,
Clinic System`;
      await emailService.queueEmail(app.doctor_email, doctorSubject, doctorBody);

      // Update appointment to mark reminder as sent
      await db.run('UPDATE appointments SET appointment_reminder_sent = 1 WHERE id = ?', [app.id]);
      console.log(`[Worker] Upcoming reminder queued for appointment ${app.id}`);
    }

    if (appointments.length > 0) {
      // Process the queue immediately to send reminders out
      await emailService.processQueue();
    }
  } catch (err) {
    console.error('[Worker Error] Upcoming appointments check encountered an error:', err.message);
  }
}

/**
 * Starts all background workers.
 */
function startWorkers() {
  console.log('Background workers starting up...');
  
  // Run email queue processing every 30 seconds
  emailQueueInterval = setInterval(processEmailQueue, 30 * 1000);
  
  // Run medication reminders checking every 60 seconds
  medicationReminderInterval = setInterval(checkMedicationReminders, 60 * 1000);

  // Run upcoming appointment checks every 60 seconds
  upcomingAppointmentInterval = setInterval(checkUpcomingAppointments, 60 * 1000);

  // Run immediately on boot
  processEmailQueue();
  checkMedicationReminders();
  checkUpcomingAppointments();
}

/**
 * Clean shutdown of intervals.
 */
function stopWorkers() {
  console.log('Stopping background workers...');
  if (emailQueueInterval) clearInterval(emailQueueInterval);
  if (medicationReminderInterval) clearInterval(medicationReminderInterval);
  if (upcomingAppointmentInterval) clearInterval(upcomingAppointmentInterval);
}

module.exports = {
  startWorkers,
  stopWorkers,
  checkMedicationReminders,
  processEmailQueue,
  checkUpcomingAppointments
};
