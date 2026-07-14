const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const dbPath = path.resolve(__dirname, process.env.DATABASE_FILE || './database.sqlite');

// Ensure parent directory exists for SQLite database file
const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Failed to connect to SQLite database:', err);
  } else {
    console.log(`Connected to SQLite database at: ${dbPath}`);
    // Enable WAL mode for safe concurrent read/write access.
    // Without WAL, simultaneous bookings cause 'database is locked' errors.
    db.run('PRAGMA journal_mode=WAL;', (pragmaErr) => {
      if (pragmaErr) console.error('[DB] Failed to enable WAL mode:', pragmaErr.message);
      else console.log('[DB] WAL journal mode enabled.');
    });
    // Queue concurrent writes for up to 5 seconds before returning SQLITE_BUSY,
    // giving the lock system time to resolve races gracefully.
    db.run('PRAGMA busy_timeout=5000;', (pragmaErr) => {
      if (pragmaErr) console.error('[DB] Failed to set busy_timeout:', pragmaErr.message);
    });
  }
});

// Serialize DB writes or use standard queries
const dbRun = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
};

const dbGet = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
};

const dbAll = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
};

const dbExec = (sql) => {
  return new Promise((resolve, reject) => {
    db.exec(sql, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
};

// Initialize schema
const initDb = async () => {
  const schema = `
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT CHECK(role IN ('admin', 'doctor', 'patient')) NOT NULL,
      full_name TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS doctor_profiles (
      user_id TEXT PRIMARY KEY,
      specialization TEXT NOT NULL,
      working_hours TEXT NOT NULL, -- JSON string
      slot_duration INTEGER DEFAULT 30,
      leave_days TEXT DEFAULT '[]', -- JSON array of strings (dates)
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS appointments (
      id TEXT PRIMARY KEY,
      patient_id TEXT NOT NULL,
      doctor_id TEXT NOT NULL,
      appointment_date TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      status TEXT CHECK(status IN ('booked', 'cancelled', 'completed')) DEFAULT 'booked',
      symptoms TEXT NOT NULL,
      urgency_level TEXT CHECK(urgency_level IN ('Low', 'Medium', 'High', 'Pending')) DEFAULT 'Pending',
      chief_complaint TEXT,
      suggested_questions TEXT, -- JSON array of strings
      clinical_notes TEXT,
      prescription TEXT,
      patient_summary TEXT,
      google_event_id TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (patient_id) REFERENCES users(id),
      FOREIGN KEY (doctor_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS medication_reminders (
      id TEXT PRIMARY KEY,
      appointment_id TEXT NOT NULL,
      patient_id TEXT NOT NULL,
      medication_name TEXT NOT NULL,
      dosage TEXT NOT NULL,
      frequency TEXT NOT NULL,
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      last_reminded_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (appointment_id) REFERENCES appointments(id) ON DELETE CASCADE,
      FOREIGN KEY (patient_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS email_queue (
      id TEXT PRIMARY KEY,
      recipient_email TEXT NOT NULL,
      subject TEXT NOT NULL,
      body TEXT NOT NULL,
      status TEXT CHECK(status IN ('pending', 'sent', 'failed')) DEFAULT 'pending',
      retry_count INTEGER DEFAULT 0,
      last_error TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS google_tokens (
      user_id TEXT PRIMARY KEY,
      access_token TEXT NOT NULL,
      refresh_token TEXT,
      expiry_date INTEGER,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS slot_holds (
      id TEXT PRIMARY KEY,
      doctor_id TEXT NOT NULL REFERENCES users(id),
      patient_id TEXT NOT NULL REFERENCES users(id),
      appointment_date TEXT NOT NULL,
      start_time TEXT NOT NULL,
      held_until INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      -- Enforce one active hold per slot across all patients at the DB level.
      -- This is the final safety net against simultaneous hold race conditions.
      UNIQUE (doctor_id, appointment_date, start_time)
    );

    CREATE TABLE IF NOT EXISTS booking_locks (
      doctor_id TEXT NOT NULL,
      appointment_date TEXT NOT NULL,
      start_time TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (doctor_id, appointment_date, start_time)
    );

    CREATE TABLE IF NOT EXISTS token_refresh_locks (
      user_id TEXT PRIMARY KEY,
      locked_until INTEGER NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_appointments_unique_active_slot 
    ON appointments (doctor_id, appointment_date, start_time) 
    WHERE status = 'booked';

    CREATE INDEX IF NOT EXISTS idx_appointments_lookup 
    ON appointments (doctor_id, appointment_date, start_time);

    CREATE INDEX IF NOT EXISTS idx_reminders_date_lookup 
    ON medication_reminders (patient_id, start_date, end_date);

    -- Allows fast cleanup of expired booking locks without a full-table scan.
    CREATE INDEX IF NOT EXISTS idx_booking_locks_created 
    ON booking_locks (created_at);
  `;

  try {
    await dbExec(schema);
    console.log('Database schema checked/initialized successfully.');
    
    // Schema Migrations
    try {
      await dbExec('ALTER TABLE appointments ADD COLUMN appointment_reminder_sent INTEGER DEFAULT 0;');
      console.log('Database Migration: Added appointment_reminder_sent column to appointments.');
    } catch (migErr) {
      // Column already exists, ignore
    }
  } catch (err) {
    console.error('Error initializing database schema:', err);
    throw err;
  }
};

module.exports = {
  db,
  run: dbRun,
  get: dbGet,
  all: dbAll,
  exec: dbExec,
  initDb
};
