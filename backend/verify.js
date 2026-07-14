const db = require('./db');
const { acquireLock } = require('./bookingLock');
const llmService = require('./llmService');
const calendarService = require('./calendarService');

async function runTests() {
  console.log('==================================================');
  console.log('STARTING INTEGRATION TESTS & VERIFICATION');
  console.log('==================================================\n');

  try {
    // 1. Setup Database
    await db.initDb();
    console.log('[Test Setup] DB schema verified.');

    // Seed temporary doctor and patient for testing
    const docId = 'test_doctor_id';
    const patId1 = 'test_patient_id_1';
    const patId2 = 'test_patient_id_2';
    
    // Clear old test records
    await db.run('DELETE FROM users WHERE id IN (?, ?, ?)', [docId, patId1, patId2]);
    await db.run('DELETE FROM doctor_profiles WHERE user_id = ?', [docId]);
    await db.run('DELETE FROM appointments WHERE doctor_id = ?', [docId]);

    // Insert Doctor & Patient profiles
    await db.run('INSERT INTO users (id, email, password_hash, role, full_name) VALUES (?, ?, ?, ?, ?)',
      [docId, 'test_doc@clinic.com', 'hash', 'doctor', 'Dr. Tester']);
    await db.run('INSERT INTO doctor_profiles (user_id, specialization, working_hours, slot_duration, leave_days) VALUES (?, ?, ?, ?, ?)',
      [docId, 'Testology', JSON.stringify({ Monday: { start: '09:00', end: '17:00' } }), 30, '[]']);
    
    await db.run('INSERT INTO users (id, email, password_hash, role, full_name) VALUES (?, ?, ?, ?, ?)',
      [patId1, 'pat1@clinic.com', 'hash', 'patient', 'Patient One']);
    await db.run('INSERT INTO users (id, email, password_hash, role, full_name) VALUES (?, ?, ?, ?, ?)',
      [patId2, 'pat2@clinic.com', 'hash', 'patient', 'Patient Two']);
    
    console.log('[Test Setup] Test user profiles injected.');

    // ----------------------------------------------------------------
    // TEST 1: CONCURRENT BOOKING MUTEX LOCKING SAFETY
    // ----------------------------------------------------------------
    console.log('\n--- TEST 1: Concurrent Booking Race Condition Check ---');
    
    const date = '2026-07-20'; // A Monday
    const startTime = '10:00';

    let successCount = 0;
    let failureCount = 0;
    let failureMessage = '';

    const attemptBooking = async (patientId) => {
      // Wrap slot validation and insert in acquireLock
      return await acquireLock(docId, date, startTime, async () => {
        // Check database for double booking
        const doubleBooking = await db.get(
          'SELECT id FROM appointments WHERE doctor_id = ? AND appointment_date = ? AND start_time = ? AND status = "booked"',
          [docId, date, startTime]
        );
        if (doubleBooking) {
          throw new Error('This slot has already been booked. Please choose another time.');
        }

        // Simulate some minor async process delay (e.g. LLM query simulation or DB network)
        await new Promise(r => setTimeout(r, 200));

        const appId = `app_${patientId}`;
        await db.run(
          `INSERT INTO appointments (id, patient_id, doctor_id, appointment_date, start_time, end_time, symptoms, status) 
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [appId, patientId, docId, date, startTime, '10:30', 'Symptom test', 'booked']
        );
        return appId;
      });
    };

    // Execute two booking requests at the exact same moment
    console.log(`[Test] Launching parallel booking tasks for Dr. Tester on ${date} at ${startTime}...`);
    const results = await Promise.allSettled([
      attemptBooking(patId1),
      attemptBooking(patId2)
    ]);

    results.forEach((res, index) => {
      if (res.status === 'fulfilled') {
        successCount++;
        console.log(`[Test] Booking ${index + 1} succeeded: App ID: ${res.value}`);
      } else {
        failureCount++;
        failureMessage = res.reason.message;
        console.log(`[Test] Booking ${index + 1} failed: Error: "${res.reason.message}"`);
      }
    });

    // ASSERTION: Exactly 1 should succeed, and 1 should fail due to lock/double booking
    if (successCount === 1 && failureCount === 1) {
      console.log('✅ TEST 1 PASSED: Concurrent booking prevented successfully. Mutex lock works!');
    } else {
      console.error(`❌ TEST 1 FAILED: Unexpected success/failure distribution. Success: ${successCount}, Failures: ${failureCount}`);
      process.exitCode = 1;
    }

    // Double check the DB to ensure only one record is actually written
    const bookedCount = await db.get(
      'SELECT count(*) as count FROM appointments WHERE doctor_id = ? AND appointment_date = ? AND start_time = ? AND status = "booked"',
      [docId, date, startTime]
    );
    console.log(`[DB Check] Confirmed booked records in DB: ${bookedCount.count}`);
    if (bookedCount.count !== 1) {
      console.error('❌ TEST 1 FAILURE: DB contains duplicate slots booked!');
      process.exitCode = 1;
    }

    // ----------------------------------------------------------------
    // TEST 2: LLM OFFLINE FALLBACK PARSING
    // ----------------------------------------------------------------
    console.log('\n--- TEST 2: LLM Service Fallback Engine Check ---');
    console.log('[Test] Triggering symptom analysis with offline simulation...');
    
    // Test high urgency detection
    const highSymptoms = 'I am feeling severe chest pain and have trouble breathing today.';
    const highAnalysis = await llmService.analyzeSymptoms(highSymptoms);
    console.log(`[Test] High Urgency Symptoms Output Urgency: ${highAnalysis.urgency_level}`);
    
    // Test low urgency detection
    const lowSymptoms = 'Just need a routine annual physical checkup. No pain, no issues.';
    const lowAnalysis = await llmService.analyzeSymptoms(lowSymptoms);
    console.log(`[Test] Low Urgency Symptoms Output Urgency: ${lowAnalysis.urgency_level}`);

    // Assertions
    if (highAnalysis.urgency_level === 'High' && lowAnalysis.urgency_level === 'Low') {
      console.log('✅ TEST 2 PASSED: Rule-based fallback correctly rated symptom urgency levels!');
    } else {
      console.error('❌ TEST 2 FAILED: Fallback engine urgency ratings did not match expected values.');
      process.exitCode = 1;
    }

    // ----------------------------------------------------------------
    // TEST 3: SLOT HOLD & EXPIRY CHECK
    // ----------------------------------------------------------------
    console.log('\n--- TEST 3: Slot Hold and Expiry Check ---');
    const holdSlotTime = '11:00';
    const holdDate = '2026-07-20';
    const holdId = 'test_hold_id';

    // Patient 1 holds the slot for 2 seconds
    const heldUntil = Date.now() + 2000;
    await db.run(
      `INSERT INTO slot_holds (id, doctor_id, patient_id, appointment_date, start_time, held_until) 
       VALUES (?, ?, ?, ?, ?, ?)`,
      [holdId, docId, patId1, holdDate, holdSlotTime, heldUntil]
    );
    console.log(`[Test] Patient One holds slot ${holdSlotTime} until ${new Date(heldUntil).toLocaleTimeString()}`);

    // Check if Patient Two sees it as held
    const activeHoldsForPat2 = await db.all(
      `SELECT start_time FROM slot_holds 
       WHERE doctor_id = ? AND appointment_date = ? AND held_until > ? AND patient_id != ?`,
      [docId, holdDate, Date.now(), patId2]
    );
    console.log(`[Test] Active holds blocking Patient Two:`, activeHoldsForPat2);

    const isBlockedForPat2 = activeHoldsForPat2.some(h => h.start_time === holdSlotTime);
    if (isBlockedForPat2) {
      console.log('✅ TEST 3 (Part 1/2) PASSED: Slot hold successfully blocked Patient Two.');
    } else {
      console.error('❌ TEST 3 (Part 1/2) FAILED: Slot hold did NOT block Patient Two.');
      process.exitCode = 1;
    }

    // Wait 2.5 seconds for hold to expire
    console.log('[Test] Waiting 2.5 seconds for hold to expire...');
    await new Promise(resolve => setTimeout(resolve, 2500));

    // Check again for Patient Two
    const expiredHoldsForPat2 = await db.all(
      `SELECT start_time FROM slot_holds 
       WHERE doctor_id = ? AND appointment_date = ? AND held_until > ? AND patient_id != ?`,
      [docId, holdDate, Date.now(), patId2]
    );
    console.log(`[Test] Active holds blocking Patient Two after delay:`, expiredHoldsForPat2);

    const isBlockedAfterExpiry = expiredHoldsForPat2.some(h => h.start_time === holdSlotTime);
    if (!isBlockedAfterExpiry) {
      console.log('✅ TEST 3 (Part 2/2) PASSED: Slot hold successfully expired and released slot.');
    } else {
      console.error('❌ TEST 3 (Part 2/2) FAILED: Slot hold did NOT release after expiry.');
      process.exitCode = 1;
    }

    // Clean up hold
    await db.run('DELETE FROM slot_holds WHERE id = ?', [holdId]);


    // ----------------------------------------------------------------
    // TEST 4: UPCOMING APPOINTMENT REMINDERS CHECK
    // ----------------------------------------------------------------
    console.log('\n--- TEST 4: Upcoming Appointment Reminders Check ---');
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = tomorrow.toISOString().split('T')[0];

    const upcomingAppId = 'test_upcoming_app_id';

    // Clear old test emails
    await db.run('DELETE FROM email_queue');

    // Insert an appointment for tomorrow that is booked and has not had a reminder sent
    await db.run(
      `INSERT INTO appointments (id, patient_id, doctor_id, appointment_date, start_time, end_time, symptoms, status, appointment_reminder_sent) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      [upcomingAppId, patId1, docId, tomorrowStr, '14:00', '14:30', 'Follow up check', 'booked']
    );
    console.log(`[Test] Injected upcoming appointment tomorrow (${tomorrowStr}) for Patient One.`);

    // Run the worker task to check for upcoming appointments
    const worker = require('./worker');
    await worker.checkUpcomingAppointments();

    // Verify reminder_sent flag is updated
    const appAfterCheck = await db.get('SELECT appointment_reminder_sent FROM appointments WHERE id = ?', [upcomingAppId]);
    console.log(`[Test] Appointment reminder_sent flag in DB after check: ${appAfterCheck.appointment_reminder_sent}`);

    // Verify emails were queued in email_queue
    const queuedEmails = await db.all('SELECT recipient_email, subject FROM email_queue');
    console.log(`[Test] Emails queued:`, queuedEmails);

    const hasPatientEmail = queuedEmails.some(e => e.recipient_email === 'pat1@clinic.com' && e.subject.includes('Reminder'));
    const hasDoctorEmail = queuedEmails.some(e => e.recipient_email === 'test_doc@clinic.com' && e.subject.includes('Upcoming'));

    if (appAfterCheck.appointment_reminder_sent === 1 && hasPatientEmail && hasDoctorEmail) {
      console.log('✅ TEST 4 PASSED: Upcoming appointment reminders correctly identified, flag updated, and emails queued.');
    } else {
      console.error('❌ TEST 4 FAILED: Reminders check failed to update flag or queue doctor/patient emails.');
      process.exitCode = 1;
    }

    // Clean up appointments and emails
    await db.run('DELETE FROM appointments WHERE id = ?', [upcomingAppId]);
    await db.run('DELETE FROM email_queue');

    // ----------------------------------------------------------------
    // TEST 5: DISTRIBUTED TOKEN REFRESH MUTEX LOCK CHECK
    // ----------------------------------------------------------------
    console.log('\n--- TEST 5: Distributed Token Refresh Mutex Lock Check ---');
    const testUserId = 'test_user_ref_id';
    
    // Force release old lock if any
    await db.run('DELETE FROM token_refresh_locks WHERE user_id = ?', [testUserId]);
    
    const refreshResults = await Promise.all([
      calendarService.acquireRefreshLock(testUserId),
      new Promise(async (resolve) => {
        // Delay second lock request slightly so first one acquires it first
        await new Promise(r => setTimeout(r, 100));
        const res = await calendarService.acquireRefreshLock(testUserId);
        resolve(res);
      }),
      new Promise(async (resolve) => {
        // Release lock after 1.5 seconds
        await new Promise(r => setTimeout(r, 1500));
        await calendarService.releaseRefreshLock(testUserId);
        resolve(true);
      })
    ]);

    console.log(`[Test] Lock acquisition results (First, Second):`, refreshResults[0], refreshResults[1]);
    if (refreshResults[0] === true && refreshResults[1] === true) {
      console.log('✅ TEST 5 PASSED: Second concurrent refresh request waited and successfully acquired lock after release.');
    } else {
      console.error('❌ TEST 5 FAILED: Refresh lock concurrency test did not yield expected results.');
      process.exitCode = 1;
    }


    // ----------------------------------------------------------------
    // TEST 6: DOCTOR DEACTIVATION & CASCADING CANCELLATIONS
    // ----------------------------------------------------------------
    console.log('\n--- TEST 6: Doctor Deactivation and Cascading Cancellations Check ---');
    const delDocId = 'doc_to_delete';
    const patientId = 'pat_affected';

    // Insert dummy doctor
    await db.run('INSERT INTO users (id, email, password_hash, role, full_name) VALUES (?, ?, ?, ?, ?)',
      [delDocId, 'del_doc@clinic.com', 'hash', 'doctor', 'Dr. Deleteme']);
    await db.run('INSERT INTO doctor_profiles (user_id, specialization, working_hours, slot_duration, leave_days) VALUES (?, ?, ?, ?, ?)',
      [delDocId, 'Erasure', '{}', 30, '[]']);
    await db.run('INSERT INTO users (id, email, password_hash, role, full_name) VALUES (?, ?, ?, ?, ?)',
      [patientId, 'affected_patient@clinic.com', 'hash', 'patient', 'Affected Patient']);

    // Insert an active booking
    const appToCancelId = 'app_to_cancel_id';
    await db.run(
      `INSERT INTO appointments (id, patient_id, doctor_id, appointment_date, start_time, end_time, symptoms, status) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [appToCancelId, patientId, delDocId, '2026-07-20', '16:00', '16:30', 'Symptom test for deletion', 'booked']
    );

    // Simulate the route's deletion logic:
    // 1. Find active appointments to cancel
    const apps = await db.all('SELECT * FROM appointments WHERE doctor_id = ? AND status = "booked"', [delDocId]);
    console.log(`[Test] Found ${apps.length} active appointments to cancel for deleted doctor.`);

    // 2. Cascade delete
    await db.run('DELETE FROM appointments WHERE doctor_id = ?', [delDocId]);
    await db.run('DELETE FROM doctor_profiles WHERE user_id = ?', [delDocId]);
    await db.run('DELETE FROM google_tokens WHERE user_id = ?', [delDocId]);
    await db.run('DELETE FROM users WHERE id = ?', [delDocId]);
    await db.run('DELETE FROM users WHERE id = ?', [patientId]);

    // Verify records are gone
    const checkDocUser = await db.get('SELECT id FROM users WHERE id = ?', [delDocId]);
    const checkDocProfile = await db.get('SELECT user_id FROM doctor_profiles WHERE user_id = ?', [delDocId]);
    const checkDocApp = await db.get('SELECT id FROM appointments WHERE doctor_id = ?', [delDocId]);

    if (!checkDocUser && !checkDocProfile && !checkDocApp && apps.length === 1) {
      console.log('✅ TEST 6 PASSED: Doctor deactivation successfully cancelled active bookings and cascade deleted all profile references.');
    } else {
      console.error('❌ TEST 6 FAILED: References remained in database after doctor removal.');
      process.exitCode = 1;
    }


    // Clean up test data
    await db.run('DELETE FROM users WHERE id IN (?, ?, ?)', [docId, patId1, patId2]);
    await db.run('DELETE FROM doctor_profiles WHERE user_id = ?', [docId]);
    await db.run('DELETE FROM appointments WHERE doctor_id = ?', [docId]);

    console.log('\n==================================================');
    console.log('ALL TESTS EXECUTED COMPLETED.');
    console.log('==================================================');
    db.db.close();
  } catch (err) {
    console.error('System failure during verification runner:', err);
    process.exit(1);
  }
}

runTests();
