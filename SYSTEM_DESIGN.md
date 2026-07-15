# Healthcare Appointment System: Technical Design & Evaluation Report

This document serves as the unified technical specification and evaluation report for the Healthcare Appointment & Follow-up Manager. It details the architectural decisions, database schemas, integration methods, and reliability patterns implemented in both local offline and remote integrated configurations.

---

## 1. Concurrency Control: Double-Booking Prevention & Slot Holds

To eliminate race conditions when multiple users attempt to reserve or book the same appointment slot, the system employs a multi-tiered concurrency control model.

### A. Slot Booking Concurrency Flow
```
[Concurrent Requests]
       │
       ▼
[bookingLock.acquireLock()] ──(Insert into booking_locks PK)──► [Throw 409 Conflict]
       │
       ▼ (Lock Acquired)
[Verify Slot Hold & Status]
       │
       ▼
[DB Transaction Write] ───────(Unique Index Constraint)──────► [Rollback & Throw Error]
       │
       ▼ (Success)
[Release booking_locks]
```

### B. Application-Level Mutex Locking
The system implements a database-backed distributed mutex lock in [bookingLock.js](file:///d:/HealthCare%20Appointment%201/HealthCare%20Appointment/backend/bookingLock.js):
1. **Acquisition**: When a booking request is initiated, the system inserts a locking row into the `booking_locks` table.
2. **Database Constraint**: The table enforces a composite Primary Key: `PRIMARY KEY (doctor_id, appointment_date, start_time)`.
3. **Collision Resolution**: If another request is currently processing a booking for the same slot, the database throws a unique constraint violation. The backend catches this and returns a `409 Conflict` error to the second caller.
4. **Deadlock Mitigation**: To prevent deadlocks resulting from worker thread crashes, the system automatically purges expired locks (older than 30 seconds) on every lock acquisition request.
5. **Release**: The lock is guaranteed to be deleted in a `finally` block once the booking callback completes.

### C. Database Concurrency & Journaling Modes
Configured in [db.js](file:///d:/HealthCare%20Appointment%201/HealthCare%20Appointment/backend/db.js):
* **WAL (Write-Ahead Logging)**: Enabled via `PRAGMA journal_mode=WAL;` to allow concurrent readers and a writer without blocking database access.
* **Busy Timeout**: Set to 5 seconds (`PRAGMA busy_timeout=5000;`) to queue lock contentions at the database layer before returning `SQLITE_BUSY`.

### D. Final Database Fail-safe
As a final safeguard, the database enforces slot uniqueness via a partial unique index on the `appointments` table:
```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_appointments_unique_active_slot 
ON appointments (doctor_id, appointment_date, start_time) 
WHERE status = 'booked';
```
This ensures that even if application-level locks are bypassed, double-booking is physically impossible at the storage layer.

### E. Slot Hold Mechanism
Before committing a booking, patients hold a slot while filling out symptoms or during checkout.
* **Schema**: The `slot_holds` table tracks temporary reservations with fields: `id`, `doctor_id`, `patient_id`, `appointment_date`, `start_time`, and `held_until` (unix timestamp).
* **Database Constraint**: Enforced by a database-level `UNIQUE (doctor_id, appointment_date, start_time)` index.
* **Verification**: Inactive/expired holds are filtered out dynamically during slot availability checks:
  ```sql
  SELECT start_time FROM slot_holds 
  WHERE doctor_id = ? AND appointment_date = ? AND held_until > ?
  ```

---

## 2. Doctor Leave Management & Cascading Cancellations

When a clinic administrator registers a leave date for a doctor, the system executes a cascading resolution process to update the database, clean up calendar slots, and notify affected patients.

```
Admin registers leave YYYY-MM-DD
   │
   ├─► Update JSON array 'leave_days' in 'doctor_profiles'
   ├─► Fetch active appointments for doctor_id on date
   │
   └─► For each conflicting appointment:
         ├─► Update appointment status to 'cancelled'
         ├─► Delete Google Calendar Event (via calendarService.js)
         └─► Queue cancellation email in 'email_queue' (via emailService.js)
```

### Execution Details:
The administration route handler in [admin.js](file:///d:/HealthCare%20Appointment%201/HealthCare%20Appointment/backend/routes/admin.js#L126-L191) runs the database update. It fetches patient details for conflicting appointments and queues individual cancellation emails. The worker processes the queue immediately to ensure prompt alerts.

---

## 3. Asynchronous Outbox Notification Reliability

To prevent email sending failures (due to SMTP timeouts, API rate limits, or network issues) from breaking the core application flow, the system utilizes the **Transactional Outbox Pattern**.

```
[System Event] ──► [Queue Email in email_queue] (Atomic DB transaction)
                         │
                         ▼
             [Background Worker (worker.js)]
             ├── If SendGrid API Configured ──► sgMail.send() ──► status: 'sent'
             └── SendGrid Error / Offline ──► Log to sent_emails.log ──► Increment retry / status: 'failed'
```

### Outbox Design Elements:
1. **Queuing**: Instead of sending emails inline, events call `queueEmail()` in [emailService.js](file:///d:/HealthCare%20Appointment%201/HealthCare%20Appointment/backend/emailService.js#L18), which inserts a database record with a `pending` status.
2. **Periodic Worker**: A background worker in [worker.js](file:///d:/HealthCare%20Appointment%201/HealthCare%20Appointment/backend/worker.js) queries pending or failed emails with `retry_count < 3`.
3. **Fallback Logging**: If SendGrid is not configured or fails, details are logged to [sent_emails.log](file:///d:/HealthCare%20Appointment%201/HealthCare%20Appointment/backend/sent_emails.log).
4. **Retry Mechanism**: The worker increments `retry_count` and updates `last_error` upon failure, retrying up to 3 times before archiving the email.

---

## 4. AI Engine: Structured LLM Integration & Robust Fallbacks

The system utilizes Gemini 1.5 Flash to generate clinical insights. The implementation focuses on structured response enforcement, data safety, and robust offline fallback engines.

### A. Symptom Analysis
Invoked during appointment booking in [llmService.js](file:///d:/HealthCare%20Appointment%201/HealthCare%20Appointment/backend/llmService.js#L710):
* **Prompt Engineering**: Instructs Gemini to evaluate symptoms and output structured JSON detailing the urgency level, a symptom-specific chief complaint, and exactly three diagnostic questions.
* **Structured Output Enforcement**: Leverages the Gemini API's `responseSchema` and `responseMimeType` properties to force the LLM to output valid JSON matching a predefined schema.
* **Syntax Healing**: If the JSON is truncated or slightly malformed, `repairJson()` automatically fixes bracket alignment, trailing commas, and unclosed quotes.
* **Offline Rule Fallback**: If the API key is missing or the endpoint is unreachable, the system transparently falls back to `fallbackAnalyzeSymptoms()`, which uses regex keyword matching to assign urgency levels and select diagnostic questions.

### B. Post-Visit Notes & Reminders
Invoked by doctors when saving consultation notes:
* **Summarization**: Generates a warm, patient-friendly summary translated from medical jargon (e.g., *dyspnea* → *difficulty breathing*).
* **Extraction**: Extracts a structured array of medications containing dosage, frequency, and start/end dates.
* **Offline Parser Fallback**: `fallbackAnalyzeNotes()` acts as the local fallback, using regex to extract medications and parse schedules from plain text note strings.

---

## 5. Google Calendar & Distributed OAuth Integration

The system supports Google Calendar integration, enabling calendar events to be synchronized for both doctors and patients.

### A. Distributed OAuth Token Refresh Lock
When multiple parallel requests attempt to refresh an expired OAuth token for a user, API collisions can occur. The system solves this in [calendarService.js](file:///d:/HealthCare%20Appointment%201/HealthCare%20Appointment/backend/calendarService.js#L89-L148):
1. **Acquire Refresh Lock**: Before refreshing, a thread attempts to insert a lock into `token_refresh_locks`.
2. **Wait and Retry Loop**: Concurrent threads back off and poll for up to 4.5 seconds.
3. **Double-Check Pattern**: Once the lock is acquired, the thread re-reads the database to check if another thread refreshed the token during the wait period. If yes, it uses the new token directly, bypassing unnecessary API calls.
4. **Release**: The lock is deleted in a `finally` block.

```
Thread A & B detect expired token
   ├── Thread A acquires 'token_refresh_locks' ──────► Performs Google OAuth Refresh ──► Updates DB
   └── Thread B fails lock ──► Sleeps 150ms ──► Polls DB ──► Detects fresh token in DB ──► Uses directly
```

### B. Calendar Sync Fallback
If the server's Google OAuth settings are missing or if the API request fails, calendar events fall back to being logged to [google_calendar_sync.log](file:///d:/HealthCare%20Appointment%201/HealthCare%20Appointment/backend/google_calendar_sync.log) for auditing.

---

## 6. System Database Schema Design

The system runs on SQLite, organized with the following database schema in [db.js](file:///d:/HealthCare%20Appointment%201/HealthCare%20Appointment/backend/db.js):

### Database Tables Layout
```
   ┌───────────────┐          ┌─────────────────────┐
   │     users     │ ◄────────│   doctor_profiles   │
   └───────────────┘          └─────────────────────┘
       ▲       ▲
       │       │              ┌─────────────────────┐
       │       └──────────────│    appointments     │
       └──────────────────────└─────────────────────┘
                                  ▲             ▲
                                  │             │
                      ┌───────────┴─────────┐   │
                      │medication_reminders │   │
                      └─────────────────────┘   │
                                                │
                                    ┌───────────┴─────────┐
                                    │    slot_holds       │
                                    └─────────────────────┘
```

#### 1. `users`
Tracks patient, doctor, and admin accounts.
* `id` (TEXT, PK): Unique identifier.
* `email` (TEXT, UNIQUE): User email.
* `password_hash` (TEXT): Secure bcrypt hash.
* `role` (TEXT): Role constraint: `admin`, `doctor`, or `patient`.
* `full_name` (TEXT): Display name.

#### 2. `doctor_profiles`
Contains scheduling variables and metadata.
* `user_id` (TEXT, PK, FK -> `users.id`): References the user.
* `specialization` (TEXT): Medical specialty.
* `working_hours` (TEXT): JSON representation of weekly availability.
* `slot_duration` (INTEGER): Default appointment length in minutes (defaults to `30`).
* `leave_days` (TEXT): JSON array storing doctor's leave dates.

#### 3. `appointments`
Tracks reservations, clinical summaries, and sync properties.
* `id` (TEXT, PK): Unique identifier.
* `patient_id` (TEXT, FK -> `users.id`): References the patient.
* `doctor_id` (TEXT, FK -> `users.id`): References the doctor.
* `appointment_date` (TEXT): Date formatted YYYY-MM-DD.
* `start_time` / `end_time` (TEXT): Timestamps formatted HH:MM.
* `status` (TEXT): Enum constraint: `booked`, `cancelled`, or `completed`.
* `symptoms` (TEXT): Raw symptom report.
* `urgency_level` (TEXT): Urgency indicator (`Low`, `Medium`, `High`, `Pending`).
* `chief_complaint` (TEXT): LLM-summarized main complaint.
* `suggested_questions` (TEXT): JSON array of diagnostic questions.
* `clinical_notes` / `prescription` (TEXT): Medical entries recorded by the doctor.
* `patient_summary` (TEXT): Patient-friendly consultation summary.
* `google_event_id` (TEXT): Google Calendar event reference.
* `appointment_reminder_sent` (INTEGER): Flag tracking pre-visit alert delivery status.

#### 4. `medication_reminders`
Stores medication schedules.
* `id` (TEXT, PK): Unique identifier.
* `appointment_id` (TEXT, FK): Link to consultation.
* `patient_id` (TEXT, FK): Link to patient.
* `medication_name` / `dosage` / `frequency` (TEXT): Prescribed medication variables.
* `start_date` / `end_date` (TEXT): Duration dates (YYYY-MM-DD).
* `last_reminded_at` (DATETIME): Timestamp of last reminder dispatch.

#### 5. `email_queue`
Manages the Outbox message queue.
* `id` (TEXT, PK): Message identifier.
* `recipient_email` / `subject` / `body` (TEXT): Email properties.
* `status` (TEXT): Enum constraint: `pending`, `sent`, or `failed`.
* `retry_count` (INTEGER): Incremented on SendGrid transmission failures.
* `last_error` (TEXT): Diagnostic exception details.

#### 6. `google_tokens`
Stores Google OAuth credentials.
* `user_id` (TEXT, PK, FK): References the user.
* `access_token` / `refresh_token` (TEXT): Security keys.
* `expiry_date` (INTEGER): Expiration epoch.

#### 7. `slot_holds`
Manages temporary session holds.
* `id` (TEXT, PK): Hold identifier.
* `doctor_id` / `patient_id` (TEXT, FK): References doctor and patient.
* `appointment_date` / `start_time` (TEXT): Hold schedule details.
* `held_until` (INTEGER): Expiry timestamp.
* Enforces `UNIQUE (doctor_id, appointment_date, start_time)`.

#### 8. `booking_locks`
Used to manage application-level concurrency.
* `doctor_id` / `appointment_date` / `start_time` (TEXT): Lock attributes.
* `created_at` (INTEGER): Epoch timestamp used to expire old locks.
* Enforces `PRIMARY KEY (doctor_id, appointment_date, start_time)`.

#### 9. `token_refresh_locks`
Used to synchronize concurrent OAuth token refreshes.
* `user_id` (TEXT, PK): Locked user account.
* `locked_until` (INTEGER): Expiry timestamp.

---

## 8. API Architecture & Code Structure

The backend is built as a modular Express server with clear separation of routing, middleware, services, and database utilities.

```
HealthCare Appointment/
 ├── backend/
 │    ├── routes/                 # Express API Endpoint Handlers
 │    │    ├── admin.js           # Admin routes: Leave registration, audit logs
 │    │    ├── auth.js            # Auth routes: Register, Login, Google OAuth Callback
 │    │    ├── doctor.js          # Doctor routes: Clinical notes, calendar config
 │    │    └── patient.js         # Patient routes: Slot holds, appointments booking
 │    ├── authMiddleware.js       # JWT validation & role protection
 │    ├── bookingLock.js          # Distributed mutex service
 │    ├── calendarService.js      # Google Calendar API integration
 │    ├── db.js                   # SQLite database initialization & wrappers
 │    ├── emailService.js         # Email outbox queue service
 │    ├── llmService.js           # Gemini API & offline fallbacks
 │    ├── server.js               # Server entry point
 │    └── worker.js               # Background scheduler (Reminders, email queue processing)
 └── frontend/                    # Vite + React Frontend Application
```

### Core API Endpoints
* **Authentication (`/api/auth`)**:
  * `POST /register`: Register a new user.
  * `POST /login`: Generate JWT token.
  * `GET /google/url`: Retrieve Google authorization link for calendar integration.
  * `GET /google/callback`: Handle OAuth redirect and save tokens.
* **Patient Operations (`/api/patient`)**:
  * `GET /doctors`: List doctors and their schedules.
  * `POST /hold-slot`: Create temporary reservation.
  * `POST /book`: Validate holds, run symptom analysis, and finalize booking.
* **Doctor Operations (`/api/doctor`)**:
  * `GET /appointments`: View scheduled appointments.
  * `POST /appointments/:id/notes`: Record notes, trigger summary extraction, and generate medication schedules.
* **Admin Operations (`/api/admin`)**:
  * `POST /doctor/:id/leave`: Set leave dates and cancel conflicting bookings.
