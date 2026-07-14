const express = require('express');
const router = express.Router();
const db = require('../db');
const { authenticateToken, requireRole } = require('../authMiddleware');
const { acquireLock } = require('../bookingLock');
const llmService = require('../llmService');
const emailService = require('../emailService');
const calendarService = require('../calendarService');

// All patient routes require patient role authentication
router.use(authenticateToken, requireRole('patient'));

/**
 * Helper to compute day names from date strings.
 */
function getDayName(dateString) {
  const date = new Date(dateString);
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  return days[date.getDay()];
}

/**
 * Helper to add minutes to a time string "HH:MM"
 */
function addMinutes(timeStr, mins) {
  const [h, m] = timeStr.split(':').map(Number);
  const date = new Date();
  date.setHours(h, m, 0, 0);
  date.setMinutes(date.getMinutes() + mins);
  const fh = String(date.getHours()).padStart(2, '0');
  const fm = String(date.getMinutes()).padStart(2, '0');
  return `${fh}:${fm}`;
}

/**
 * @route GET /api/patient/doctors
 * @desc Search doctors by specialization (or get all if query empty).
 */
router.get('/doctors', async (req, res) => {
  const { specialization } = req.query;
  
  try {
    let query = `
      SELECT u.id, u.full_name, u.email, dp.specialization, dp.working_hours, dp.slot_duration, dp.leave_days
      FROM users u
      JOIN doctor_profiles dp ON u.id = dp.user_id
      WHERE u.role = 'doctor'
    `;
    const params = [];

    if (specialization) {
      query += ` AND dp.specialization LIKE ?`;
      params.push(`%${specialization}%`);
    }

    const doctors = await db.all(query, params);
    const parsedDoctors = doctors.map(doc => ({
      ...doc,
      working_hours: JSON.parse(doc.working_hours),
      leave_days: JSON.parse(doc.leave_days)
    }));

    res.json(parsedDoctors);
  } catch (err) {
    console.error('Search doctors error:', err.message);
    res.status(500).json({ error: 'Internal server error while searching doctors.' });
  }
});

/**
 * @route GET /api/patient/doctors/:id/slots
 * @desc Get available slots for a doctor on a specific date.
 */
router.get('/doctors/:id/slots', async (req, res) => {
  const doctorId = req.params.id;
  const { date } = req.query; // YYYY-MM-DD

  if (!date) {
    return res.status(400).json({ error: 'Please supply a date parameter (YYYY-MM-DD).' });
  }

  try {
    const doctor = await db.get(
      'SELECT u.full_name, dp.working_hours, dp.slot_duration, dp.leave_days FROM users u JOIN doctor_profiles dp ON u.id = dp.user_id WHERE u.id = ? AND u.role = "doctor"',
      [doctorId]
    );

    if (!doctor) {
      return res.status(404).json({ error: 'Doctor not found.' });
    }

    const leaveDays = JSON.parse(doctor.leave_days || '[]');
    if (leaveDays.includes(date)) {
      return res.json([]); // Doctor on leave
    }

    const workingHours = JSON.parse(doctor.working_hours || '{}');
    const dayName = getDayName(date);
    const shift = workingHours[dayName];

    if (!shift || !shift.start || !shift.end) {
      return res.json([]); // Non-working day
    }

    const slotDuration = doctor.slot_duration || 30;
    const slots = [];
    let current = shift.start;

    while (current < shift.end) {
      const next = addMinutes(current, slotDuration);
      if (next > shift.end) break;

      slots.push({
        start: current,
        end: next
      });
      current = next;
    }

    // Filter slots against existing booked appointments
    const booked = await db.all(
      `SELECT start_time FROM appointments 
       WHERE doctor_id = ? AND appointment_date = ? AND status = 'booked'`,
      [doctorId, date]
    );
    const bookedStarts = booked.map(b => b.start_time);

    // Filter slots against active holds by OTHER patients
    const activeHolds = await db.all(
      `SELECT start_time FROM slot_holds 
       WHERE doctor_id = ? AND appointment_date = ? AND held_until > ? AND patient_id != ?`,
      [doctorId, date, Date.now(), req.user.id]
    );
    const heldStarts = activeHolds.map(h => h.start_time);

    const availableSlots = slots.filter(slot => !bookedStarts.includes(slot.start) && !heldStarts.includes(slot.start));
    res.json(availableSlots);
  } catch (err) {
    console.error('Fetch slots error:', err.message);
    res.status(500).json({ error: 'Internal server error while calculating slots.' });
  }
});

