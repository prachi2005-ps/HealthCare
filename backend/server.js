require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const db = require('./db');
const worker = require('./worker');

// Load routers
const authRouter = require('./routes/auth');
const adminRouter = require('./routes/admin');
const patientRouter = require('./routes/patient');
const doctorRouter = require('./routes/doctor');

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

// Bind routers
app.use('/api/auth', authRouter);
app.use('/api/admin', adminRouter);
app.use('/api/patient', patientRouter);
app.use('/api/doctor', doctorRouter);

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// Global Error Handling Middleware
app.use((err, req, res, next) => {
  console.error('[Global Error]:', err.stack || err);
  res.status(err.status || 500).json({ 
    error: err.message || 'An unexpected error occurred on the server.' 
  });
});

/**
 * Seeds initial demo accounts if the database is empty.
 */
async function seedDemoData() {
  try {
    const adminEmail = 'admin@clinic.com';
    const doctorEmail = 'doctor@clinic.com';
    const patientEmail = 'patient@clinic.com';

    const hashAdmin = await bcrypt.hash('admin123', 10);
    const hashDoctor = await bcrypt.hash('doctor123', 10);
    const hashPatient = await bcrypt.hash('patient123', 10);

    // Seed Admin
    const admin = await db.get('SELECT id FROM users WHERE email = ?', [adminEmail]);
    if (!admin) {
      await db.run(
        'INSERT INTO users (id, email, password_hash, role, full_name) VALUES (?, ?, ?, ?, ?)',
        ['admin_user_id', adminEmail, hashAdmin, 'admin', 'System Admin']
      );
      console.log('Demo Seeder: Registered Administrator (admin@clinic.com / admin123)');
    }

    // Seed Doctor
    const doctor = await db.get('SELECT id FROM users WHERE email = ?', [doctorEmail]);
    if (!doctor) {
      const doctorId = 'doctor_user_id';
      await db.run(
        'INSERT INTO users (id, email, password_hash, role, full_name) VALUES (?, ?, ?, ?, ?)',
        [doctorId, doctorEmail, hashDoctor, 'doctor', 'Gregory House']
      );
      
      const workingHours = {
        Monday: { start: '09:00', end: '17:00' },
        Tuesday: { start: '09:00', end: '17:00' },
        Wednesday: { start: '09:00', end: '17:00' },
        Thursday: { start: '09:00', end: '17:00' },
        Friday: { start: '09:00', end: '17:00' }
      };

      await db.run(
        'INSERT INTO doctor_profiles (user_id, specialization, working_hours, slot_duration, leave_days) VALUES (?, ?, ?, ?, ?)',
        [doctorId, 'Diagnostics & Internal Medicine', JSON.stringify(workingHours), 30, '[]']
      );
      console.log('Demo Seeder: Registered Doctor Dr. Gregory House (doctor@clinic.com / doctor123)');
    }

    // Seed Patient
    const patient = await db.get('SELECT id FROM users WHERE email = ?', [patientEmail]);
    if (!patient) {
      await db.run(
        'INSERT INTO users (id, email, password_hash, role, full_name) VALUES (?, ?, ?, ?, ?)',
        ['patient_user_id', patientEmail, hashPatient, 'patient', 'John Doe']
      );
      console.log('Demo Seeder: Registered Patient John Doe (patient@clinic.com / patient123)');
    }
  } catch (err) {
    console.error('Demo Seeder Error:', err.message);
  }
}

// Start Server & Workers after DB Initialization
async function startServer() {
  try {
    await db.initDb();
    await seedDemoData();
    
    // Start background intervals
    worker.startWorkers();

    const serverInstance = app.listen(PORT, () => {
      console.log(`Backend API Server running successfully on port ${PORT}`);
    });

    // Handle process shutdown cleanly
    const shutdown = () => {
      console.log('Shutting down server gracefully...');
      worker.stopWorkers();
      serverInstance.close(() => {
        console.log('Server closed. Exiting process.');
        process.exit(0);
      });
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

  } catch (err) {
    console.error('Backend startup failure:', err);
    process.exit(1);
  }
}

startServer();
