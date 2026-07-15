# Technical Evaluation & Design Architecture Report

This report provides a detailed breakdown of the technical decisions, problem-solving strategies, and architectural designs implemented in the Healthcare Appointment & Follow-up Manager. It aligns with the criteria specified in the developer evaluation focus.

---

## 1. Concurrency Control & Problem-Solving Approach

Scheduling systems are highly prone to concurrency races, double-booking, and inconsistent states. The application addresses these using a multi-layered prevention model.

```
[Booking Request] 
      │
      ▼
[Mutex Lock (booking_locks INSERT)] ──(Already Locked?)──> [Throw Conflict Error]
      │
      ▼ (Lock Acquired)
[Verify Slot Hold & Status]
      │
      ▼
[DB Transaction Write] ──(Fails Unique Index?)──> [Rollback & Throw Error]
      │
      ▼ (Success)
[Release Mutex Lock]
```

### A. Slot Conflicts & Double-Booking Prevention
1. **Application-Level Mutex Locking**:
   The system implements an active lock model in [bookingLock.js](file:///d:/HealthCare%20Appointment%201/HealthCare%20Appointment/backend/bookingLock.js). 
   - When a booking request is made, the backend attempts to insert a lock entry into the `booking_locks` table.
   - The table utilizes a composite **Primary Key** `(doctor_id, appointment_date, start_time)`.
   - If the database throws a constraint violation error, it indicates that another thread is currently finalizing a booking for the same slot. The request is rejected with a `409 Conflict` status immediately.
   - Expired locks (>30 seconds) are auto-purged on each request to prevent deadlocks in case of unexpected worker crashes.
2. **Database-Level Unique Constraint**:
   As a final safety net, [db.js](file:///d:/HealthCare%20Appointment%201/HealthCare%20Appointment/backend/db.js) defines a partial unique index:
   ```sql
   CREATE UNIQUE INDEX IF NOT EXISTS idx_appointments_unique_active_slot 
   ON appointments (doctor_id, appointment_date, start_time) 
   WHERE status = 'booked';
   ```
   This ensures that even if application-level locks bypass validation, the database physically rejects duplicate active bookings.
3. **SQLite Concurrency Settings**:
   To handle multiple concurrent database writes, SQLite is tuned with **Write-Ahead Logging (WAL)**:
   ```sql
   PRAGMA journal_mode=WAL;
   PRAGMA busy_timeout=5000;
   ```
   This allows readers to read the database without blocking writers and queues concurrent writes for up to 5 seconds before returning a `locked` error.

### B. Leave Management
When a doctor declares a leave day, the system handles cancellations reactively inside [admin.js](file:///d:/HealthCare%20Appointment%201/HealthCare%20Appointment/backend/routes/admin.js):
- The leave day is saved in the doctor's profile.
- The system queries for active (`booked`) appointments for that doctor on the specified date.
- For each conflicting appointment, the status is updated to `cancelled`, the associated **Google Calendar Event is deleted** via the API, and a **cancellation notification is queued** in the outbox.

### C. Notification Reliability (Asynchronous Outbox Pattern)
To ensure system actions (bookings, cancellations) never fail due to network outages, SMTP rate limits, or SendGrid downtime, we use the **Transactional Outbox Pattern**:
- **Decoupled Queuing**: Instead of sending emails synchronously during the HTTP request lifecycle, the system inserts the email body into the `email_queue` table in the database as part of the database transaction.
- **Background Worker**: A background loop in [worker.js](file:///d:/HealthCare%20Appointment%201/HealthCare%20Appointment/backend/worker.js) checks for `pending` or `failed` records where `retry_count < 3`.
- **Automatic Retries**: If SendGrid is down, the worker logs the error message in the row, increments `retry_count`, and retries during the next tick.
- **Fail-safe Audit Fallback**: If SendGrid is unconfigured (development mode) or fails continuously, email details are outputted to [sent_emails.log](file:///d:/HealthCare%20Appointment%201/HealthCare%20Appointment/backend/sent_emails.log) with SendGrid error payloads, maintaining audit trail consistency.

---

## 2. LLM Prompt Quality and Failure Handling

Artificial Intelligence integration in clinical workflows requires high precision, schema guarantees, and seamless offline redundancy.

### A. Prompt Engineering & Structured Output
The system interacts with the `gemini-1.5-flash` model inside [llmService.js](file:///d:/HealthCare%20Appointment%201/HealthCare%20Appointment/backend/llmService.js):
- **Structured Schemas**: The prompt configures **Structured Output** using Gemini's Native Schema support by providing the JSON schema structure directly in the API payload:
  ```javascript
  const payload = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: schema
    }
  };
  ```
- **Medical Jargon Translation**: The system utilizes a precise, clinical-to-patient translation requirement inside the prompt. It enforces translation of terms (e.g. *"dyspnea"* to *"difficulty breathing"*, *"angina"* to *"chest pain"*) to output empathetic, patient-friendly summaries.

### B. Error Handling & JSON Repair
1. **JSON Recovery**:
   LLMs can sometimes output truncated or slightly malformed JSON. The custom `repairJson()` function balances braces/brackets, removes trailing commas, and patches truncated string endpoints prior to calling `JSON.parse`.
2. **Offline Rule-Engine Fallback**:
   If the Gemini API key is missing, network access is down, or the API fails, the service falls back to a **high-fidelity rule-based parsing engine**:
   - `fallbackAnalyzeSymptoms()`: Scans symptom keywords, maps them to clinical categories, extracts urgency levels, and suggests diagnostic questions.
   - `fallbackAnalyzeNotes()`: Parses duration strings (days/weeks), strips dosage units, identifies clinical recommendations, translates common jargon using local mapping, and formats a warm patient greeting letter.

---

## 3. Database Schema Design

The SQLite database is structured to balance normalized relationships with performance indices.

```
┌──────────────┐          ┌─────────────────┐
│    users     ├─────────►│ doctor_profiles │
└──────┬───────┘          └─────────────────┘
       │
       ├─────────────────┐
       ▼                 ▼
┌──────────────┐  ┌──────────────┐
│ appointments │  │  slot_holds  │
└──────┬───────┘  └──────────────┘
       │
       ▼
┌──────────────────────┐
│ medication_reminders │
└──────────────────────┘
```

### Key Tables & Constraints
- **`users`**: Manages credentials, roles (`admin`, `doctor`, `patient`), and metadata.
- **`doctor_profiles`**: Linked to `users` via `FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE`. Stores specialized working hours and leaves.
- **`appointments`**: Holds date, timeslots, and clinical summary results. A partial index prevents overlapping active bookings:
  `CREATE UNIQUE INDEX idx_appointments_unique_active_slot ON appointments(...) WHERE status = 'booked'`.
- **`medication_reminders`**: Drives background patient compliance alerts. Uses a lookup index on `(patient_id, start_date, end_date)`.
- **`slot_holds`**: Tracks temporary cart holds during the checkout flow with a database-enforced `UNIQUE (doctor_id, appointment_date, start_time)` to block double-allocation of holds.
- **`email_queue`**: Backs the transactional email outbox system.

---

## 4. API Design & Code Structure

The backend application follows modular, service-oriented design patterns.

### Directory Structure
- **`/routes`**: Separate files handle routing policies, validating authorization states and payloads:
  - [auth.js](file:///d:/HealthCare%20Appointment%201/HealthCare%20Appointment/backend/routes/auth.js): Register/login, JWT generation.
  - [patient.js](file:///d:/HealthCare%20Appointment%201/HealthCare%20Appointment/backend/routes/patient.js): Slot browsing, holds, and bookings.
  - [doctor.js](file:///d:/HealthCare%20Appointment%201/HealthCare%20Appointment/backend/routes/doctor.js): Consult logs and patient prescription outputs.
  - [admin.js](file:///d:/HealthCare%20Appointment%201/HealthCare%20Appointment/backend/routes/admin.js): Doctor roster edits, leave scheduling.
- **`authMiddleware.js`**: Role-based access control checking JWT tokens in headers.
- **`db.js`**: Centralized SQLite connections, promisifying callback operations, and schema migration logic.
- **`worker.js`**: Background scheduling tasks (medication notifications, appointment reminders, email outbox).

---

## 5. Integration Services

### A. SendGrid Email Integration
- Configured via [emailService.js](file:///d:/HealthCare%20Appointment%201/HealthCare%20Appointment/backend/emailService.js).
- Utilizes official `@sendgrid/mail` module when `SENDGRID_API_KEY` is present.
- Generates styled HTML templates with robust text fallback formatting.

### B. Google Calendar OAuth 2.0 Flow
- Built on Google APIs Node Client (`googleapis`) in [calendarService.js](file:///d:/HealthCare%20Appointment%201/HealthCare%20Appointment/backend/calendarService.js).
- **OAuth Refresh Lock Pattern**:
  When multiple operations execute concurrently, they can try to refresh the expired OAuth access token simultaneously. This causes race conditions where Google revokes the second request's refresh token.
  The system prevents this with a database-backed lock:
  ```javascript
  // Acquire distributed lock for this user's token refresh
  const lockAcquired = await acquireRefreshLock(userId);
  ```
  This ensures only one process refreshes the token, while concurrent calls wait and load the updated credentials from the database.
- **Resilient Fallback Logging**: If a doctor has not authorized their Google account, event creation fails gracefully without breaking the appointment booking transaction, falling back to a structured log file `google_calendar_sync.log`.