/**
 * @route POST /api/patient/appointments
 * @desc Books a doctor slot safely preventing double-booking and fetching LLM summaries.
 */
router.post('/appointments', async (req, res) => {
  const patientId = req.user.id;
  const { doctorId, date, startTime, symptoms } = req.body;

  if (!doctorId || !date || !startTime || !symptoms) {
    return res.status(400).json({ error: 'Please supply doctorId, date, startTime, and symptoms.' });
  }

  try {
    // Acquire backend in-memory lock for doctor+date+slot to serialize concurrent bookings
    const result = await acquireLock(doctorId, date, startTime, async () => {
      // 1. Verify doctor availability and leave status
      const doctor = await db.get(
        'SELECT u.full_name, u.email, dp.working_hours, dp.slot_duration, dp.leave_days FROM users u JOIN doctor_profiles dp ON u.id = dp.user_id WHERE u.id = ?',
        [doctorId]
      );
      if (!doctor) throw new Error('Doctor profile not found.');

      const leaveDays = JSON.parse(doctor.leave_days || '[]');
      if (leaveDays.includes(date)) {
        throw new Error('The doctor has declared leave for this date.');
      }

      // Check if slot falls in shift
      const workingHours = JSON.parse(doctor.working_hours || '{}');
      const dayName = getDayName(date);
      const shift = workingHours[dayName];
      if (!shift || !shift.start || !shift.end || startTime < shift.start) {
        throw new Error('The selected slot is outside the doctor working hours.');
      }

      const slotDuration = doctor.slot_duration || 30;
      const endTime = addMinutes(startTime, slotDuration);
      if (endTime > shift.end) {
        throw new Error('The selected slot overlaps shift closing time.');
      }

      // 2. Check DB for double booking
      const doubleBooking = await db.get(
        `SELECT id FROM appointments 
         WHERE doctor_id = ? AND appointment_date = ? AND start_time = ? AND status = 'booked'`,
        [doctorId, date, startTime]
      );
      if (doubleBooking) {
        throw new Error('This slot has already been booked. Please choose another time.');
      }

      // 2b. Check if the slot is currently held by someone else
      const activeHold = await db.get(
        `SELECT id FROM slot_holds 
         WHERE doctor_id = ? AND appointment_date = ? AND start_time = ? AND held_until > ? AND patient_id != ?`,
        [doctorId, date, startTime, Date.now(), patientId]
      );
      if (activeHold) {
        throw new Error('This slot is currently held by another patient. Please select a different slot.');
      }

      // 3. Request LLM Symptom Analysis (pre-visit AI summary)
      console.log(`[LLM] Requesting symptom analysis for: "${symptoms.substring(0, 40)}..."`);
      const aiAnalysis = await llmService.analyzeSymptoms(symptoms);
      
      // 4. Save appointment to database
      const appointmentId = Math.random().toString(36).substring(2, 15);
      const suggestedQuestionsJson = JSON.stringify(aiAnalysis.suggested_questions);

      await db.run(
        `INSERT INTO appointments (
          id, patient_id, doctor_id, appointment_date, start_time, end_time, status, symptoms, 
          urgency_level, chief_complaint, suggested_questions
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          appointmentId, patientId, doctorId, date, startTime, endTime, 'booked', symptoms,
          aiAnalysis.urgency_level, aiAnalysis.chief_complaint, suggestedQuestionsJson
        ]
      );

      // 4b. Clear slot hold for this patient
      await db.run('DELETE FROM slot_holds WHERE patient_id = ?', [patientId]);

      // Fetch patient details
      const patient = await db.get('SELECT full_name, email FROM users WHERE id = ?', [patientId]);

      // Create local record object for integrations
      const appRecord = {
        id: appointmentId,
        patient_id: patientId,
        doctor_id: doctorId,
        appointment_date: date,
        start_time: startTime,
        end_time: endTime,
        symptoms,
        urgency_level: aiAnalysis.urgency_level,
        chief_complaint: aiAnalysis.chief_complaint
      };

      // 5. Sync Google Calendar
      console.log('[Google Calendar] Syncing appointment event...');
      const googleEventId = await calendarService.createCalendarEvent(
        appRecord, 
        doctor.full_name, 
        patient.full_name, 
        doctor.email, 
        patient.email
      );

      if (googleEventId) {
        await db.run('UPDATE appointments SET google_event_id = ? WHERE id = ?', [googleEventId, appointmentId]);
        appRecord.google_event_id = googleEventId;
      }

      // 6. Queue Confirmations Emails
      // To Patient
      const patientSubject = `Appointment Confirmed: Dr. ${doctor.full_name}`;
      const patientBody = `Dear ${patient.full_name},

Your medical appointment is confirmed. Details below:
- Doctor: Dr. ${doctor.full_name}
- Date: ${date}
- Time: ${startTime} - ${endTime}

Pre-Visit AI Review:
- Urgent rating: ${aiAnalysis.urgency_level}
- Chief Complaint: ${aiAnalysis.chief_complaint}

If you need to reschedule or cancel, please contact the clinic admin.
Warm regards,
Clinic Team`;
      await emailService.queueEmail(patient.email, patientSubject, patientBody);

      // To Doctor
      const doctorSubject = `New Patient Booking: ${patient.full_name}`;
      const doctorBody = `Dear Dr. ${doctor.full_name},

A new appointment has been scheduled in your calendar:
- Patient: ${patient.full_name}
- Date: ${date}
- Time: ${startTime} - ${endTime}
- Symptoms reported: "${symptoms}"

AI Clinical Analysis:
- Urgency Level: ${aiAnalysis.urgency_level}
- Chief Complaint Summary: ${aiAnalysis.chief_complaint}
- Recommended follow-up check questions:
  1. ${aiAnalysis.suggested_questions[0] || ''}
  2. ${aiAnalysis.suggested_questions[1] || ''}
  3. ${aiAnalysis.suggested_questions[2] || ''}

A calendar invite has been linked to your scheduler.
Regards,
Clinic System`;
      await emailService.queueEmail(doctor.email, doctorSubject, doctorBody);

      // Trigger immediate email queue processing
      await emailService.processQueue();

      return {
        id: appointmentId,
        doctorId,
        doctorName: doctor.full_name,
        date,
        startTime,
        endTime,
        urgencyLevel: aiAnalysis.urgency_level,
        chiefComplaint: aiAnalysis.chief_complaint,
        suggestedQuestions: aiAnalysis.suggested_questions
      };
    });

    res.status(201).json({ message: 'Appointment booked successfully!', appointment: result });
  } catch (err) {
    console.error('Booking slot error:', err.message);
    res.status(400).json({ error: err.message || 'Failed to book appointment slot.' });
  }
});

/**
 * @route GET /api/patient/appointments
 * @desc Get all appointments booked by the patient.
 */
router.get('/appointments', async (req, res) => {
  const patientId = req.user.id;
  try {
    const appointments = await db.all(
      `SELECT a.*, u.full_name as doctor_name, dp.specialization 
       FROM appointments a
       JOIN users u ON a.doctor_id = u.id
       JOIN doctor_profiles dp ON u.id = dp.user_id
       WHERE a.patient_id = ? 
       ORDER BY a.appointment_date DESC, a.start_time DESC`,
      [patientId]
    );

    const formatted = appointments.map(app => ({
      ...app,
      suggested_questions: JSON.parse(app.suggested_questions || '[]')
    }));

    res.json(formatted);
  } catch (err) {
    console.error('Fetch appointments error:', err.message);
    res.status(500).json({ error: 'Internal server error while fetching appointments.' });
  }
});

/**
 * @route GET /api/patient/reminders
 * @desc Get active medication reminders for the patient.
 */
router.get('/reminders', async (req, res) => {
  const patientId = req.user.id;
  try {
    const reminders = await db.all(
      'SELECT * FROM medication_reminders WHERE patient_id = ? ORDER BY start_date ASC',
      [patientId]
    );
    res.json(reminders);
  } catch (err) {
    console.error('Fetch reminders error:', err.message);
    res.status(500).json({ error: 'Internal server error while listing reminders.' });
  }
});

/**
 * @route POST /api/patient/slots/hold
 * @desc Temporarily holds a slot for 5 minutes.
 */
router.post('/slots/hold', async (req, res) => {
  const patientId = req.user.id;
  const { doctorId, date, startTime } = req.body;

  if (!doctorId || !date || !startTime) {
    return res.status(400).json({ error: 'Please supply doctorId, date, and startTime.' });
  }

  try {
    // Wrap in acquireLock so concurrent hold requests for the same slot are
    // serialized — only one patient can win the check-then-insert race.
    await acquireLock(doctorId, date, startTime, async () => {
      // 1. Verify slot is not already booked
      const doubleBooking = await db.get(
        `SELECT id FROM appointments 
         WHERE doctor_id = ? AND appointment_date = ? AND start_time = ? AND status = 'booked'`,
        [doctorId, date, startTime]
      );
      if (doubleBooking) {
        throw new Error('ALREADY_BOOKED:This slot has already been booked. Please choose another time.');
      }

      // 2. Verify slot is not actively held by another patient
      const activeHold = await db.get(
        `SELECT id FROM slot_holds 
         WHERE doctor_id = ? AND appointment_date = ? AND start_time = ? AND held_until > ? AND patient_id != ?`,
        [doctorId, date, startTime, Date.now(), patientId]
      );
      if (activeHold) {
        throw new Error('SLOT_HELD:This slot is currently held by another patient. Please try again shortly.');
      }

      // 3. Clear any existing active holds for this patient (one hold at a time)
      await db.run('DELETE FROM slot_holds WHERE patient_id = ?', [patientId]);

      // 4. Insert the new hold — the UNIQUE constraint on (doctor_id, appointment_date,
      //    start_time) acts as a final DB-level safety net against any remaining races.
      const holdId = Math.random().toString(36).substring(2, 15);
      const heldUntil = Date.now() + 5 * 60 * 1000; // 5 minutes

      try {
        await db.run(
          `INSERT INTO slot_holds (id, doctor_id, patient_id, appointment_date, start_time, held_until) 
           VALUES (?, ?, ?, ?, ?, ?)`,
          [holdId, doctorId, patientId, date, startTime, heldUntil]
        );
      } catch (insertErr) {
        // UNIQUE constraint violation means another concurrent request just won the race
        if (insertErr.message && insertErr.message.includes('UNIQUE constraint failed')) {
          throw new Error('SLOT_HELD:This slot was just taken by another patient. Please select a different slot.');
        }
        throw insertErr;
      }

      return { startTime, heldUntil };
    });

    // acquireLock does not return the callback's value directly; re-fetch the hold to build response
    const saved = await db.get(
      `SELECT held_until FROM slot_holds WHERE doctor_id = ? AND appointment_date = ? AND start_time = ? AND patient_id = ?`,
      [doctorId, date, startTime, patientId]
    );

    res.json({ message: 'Slot held successfully.', startTime, heldUntil: saved ? saved.held_until : Date.now() + 5 * 60 * 1000 });
  } catch (err) {
    console.error('Hold slot error:', err.message);
    const msg = err.message || 'Internal server error while holding slot.';
    // Strip internal error prefix tags before sending to client
    const cleanMsg = msg.replace(/^(ALREADY_BOOKED|SLOT_HELD):/, '');
    const isConflict = msg.startsWith('ALREADY_BOOKED:') || msg.startsWith('SLOT_HELD:') || msg.includes('being booked by another process');
    res.status(isConflict ? 409 : 500).json({ error: cleanMsg });
  }
});

/**
 * @route DELETE /api/patient/slots/hold
 * @desc Explicitly releases the patient's currently held slot.
 */
router.delete('/slots/hold', async (req, res) => {
  const patientId = req.user.id;
  try {
    await db.run('DELETE FROM slot_holds WHERE patient_id = ?', [patientId]);
    res.json({ message: 'Slot hold released successfully.' });
  } catch (err) {
    console.error('Release slot hold error:', err.message);
    res.status(500).json({ error: 'Internal server error while releasing slot hold.' });
  }
});

module.exports = router;
