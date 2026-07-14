const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const db = require('../db');
const { authenticateToken, requireRole } = require('../authMiddleware');
const emailService = require('../emailService');
const calendarService = require('../calendarService');

// All admin routes require admin role authentication
router.use(authenticateToken, requireRole('admin'));

/**
 * @route POST /api/admin/doctors
 * @desc Registers a new doctor and creates their profile.
 */
router.post('/doctors', async (req, res) => {
  const { email, password, fullName, specialization, workingHours, slotDuration } = req.body;

  if (!email || !password || !fullName || !specialization || !workingHours) {
    return res.status(400).json({ error: 'Please supply email, password, full name, specialization, and working hours.' });
  }

  // Normalize name by removing any leading 'Dr. ' or 'Dr ' prefix
  let cleanFullName = fullName;
  if (/^dr\.?\s+/i.test(cleanFullName)) {
    cleanFullName = cleanFullName.replace(/^dr\.?\s+/i, '');
  }

  try {
    // Check if user already exists
    const existingUser = await db.get('SELECT id FROM users WHERE email = ?', [email.trim().toLowerCase()]);
    if (existingUser) {
      return res.status(400).json({ error: 'A user with this email already exists.' });
    }

    const doctorId = Math.random().toString(36).substring(2, 15);
    const passwordHash = await bcrypt.hash(password, 10);

    // Default working hours structure if sent as object, store as string
    const workingHoursStr = typeof workingHours === 'object' ? JSON.stringify(workingHours) : workingHours;
    const finalSlotDuration = parseInt(slotDuration || 30);

    // Insert user
    await db.run(
      'INSERT INTO users (id, email, password_hash, role, full_name) VALUES (?, ?, ?, ?, ?)',
      [doctorId, email.trim().toLowerCase(), passwordHash, 'doctor', cleanFullName]
    );

    // Insert doctor profile
    await db.run(
      'INSERT INTO doctor_profiles (user_id, specialization, working_hours, slot_duration, leave_days) VALUES (?, ?, ?, ?, ?)',
      [doctorId, specialization, workingHoursStr, finalSlotDuration, '[]']
    );

    res.status(201).json({ message: 'Doctor registered successfully!' });
  } catch (err) {
    console.error('Doctor registration error:', err.message);
    res.status(500).json({ error: 'Internal server error while creating doctor.' });
  }
});

/**
 * @route GET /api/admin/doctors
 * @desc Gets list of all doctors and their profiles.
 */
router.get('/doctors', async (req, res) => {
  try {
    const doctors = await db.all(
      `SELECT u.id, u.email, u.full_name, dp.specialization, dp.working_hours, dp.slot_duration, dp.leave_days 
       FROM users u
       JOIN doctor_profiles dp ON u.id = dp.user_id
       WHERE u.role = 'doctor'`
    );

    // Parse JSON fields
    const parsedDoctors = doctors.map(doc => ({
      ...doc,
      working_hours: JSON.parse(doc.working_hours),
      leave_days: JSON.parse(doc.leave_days)
    }));

    res.json(parsedDoctors);
  } catch (err) {
    console.error('Fetch doctors error:', err.message);
    res.status(500).json({ error: 'Internal server error while listing doctors.' });
  }
});

/**
 * @route PUT /api/admin/doctors/:id
 * @desc Updates doctor specialization, hours, slot duration.
 */
router.put('/doctors/:id', async (req, res) => {
  const doctorId = req.params.id;
  const { specialization, workingHours, slotDuration } = req.body;

  try {
    const profile = await db.get('SELECT user_id FROM doctor_profiles WHERE user_id = ?', [doctorId]);
    if (!profile) {
      return res.status(404).json({ error: 'Doctor profile not found.' });
    }

    const workingHoursStr = typeof workingHours === 'object' ? JSON.stringify(workingHours) : workingHours;
    const finalSlotDuration = slotDuration ? parseInt(slotDuration) : 30;

    await db.run(
      `UPDATE doctor_profiles 
       SET specialization = COALESCE(?, specialization), 
           working_hours = COALESCE(?, working_hours), 
           slot_duration = COALESCE(?, slot_duration) 
       WHERE user_id = ?`,
      [specialization, workingHours ? workingHoursStr : null, slotDuration ? finalSlotDuration : null, doctorId]
    );

    res.json({ message: 'Doctor profile updated successfully!' });
  } catch (err) {
    console.error('Update profile error:', err.message);
    res.status(500).json({ error: 'Internal server error while updating profile.' });
  }
});

/**
 * @route POST /api/admin/doctors/:id/leave
 * @desc Declares a leave date for a doctor. Cancels conflict appointments and alerts patients.
 */
