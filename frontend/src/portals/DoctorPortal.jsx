import { useState, useEffect } from 'react';

const formatFrequency = (freq) => {
  if (!freq) return '';
  const f = freq.toLowerCase();
  if (f === 'twice_daily') return 'Twice daily';
  if (f === 'daily') return 'Once daily';
  if (f === 'weekly') return 'Once weekly';
  return freq;
};

const formatReminderText = (medicationName, dosage, frequency) => {
  const freqLabel = formatFrequency(frequency).toLowerCase();
  const dosageClean = dosage || 'As directed';
  const name = medicationName || 'Medication';

  if (/^as directed/i.test(dosageClean)) {
    return `Take ${name}, ${freqLabel}`;
  }
  if (/^(?:apply|use|rub|drop|spray|inhale|gargle)/i.test(dosageClean)) {
    const capitalizedDosage = dosageClean.charAt(0).toUpperCase() + dosageClean.slice(1);
    return `${capitalizedDosage} of ${name}, ${freqLabel}`;
  }
  return `Take ${name} (${dosageClean}), ${freqLabel}`;
};

export default function DoctorPortal({ token, user }) {
  const [appointments, setAppointments] = useState([]);
  const [selectedApp, setSelectedApp] = useState(null);
  const [clinicalNotes, setClinicalNotes] = useState('');
  const [prescription, setPrescription] = useState('');
  const [alert, setAlert] = useState(null);
  const [loading, setLoading] = useState(false);
  const [summaryResult, setSummaryResult] = useState(null);
  const [tab, setTab] = useState('active'); // active, completed
  const [isLinked, setIsLinked] = useState(false);

  useEffect(() => {
    fetchAppointments();
  }, []);

  useEffect(() => {
    const checkStatus = async () => {
      try {
        const res = await fetch(`http://localhost:5000/api/auth/google/status?userId=${user.id}`, {
          headers: { Authorization: `Bearer ${token}` }
        });
        const data = await res.json();
        setIsLinked(data.linked);
      } catch (err) {
        console.error('Failed to check Google OAuth status:', err);
      }
    };
    
    checkStatus();
    
    // Check status again when window gains focus
    window.addEventListener('focus', checkStatus);
    return () => window.removeEventListener('focus', checkStatus);
  }, [user.id, token]);

  const fetchAppointments = async () => {
    try {
      const res = await fetch('http://localhost:5000/api/doctor/appointments', {
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await res.json();
      if (res.ok) {
        setAppointments(data);
      } else {
        setAlert({ type: 'error', message: data.error });
      }
    } catch (err) {
      setAlert({ type: 'error', message: 'Failed to connect to backend API.' });
    }
  };

  const handleLinkGoogleCalendar = async () => {
    if (isLinked) {
      window.open('https://calendar.google.com/', '_blank');
      return;
    }
    try {
      const res = await fetch(`http://localhost:5000/api/auth/google/url?userId=${user.id}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await res.json();
      if (data.url) {
        // Open OAuth redirect in a new window/tab
        window.open(data.url, '_blank', 'width=600,height=600');
      } else {
        setAlert({ type: 'success', message: 'Google OAuth is unconfigured on the server. Calendar Sync is running in simulation mode.' });
      }
    } catch (err) {
      setAlert({ type: 'error', message: 'Failed to fetch authorization URL.' });
    }
  };

  const handleCompleteConsultation = async (e) => {
    e.preventDefault();
    if (!clinicalNotes || !prescription) {
      setAlert({ type: 'error', message: 'Please supply clinical notes and prescription details.' });
      return;
    }

    setLoading(true);
    setAlert(null);
    setSummaryResult(null);

    try {
      const res = await fetch(`http://localhost:5000/api/doctor/appointments/${selectedApp.id}/complete`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({
          clinicalNotes,
          prescription
        })
      });

      const data = await res.json();
      if (res.ok) {
        setSummaryResult({
          patientSummary: data.patientSummary,
          reminders: data.reminders
        });
        setAlert({ type: 'success', message: 'Consultation completed and summaries generated.' });
        setClinicalNotes('');
        setPrescription('');
        fetchAppointments();
      } else {
        setAlert({ type: 'error', message: data.error || 'Failed to complete appointment.' });
      }
    } catch (err) {
      setAlert({ type: 'error', message: 'Connection error while completing consultation.' });
    } finally {
      setLoading(false);
    }
  };

  const activeAppointments = appointments.filter(app => app.status === 'booked');
  const completedAppointments = appointments.filter(app => app.status === 'completed' || app.status === 'cancelled');

  return (
    <div className="dashboard-container">
      <div className="dashboard-header">
        <div>
          <h1>Doctor Portal</h1>
          <p>Welcome back, Dr. {user.fullName.replace(/^dr\.?\s+/i, '')}. Review symptoms, analyze pre-visit complaints, and record clinical prescriptions.</p>
        </div>
        <div>
          <button 
            onClick={handleLinkGoogleCalendar} 
            className={isLinked ? "btn btn-primary" : "btn btn-secondary"} 
            style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}
          >
            {isLinked ? '📅 Open Google Calendar' : '📅 Link Google Calendar'}
          </button>
        </div>
      </div>

      {alert && (
        <div className={`alert alert-${alert.type}`}>
          <div>{alert.message}</div>
        </div>
      )}

      {summaryResult && (
        <div className="card" style={{ border: '2px solid var(--accent-primary)', background: 'var(--accent-light)', marginBottom: '1rem' }}>
          <h3 style={{ fontWeight: '800', color: 'var(--accent-primary)', marginBottom: '0.75rem' }}>✨ AI Consultation Summary Generated</h3>
          <h4 style={{ fontWeight: '700', marginTop: '0.5rem' }}>Patient-Friendly Summary:</h4>
          <p style={{ whiteSpace: 'pre-line', fontSize: '0.95rem', marginTop: '0.25rem', color: 'var(--text-secondary)' }}>{summaryResult.patientSummary}</p>
          
          <h4 style={{ fontWeight: '700', marginTop: '1rem' }}>Scheduled Medication Reminders:</h4>
          {summaryResult.reminders.length === 0 ? (
            <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>No recurring reminders scheduled.</p>
          ) : (
            <div style={{ marginTop: '0.5rem' }}>
              {summaryResult.reminders.map((rem, i) => (
                <div key={i} className="reminder-item" style={{ margin: '0.5rem 0 0 0' }}>
                  <div className="reminder-details">
                    <h4 style={{ fontWeight: '800' }}>{rem.name}</h4>
                    <p style={{ fontSize: '0.95rem', color: 'var(--text-secondary)', marginTop: '0.25rem' }}>
                      <strong>{formatReminderText(rem.name, rem.dosage, rem.frequency)}</strong>
                    </p>
                    <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '0.25rem' }}>Period: {rem.startDate} to {rem.endDate}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
          <button onClick={() => { setSummaryResult(null); setSelectedApp(null); }} className="btn btn-primary" style={{ marginTop: '1rem' }}>Close Summary</button>
        </div>
      )}

      <div className="tabs">
        <button className={`tab-btn ${tab === 'active' ? 'active' : ''}`} onClick={() => setTab('active')}>
          Active Schedule ({activeAppointments.length})
        </button>
        <button className={`tab-btn ${tab === 'completed' ? 'active' : ''}`} onClick={() => setTab('completed')}>
          Past / Cancelled ({completedAppointments.length})
        </button>
      </div>

      <div className="grid-2">
        {/* Appointments List */}
        <div>
          <h2 style={{ fontSize: '1.5rem', fontWeight: '800', marginBottom: '1rem' }}>
            {tab === 'active' ? 'Upcoming Bookings' : 'Past Visit Archives'}
          </h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            {(tab === 'active' ? activeAppointments : completedAppointments).length === 0 ? (
              <p style={{ color: 'var(--text-muted)' }}>No appointments found in this section.</p>
            ) : (
              (tab === 'active' ? activeAppointments : completedAppointments).map(app => {
                const isSelected = selectedApp && selectedApp.id === app.id;
                const isHighUrgency = app.urgency_level === 'High';
                
                return (
                  <div 
                    key={app.id} 
                    className="card"
                    style={{ 
                      cursor: 'pointer',
                      border: isSelected ? '2px solid var(--accent-primary)' : '1px solid var(--border-color)',
                      boxShadow: isSelected ? 'var(--hover-shadow)' : 'var(--card-shadow)',
                      background: isHighUrgency && app.status === 'booked' ? 'var(--status-high-bg)' : 'var(--bg-secondary)'
                    }}
                    onClick={() => {
                      if (summaryResult) setSummaryResult(null);
                      setSelectedApp(app);
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                      <div>
                        <h4 style={{ fontSize: '1.1rem', fontWeight: '700' }}>{app.patient_name}</h4>
                        <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>{app.patient_email}</p>
                      </div>
                      <span className={`urgency-indicator urgency-${app.urgency_level}`}>
                        {app.urgency_level} Urgency
                      </span>
                    </div>
                      <div style={{ display: 'flex', gap: '1rem', marginTop: '0.75rem', fontSize: '0.85rem', color: 'var(--text-secondary)', fontWeight: '600' }}>
                        <span>📅 {app.appointment_date}</span>
                        <span>⏰ {app.start_time} - {app.end_time}</span>
                        <span className={`status-badge ${app.status}`}>[{app.status}]</span>
                      </div>
                    <div style={{ marginTop: '0.75rem', padding: '0.5rem', background: 'var(--bg-tertiary)', borderRadius: '6px', fontSize: '0.9rem' }}>
                      <strong>Symptoms:</strong> "{app.symptoms}"
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Selected Appointment Details and Actions */}
        <div>
          {selectedApp ? (
            <div className="card" style={{ position: 'sticky', top: '90px', maxHeight: 'calc(100vh - 130px)', overflowY: 'auto', alignSelf: 'start', scrollbarWidth: 'thin' }}>
              <h2 className="card-title">Consultation Manager</h2>
              <div style={{ borderBottom: '1px solid var(--border-color)', paddingBottom: '1rem', marginBottom: '1rem' }}>
                <p>Patient: <strong>{selectedApp.patient_name}</strong></p>
                <p>Scheduled: <strong>{selectedApp.appointment_date}</strong> at <strong>{selectedApp.start_time} - {selectedApp.end_time}</strong></p>
                <p style={{ marginTop: '0.5rem' }}>Symptoms Reported: <em>"{selectedApp.symptoms}"</em></p>
              </div>

              {/* AI Pre-visit Summary Block */}
              <div style={{ background: 'var(--bg-tertiary)', padding: '1rem', borderRadius: '8px', marginBottom: '1.25rem' }}>
                <h4 style={{ fontWeight: '800', color: 'var(--accent-primary)', fontSize: '0.95rem', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                  🤖 Pre-Visit AI Summary
                </h4>
                <p style={{ fontSize: '0.9rem', fontWeight: '700', marginTop: '0.5rem' }}>
                  Urgency Rating: <span style={{ color: selectedApp.urgency_level === 'High' ? 'var(--status-high)' : selectedApp.urgency_level === 'Medium' ? 'var(--status-medium)' : 'var(--status-low)' }}>{selectedApp.urgency_level}</span>
                </p>
                <p style={{ fontSize: '0.9rem', color: 'var(--text-primary)', marginTop: '0.25rem' }}>
                  <strong>Chief Complaint:</strong> {selectedApp.chief_complaint || 'Pending analysis'}
                </p>
                <div style={{ marginTop: '0.75rem' }}>
                  <strong style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>Suggested Questions for Patient:</strong>
                  <ul style={{ paddingLeft: '1.25rem', marginTop: '0.25rem', fontSize: '0.85rem', display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                    {selectedApp.suggested_questions && selectedApp.suggested_questions.map((q, idx) => (
                      <li key={idx}>"{q}"</li>
                    ))}
                  </ul>
                </div>
              </div>

              {/* Complete visit form or view details */}
              {selectedApp.status === 'booked' ? (
                <form onSubmit={handleCompleteConsultation}>
                  <div className="form-group">
                    <label>Clinical Notes</label>
                    <textarea 
                      className="form-input"
                      rows="4"
                      placeholder="Enter clinical notes, diagnosis, symptoms observed, and follow-up advice..."
                      value={clinicalNotes}
                      onChange={e => setClinicalNotes(e.target.value)}
                      required
                      style={{ resize: 'vertical' }}
                    ></textarea>
                  </div>
                  <div className="form-group">
                    <label>Prescription</label>
                    <textarea 
                      className="form-input"
                      rows="3"
                      placeholder="Example:\nAmoxicillin 500mg - take 3 times a day for 7 days\nIbuprofen 400mg - take daily for 3 days"
                      value={prescription}
                      onChange={e => setPrescription(e.target.value)}
                      required
                      style={{ resize: 'vertical' }}
                    ></textarea>
                  </div>
                  <button type="submit" className="btn btn-primary" style={{ width: '100%' }} disabled={loading}>
                    {loading ? 'Analyzing Clinical Notes...' : 'Complete Consultation & Generate Reminders'}
                  </button>
                </form>
              ) : (
                <div>
                  <h4 style={{ fontWeight: '700', marginBottom: '0.5rem' }}>Post-Visit Details</h4>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', fontSize: '0.9rem' }}>
                    <div>
                      <strong>Clinical Notes:</strong>
                      <p style={{ background: 'var(--bg-tertiary)', padding: '0.5rem', borderRadius: '4px', whiteSpace: 'pre-line', marginTop: '0.25rem' }}>
                        {selectedApp.clinical_notes}
                      </p>
                    </div>
                    <div>
                      <strong>Prescription:</strong>
                      <p style={{ background: 'var(--bg-tertiary)', padding: '0.5rem', borderRadius: '4px', whiteSpace: 'pre-line', marginTop: '0.25rem' }}>
                        {selectedApp.prescription}
                      </p>
                    </div>
                    <div>
                      <strong>Patient Summary (AI):</strong>
                      <p style={{ background: 'var(--accent-light)', padding: '0.5rem', borderRadius: '4px', whiteSpace: 'pre-line', marginTop: '0.25rem', border: '1px dashed var(--accent-primary)' }}>
                        {selectedApp.patient_summary || 'Not generated'}
                      </p>
                    </div>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="card" style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '3rem 1.5rem', position: 'sticky', top: '90px' }}>
              <span style={{ fontSize: '2.5rem' }}>🩺</span>
              <h3 style={{ marginTop: '1rem', fontWeight: '700' }}>No Appointment Selected</h3>
              <p style={{ fontSize: '0.9rem', marginTop: '0.5rem' }}>Choose an appointment from the list to view symptoms, access pre-visit AI advice, and log clinical notes.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
