const express = require('express');
const router = express.Router();
const db = require('../db');
const { authenticateToken, requireRole } = require('../authMiddleware');
const llmService = require('../llmService');
const emailService = require('../emailService');

// All doctor routes require doctor role authentication
router.use(authenticateToken, requireRole('doctor'));

/**
 * @route GET /api/doctor/appointments
 * @desc Get list of appointments booked with this doctor.
 */
router.get('/appointments', async (req, res) => {
  const doctorId = req.user.id;
  try {
    const appointments = await db.all(
      `SELECT a.*, u.full_name as patient_name, u.email as patient_email
       FROM appointments a
       JOIN users u ON a.patient_id = u.id
       WHERE a.doctor_id = ? 
       ORDER BY a.appointment_date DESC, a.start_time DESC`,
      [doctorId]
    );

    const formatted = appointments.map(app => ({
      ...app,
      suggested_questions: JSON.parse(app.suggested_questions || '[]')
    }));

    res.json(formatted);
  } catch (err) {
    console.error('Doctor fetch appointments error:', err.message);
    res.status(500).json({ error: 'Internal server error while retrieving appointments.' });
  }
});

/**
 * @route POST /api/doctor/appointments/:id/complete
 * @desc Complete an appointment. Adds notes, prescriptions, runs LLM summary, and schedules reminders.
 */
router.post('/appointments/:id/complete', async (req, res) => {
  const doctorId = req.user.id;
  const appointmentId = req.params.id;
  const { clinicalNotes, prescription } = req.body;

  if (!clinicalNotes || !prescription) {
    return res.status(400).json({ error: 'Please supply clinicalNotes and prescription.' });
  }

  try {
    // Verify appointment exists and is booked with this doctor
    const app = await db.get(
      'SELECT a.*, u.email as patient_email, u.full_name as patient_name FROM appointments a JOIN users u ON a.patient_id = u.id WHERE a.id = ? AND a.doctor_id = ?',
      [appointmentId, doctorId]
    );

    if (!app) {
      return res.status(404).json({ error: 'Appointment not found or not registered under your profile.' });
    }

    if (app.status !== 'booked') {
      return res.status(400).json({ error: `Appointment cannot be completed because its current status is: ${app.status}.` });
    }

    const doctorName = req.user.fullName;

    // 1. Trigger LLM Analysis on clinical notes and prescription
    console.log(`[LLM] Requesting post-visit analysis for app ID: ${appointmentId}`);
    const llmSummary = await llmService.analyzePostVisitNotes(clinicalNotes + '\nPrescription: ' + prescription);

    // 2. Update Appointment in DB
    await db.run(
      `UPDATE appointments 
       SET status = 'completed', 
           clinical_notes = ?, 
           prescription = ?, 
           patient_summary = ?, 
           updated_at = CURRENT_TIMESTAMP 
       WHERE id = ?`,
      [clinicalNotes, prescription, llmSummary.patient_summary, appointmentId]
    );

    // 3. Clear existing reminders for this appointment (if any, just in case)
    await db.run('DELETE FROM medication_reminders WHERE appointment_id = ?', [appointmentId]);

    // 4. Create medication reminder records in DB for scheduled workers
    const remindersCreated = [];
    if (Array.isArray(llmSummary.medications)) {
      for (const med of llmSummary.medications) {
        const reminderId = Math.random().toString(36).substring(2, 15);
        const name = med.name || 'Prescription Medication';
        const dosage = med.dosage || 'As directed';
        const frequency = med.frequency || 'daily';
        const startDate = med.start_date || new Date().toISOString().split('T')[0];
        const endDate = med.end_date || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

        await db.run(
          `INSERT INTO medication_reminders (
            id, appointment_id, patient_id, medication_name, dosage, frequency, start_date, end_date
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [reminderId, appointmentId, app.patient_id, name, dosage, frequency, startDate, endDate]
        );

        remindersCreated.push({
          id: reminderId,
          name,
          dosage,
          frequency,
          startDate,
          endDate
        });
      }
    }

    // 5. Queue summary email to patient
    let medListText = '';
    remindersCreated.forEach(m => {
      medListText += `- ${m.name} (${m.dosage}): Take ${m.frequency} from ${m.startDate} to ${m.endDate}\n`;
    });

    const patientSubject = `Post-Visit Summary & Prescription: Dr. ${doctorName}`;
    const patientBody = `Dear ${app.patient_name},

Thank you for visiting Dr. ${doctorName} today. Here is a review of your consultation:

Clinical Visit Summary:
${llmSummary.patient_summary}

Prescription Details:
${prescription}

Scheduled Reminders:
${medListText || 'No recurring reminders scheduled.'}

You will receive medication reminders by email according to the prescribed frequency.

Warm regards,
Clinic Care Manager`;

    await emailService.queueEmail(app.patient_email, patientSubject, patientBody);

    // Run email worker instantly
    await emailService.processQueue();

    res.json({
      message: 'Consultation completed successfully! Patient summary was generated and reminders scheduled.',
      patientSummary: llmSummary.patient_summary,
      reminders: remindersCreated
    });
  } catch (err) {
    console.error('Complete appointment error:', err.message);
    res.status(500).json({ error: 'Internal server error while completing consultation.' });
  }
});

module.exports = router;
