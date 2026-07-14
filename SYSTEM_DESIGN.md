# Healthcare Appointment System Design Specification

This document provides a technical system design write-up for the Healthcare Appointment & Follow-up Manager, detailing the mechanisms for concurrency control, scheduling conflict resolution, temporary reservation, and notification resilience.

---

## 1. Concurrency Control: Double-Booking Prevention

To eliminate race conditions when two patients simultaneously attempt to book the same appointment slot, the system employs a multi-tiered concurrency control model:

```
[Concurrent Requests] ──> [Mutex Lock (booking_locks INSERT)] ──> [Unique Index Check] ──> [DB Write]
```

### Database Concurrency Modes
* **WAL (Write-Ahead Logging)**: Enabled via `PRAGMA journal_mode=WAL;` in [db.js](file:///d:/HealthCare%20Appointment%201/HealthCare%20Appointment/backend/db.js#L21) to support concurrent read and write operations on SQLite.
* **Busy Timeout**: Configured via `PRAGMA busy_timeout=5000;` to queue database write conflicts for up to 5000ms before returning `SQLITE_BUSY`, allowing transient write contentions to resolve gracefully.

### Application Mutex Locking
The core locking logic is encapsulated in [bookingLock.js](file:///d:/HealthCare%20Appointment%201/HealthCare%20Appointment/backend/bookingLock.js).
1. When a patient books a slot, the system attempts to insert a lock entry into the `booking_locks` table.
2. The `booking_locks` table enforces a composite `PRIMARY KEY (doctor_id, appointment_date, start_time)`.
3. If insertion succeeds, the booking callback is executed, inserting the appointment record.
4. If insertion fails (violates primary key constraint), the system throws a conflict error: *“This specific appointment slot is currently being booked by another process.”*
5. The lock row is cleaned up in a `finally` block. To prevent deadlock in case of sudden server crashes, expired locks (>30 seconds) are automatically purged at the beginning of each lock acquisition request.

### Database Constraints
As a final fail-safe, the database enforces slot uniqueness via a partial unique index on the `appointments` table:
```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_appointments_unique_active_slot 
ON appointments (doctor_id, appointment_date, start_time) 
WHERE status = 'booked';
```

---

## 2. Doctor Leave Conflict Handling

When a clinic administrator registers a leave date for a doctor, the system initiates a cascading resolution process to clean up conflicting schedules and notify affected patients:

```
Admin declares leave YYYY-MM-DD
  ├── Update leave_days array in doctor_profiles
  ├── Find active appointments for doctor_id on date
  └── For each conflict appointment:
        ├── Update appointment status to 'cancelled'
        ├── Sync delete Google Calendar Event via calendarService.js
        └── Queue cancellation email via emailService.js
```

The database query in [admin.js](file:///d:/HealthCare%20Appointment%201/HealthCare%20Appointment/backend/routes/admin.js#L126-L191) joins the `appointments` and `users` tables to find all booked patient records for that doctor and date. The cancellation updates, calendar sync deletions, and email queuing occur within a unified route handler, followed by an immediate execution of `emailService.processQueue()` to notify patients without delay.

---

## 3. Slot Hold Mechanism

Before booking, patients hold a selected time slot for a limited duration (e.g., during checkout or form completion).

* **Schema**: The `slot_holds` table tracks temporary reservations with fields: `id`, `doctor_id`, `patient_id`, `appointment_date`, `start_time`, and `held_until` (unix timestamp).
* **Database Constraint**: A database-level `UNIQUE (doctor_id, appointment_date, start_time)` index prevents concurrent holds on the same slot.
* **Hold Verification**: When displaying slots or holding a slot, the system filters out expired holds:
  ```sql
  SELECT start_time FROM slot_holds 
  WHERE doctor_id = ? AND appointment_date = ? AND held_until > ?
  ```
* **Cleanup**: Expired holds are cleared from the table during subsequent booking operations or when holds are checked, releasing the slots back to the public pool.

---

## 4. Notification Failure Handling (Asynchronous Outbox)

To ensure email notifications are never lost due to external SMTP outages, rate limits, or API failures, the platform implements an **Asynchronous Outbox Pattern**:

```
[System Event] ──> [Queue Email in email_queue]
                         │
                         ▼
             [Background Worker Run]
             ├── If SendGrid Configured ──> sgMail.send() ──> [Update status to 'sent']
             └── If SendGrid Fails / Offline ──> Append to sent_emails.log ──> [Retry / Mark status]
```

### Outbox Design
1. **Queuing**: Instead of sending emails inline, events call `queueEmail()`, which inserts a record into the `email_queue` table with status `pending`.
2. **Scheduled Worker**: The background worker in [worker.js](file:///d:/HealthCare%20Appointment%201/HealthCare%20Appointment/backend/worker.js) periodically triggers `processQueue()`.
3. **SendGrid Delivery**: The worker attempts transmission via SendGrid. If successful, status changes to `sent`.
4. **Retry Mechanism**: If SendGrid fails (e.g., due to network outages), the status is updated to `failed`, the error message is stored in `last_error`, and the `retry_count` is incrementable. The worker retries failed entries up to 3 times before abandoning them.
5. **Auditing Fallback**: If SendGrid is unconfigured (development mode) or fails during transmission, the email details are logged to [sent_emails.log](file:///d:/HealthCare%20Appointment%201/HealthCare%20Appointment/backend/sent_emails.log) with the SendGrid failure metadata, serving as a reliable audit trail.

---

## 5. End-to-End Booking Lifecycle Working

```
[Patient UI] Selects Slot ──> Insert Slot Hold ──> Enter Symptoms ──> Submit Booking
  ├── Acquire Mutex Lock (booking_locks)
  ├── Verify active hold or existing booked appointment
  ├── Call LLM Symptom Analysis (fallback to rule-based offline parsing if API fails)
  ├── Insert Appointment record into appointments (Unique index check)
  ├── Queue Confirmation Email in email_queue
  ├── Create Google Calendar Event (via calendarService.js)
  ├── Release Mutex Lock
  └── Background Worker processes email_queue and syncs calendars
```