router.post('/doctors/:id/leave', async (req, res) => {
  const doctorId = req.params.id;
  const { date } = req.body; // Expects "YYYY-MM-DD"

  if (!date) {
    return res.status(400).json({ error: 'Please supply a leave date.' });
  }

  try {
    const doctor = await db.get('SELECT full_name FROM users WHERE id = ? AND role = "doctor"', [doctorId]);
    const profile = await db.get('SELECT leave_days FROM doctor_profiles WHERE user_id = ?', [doctorId]);
    if (!profile || !doctor) {
      return res.status(404).json({ error: 'Doctor not found.' });
    }

    const leaveDays = JSON.parse(profile.leave_days);
    if (leaveDays.includes(date)) {
      return res.status(400).json({ error: 'Leave is already registered for this date.' });
    }

    // Add to leave days array
    leaveDays.push(date);
    await db.run('UPDATE doctor_profiles SET leave_days = ? WHERE user_id = ?', [JSON.stringify(leaveDays), doctorId]);

    // Find and process conflict bookings
    const conflictAppointments = await db.all(
      `SELECT a.*, u.email as patient_email, u.full_name as patient_name 
       FROM appointments a
       JOIN users u ON a.patient_id = u.id
       WHERE a.doctor_id = ? AND a.appointment_date = ? AND a.status = 'booked'`,
      [doctorId, date]
    );

    for (const app of conflictAppointments) {
      // 1. Update DB Status
      await db.run('UPDATE appointments SET status = "cancelled", updated_at = CURRENT_TIMESTAMP WHERE id = ?', [app.id]);

      // 2. Queue Email Alert to patient
      const patientSubject = `Clinic Appointment Cancelled - Dr. ${doctor.full_name} on Leave`;
      const patientBody = `Dear ${app.patient_name},

We regret to inform you that your appointment with Dr. ${doctor.full_name} scheduled on ${app.appointment_date} at ${app.start_time} has been cancelled because the doctor will be on leave that day.

Please log in to your patient dashboard to select a different date or schedule with another doctor.

We apologize for any inconvenience caused.
Warm regards,
Clinic Admin`;
      await emailService.queueEmail(app.patient_email, patientSubject, patientBody);

      // 3. Sync Calendar cancellation
      await calendarService.deleteCalendarEvent(app);
    }

    // Process immediate send for queued cancellation notifications
    await emailService.processQueue();

    res.json({
      message: `Leave declared for ${date}. ${conflictAppointments.length} conflict appointments were cancelled, and patients were notified.`,
      cancelledCount: conflictAppointments.length
    });
  } catch (err) {
    console.error('Leave declaration error:', err.message);
    res.status(500).json({ error: 'Internal server error while scheduling doctor leave.' });
  }
});

/**
 * @route DELETE /api/admin/doctors/:id
 * @desc Deletes a doctor profile and account, cancels active bookings, and alerts patients.
 */
router.delete('/doctors/:id', async (req, res) => {
  const doctorId = req.params.id;

  try {
    const doctor = await db.get('SELECT full_name FROM users WHERE id = ? AND role = "doctor"', [doctorId]);
    if (!doctor) {
      return res.status(404).json({ error: 'Doctor profile not found.' });
    }

    // 1. Find active bookings for the doctor to cancel and notify patients
    const activeAppointments = await db.all(
      `SELECT a.*, u.email as patient_email, u.full_name as patient_name 
       FROM appointments a
       JOIN users u ON a.patient_id = u.id
       WHERE a.doctor_id = ? AND a.status = 'booked'`,
      [doctorId]
    );

    console.log(`[Admin] Cancelling ${activeAppointments.length} appointments for deleted doctor Dr. ${doctor.full_name}...`);

    for (const app of activeAppointments) {
      // Queue Email Alert to patient
      const patientSubject = `Clinic Appointment Cancelled - Dr. ${doctor.full_name} Removed`;
      const patientBody = `Dear ${app.patient_name},

We regret to inform you that your appointment with Dr. ${doctor.full_name} scheduled on ${app.appointment_date} at ${app.start_time} has been cancelled because the doctor has been removed from the clinic roster.

Please log in to your patient dashboard to schedule a different consultation.

We apologize for any inconvenience caused.
Warm regards,
Clinic Admin`;
      await emailService.queueEmail(app.patient_email, patientSubject, patientBody);

      // Sync Calendar cancellation
      await calendarService.deleteCalendarEvent(app);
    }

    // 2. Cascade delete all doctor related records from database
    await db.run('DELETE FROM appointments WHERE doctor_id = ?', [doctorId]);
    await db.run('DELETE FROM doctor_profiles WHERE user_id = ?', [doctorId]);
    await db.run('DELETE FROM google_tokens WHERE user_id = ?', [doctorId]);
    await db.run('DELETE FROM users WHERE id = ?', [doctorId]);

    // Process immediate send for queued cancellation notifications
    await emailService.processQueue();

    res.json({
      message: `Doctor Dr. ${doctor.full_name} was removed successfully. ${activeAppointments.length} appointments were cancelled, and patients were notified.`,
      cancelledCount: activeAppointments.length
    });
  } catch (err) {
    console.error('Doctor deletion error:', err.message);
    res.status(500).json({ error: 'Internal server error while removing doctor profile.' });
  }
});

module.exports = router;
