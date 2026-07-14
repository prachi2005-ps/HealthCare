// Database-backed slot locking service to prevent race conditions during concurrent bookings.
const db = require('./db');

/**
 * Executes a callback within a database-backed lock.
 * If the lock is already active, throws an immediate conflict error.
 * 
 * @param {string} doctorId 
 * @param {string} date (YYYY-MM-DD)
 * @param {string} startTime (HH:MM)
 * @param {Function} callback Async callback function to run inside the lock
 */
async function acquireLock(doctorId, date, startTime, callback) {
  // 1. Clean up expired locks (older than 30 seconds)
  try {
    await db.run('DELETE FROM booking_locks WHERE created_at < ?', [Date.now() - 30000]);
  } catch (err) {
    console.error('[Lock System] Failed to clean up expired booking locks:', err.message);
  }

  // 2. Attempt to acquire lock by inserting lock row
  try {
    await db.run(
      'INSERT INTO booking_locks (doctor_id, appointment_date, start_time, created_at) VALUES (?, ?, ?, ?)',
      [doctorId, date, startTime, Date.now()]
    );
  } catch (err) {
    // If insertion failed (Primary Key conflict), another transaction holds the lock
    throw new Error('This specific appointment slot is currently being booked by another process. Please choose a different slot or try again shortly.');
  }

  // 3. Execute callback and release the lock in the finally block
  try {
    return await callback();
  } finally {
    try {
      await db.run(
        'DELETE FROM booking_locks WHERE doctor_id = ? AND appointment_date = ? AND start_time = ?',
        [doctorId, date, startTime]
      );
    } catch (err) {
      console.error('[Lock System] Failed to release booking lock:', err.message);
    }
  }
}

module.exports = {
  acquireLock
};
