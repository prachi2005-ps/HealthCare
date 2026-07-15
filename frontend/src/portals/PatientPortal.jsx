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

export default function PatientPortal({ token, user }) {
  const [appointments, setAppointments] = useState([]);
  const [reminders, setReminders] = useState([]);
  
  // Booking state
  const [doctors, setDoctors] = useState([]);
  const [searchSpecialization, setSearchSpecialization] = useState('');
  const [selectedDoctor, setSelectedDoctor] = useState(null);
  const [bookingDate, setBookingDate] = useState('');
  const [availableSlots, setAvailableSlots] = useState([]);
  const [selectedSlotTime, setSelectedSlotTime] = useState('');
  const [symptoms, setSymptoms] = useState('');
  
  const [heldSlot, setHeldSlot] = useState(null); // { time, expiresAt }
  const [timeLeft, setTimeLeft] = useState(0); // seconds remaining

  const [alert, setAlert] = useState(null);
  const [loading, setLoading] = useState(false);
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [activeTab, setActiveTab] = useState('appointments'); // appointments, book, reminders
  const [viewingApp, setViewingApp] = useState(null);
  const [isLinked, setIsLinked] = useState(false);

  // Hold Countdown Timer Effect
  useEffect(() => {
    if (!heldSlot) return;

    const interval = setInterval(() => {
      const remaining = Math.max(0, Math.floor((heldSlot.expiresAt - Date.now()) / 1000));
      setTimeLeft(remaining);

      if (remaining === 0) {
        clearInterval(interval);
        releaseSlotHold(true);
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [heldSlot]);

  // Release hold on tab change
  useEffect(() => {
    if (activeTab !== 'book' && heldSlot) {
      releaseSlotHold(false);
    }
  }, [activeTab]);

  // Release hold on component unmount
  useEffect(() => {
    return () => {
      fetch('http://localhost:5000/api/patient/slots/hold', {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      }).catch(err => console.error('Failed to release hold on unmount:', err));
    };
  }, [token]);

  useEffect(() => {
    fetchAppointments();
    fetchReminders();
    fetchDoctors();
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
      const res = await fetch('http://localhost:5000/api/patient/appointments', {
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await res.json();
      if (res.ok) {
        setAppointments(data);
      } else {
        setAlert({ type: 'error', message: data.error });
      }
    } catch (err) {
      setAlert({ type: 'error', message: 'Failed to connect to backend.' });
    }
  };

  const fetchReminders = async () => {
    try {
      const res = await fetch('http://localhost:5000/api/patient/reminders', {
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await res.json();
      if (res.ok) {
        setReminders(data);
      }
    } catch (err) {
      console.error('Failed to fetch reminders:', err.message);
    }
  };

  const fetchDoctors = async (spec = '') => {
    try {
      const res = await fetch(`http://localhost:5000/api/patient/doctors?specialization=${spec}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await res.json();
      if (res.ok) {
        setDoctors(data);
      }
    } catch (err) {
      console.error('Failed to fetch doctors:', err.message);
    }
  };

  const handleSearch = (e) => {
    e.preventDefault();
    fetchDoctors(searchSpecialization);
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
        window.open(data.url, '_blank', 'width=600,height=600');
      } else {
        setAlert({ type: 'success', message: 'Google OAuth is unconfigured on the server. Calendar Sync is running in simulation mode.' });
      }
    } catch (err) {
      setAlert({ type: 'error', message: 'Failed to fetch authorization URL.' });
    }
  };

  const loadAvailableSlots = async (docId, dateStr) => {
    if (!docId || !dateStr) return;
    setSlotsLoading(true);
    setAvailableSlots([]);
    setSelectedSlotTime('');
    
    try {
      const res = await fetch(`http://localhost:5000/api/patient/doctors/${docId}/slots?date=${dateStr}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await res.json();
      if (res.ok) {
        setAvailableSlots(data);
      } else {
        setAlert({ type: 'error', message: data.error || 'Failed to retrieve available slots.' });
      }
    } catch (err) {
      setAlert({ type: 'error', message: 'Failed to load doctor slots.' });
    } finally {
      setSlotsLoading(false);
    }
  };

  const releaseSlotHold = async (isExpired = false) => {
    setHeldSlot(null);
    setSelectedSlotTime('');
    setTimeLeft(0);

    try {
      await fetch('http://localhost:5000/api/patient/slots/hold', {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      });
    } catch (err) {
      console.error('Failed to release slot hold on server:', err.message);
    }

    if (isExpired) {
      setAlert({ type: 'error', message: 'Your slot hold has expired. Please select a slot again.' });
    }

    // Refresh slot availability
    if (selectedDoctor && bookingDate) {
      loadAvailableSlots(selectedDoctor.id, bookingDate);
    }
  };

  const handleSlotSelection = async (time) => {
    if (heldSlot && heldSlot.time === time) return;

    try {
      setAlert(null);
      const res = await fetch('http://localhost:5000/api/patient/slots/hold', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({
          doctorId: selectedDoctor.id,
          date: bookingDate,
          startTime: time
        })
      });

      const data = await res.json();
      if (res.ok) {
        setSelectedSlotTime(time);
        setHeldSlot({ time, expiresAt: data.heldUntil });
        setTimeLeft(Math.max(0, Math.floor((data.heldUntil - Date.now()) / 1000)));
        setAlert({ type: 'success', message: 'Slot held! Complete the symptom form within 5 minutes to secure your booking.' });
      } else {
        setAlert({ type: 'error', message: data.error || 'Failed to hold slot.' });
        if (selectedDoctor && bookingDate) {
          loadAvailableSlots(selectedDoctor.id, bookingDate);
        }
      }
    } catch (err) {
      setAlert({ type: 'error', message: 'Connection error while holding slot.' });
    }
  };

  const handleDateChange = (e) => {
    const dateStr = e.target.value;
    setBookingDate(dateStr);
    if (heldSlot) {
      releaseSlotHold(false);
    }
    if (selectedDoctor) {
      loadAvailableSlots(selectedDoctor.id, dateStr);
    }
  };

  const handleSelectDoctor = (doc) => {
    setSelectedDoctor(doc);
    setAvailableSlots([]);
    if (heldSlot) {
      releaseSlotHold(false);
    } else {
      setSelectedSlotTime('');
    }
    if (bookingDate) {
      loadAvailableSlots(doc.id, bookingDate);
    }
  };

  const handleBookAppointment = async (e) => {
    e.preventDefault();
    if (!selectedDoctor || !bookingDate || !selectedSlotTime || !symptoms) {
      setAlert({ type: 'error', message: 'Please complete all booking fields, select a slot, and detail your symptoms.' });
      return;
    }

    setLoading(true);
    setAlert(null);

    try {
      const res = await fetch('http://localhost:5000/api/patient/appointments', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({
          doctorId: selectedDoctor.id,
          date: bookingDate,
          startTime: selectedSlotTime,
          symptoms
        })
      });

      const data = await res.json();
      if (res.ok) {
        setAlert({ type: 'success', message: 'Appointment booked successfully!' });
        
        // Reset inputs
        setSelectedDoctor(null);
        setBookingDate('');
        setAvailableSlots([]);
        setSelectedSlotTime('');
        setSymptoms('');
        setHeldSlot(null);
        setTimeLeft(0);
        
        // Refresh tables
        fetchAppointments();
        fetchReminders();
        
        // Navigate back to list
        setActiveTab('appointments');
      } else {
        setAlert({ type: 'error', message: data.error || 'Booking failed.' });
      }
    } catch (err) {
      setAlert({ type: 'error', message: 'Connection error while booking.' });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="dashboard-container">
      {/* Hero Header */}
      <div style={{
        background: 'var(--accent-gradient)',
        borderRadius: 'var(--border-radius-lg)',
        padding: '2rem 2.5rem',
        color: 'white',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: '1rem',
        boxShadow: '0 8px 32px rgba(13, 148, 136, 0.25)'
      }}>
        <div>
          <h1 style={{ fontSize: '2rem', fontWeight: '800', marginBottom: '0.35rem' }}>
            Welcome back, {user.fullName.split(' ')[0]} 👋
          </h1>
          <p style={{ opacity: 0.9, fontSize: '0.95rem' }}>
            Manage your appointments, prescriptions, and medication schedules.
          </p>
          {/* Quick stats strip */}
          <div style={{ display: 'flex', gap: '1.5rem', marginTop: '1rem', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '0.85rem', background: 'rgba(255,255,255,0.18)', borderRadius: '50px', padding: '0.3rem 0.85rem', fontWeight: '600' }}>
              📅 {appointments.filter(a => a.status === 'booked').length} Upcoming
            </span>
            <span style={{ fontSize: '0.85rem', background: 'rgba(255,255,255,0.18)', borderRadius: '50px', padding: '0.3rem 0.85rem', fontWeight: '600' }}>
              ✅ {appointments.filter(a => a.status === 'completed').length} Completed
            </span>
            <span style={{ fontSize: '0.85rem', background: 'rgba(255,255,255,0.18)', borderRadius: '50px', padding: '0.3rem 0.85rem', fontWeight: '600' }}>
              💊 {reminders.length} Active Reminders
            </span>
          </div>
        </div>
        <button
          onClick={handleLinkGoogleCalendar}
          style={{
            background: 'rgba(255,255,255,0.22)',
            border: '1.5px solid rgba(255,255,255,0.45)',
            color: 'white',
            borderRadius: 'var(--border-radius-sm)',
            padding: '0.7rem 1.4rem',
            fontWeight: '700',
            fontSize: '0.9rem',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem',
            backdropFilter: 'blur(4px)',
            transition: 'var(--transition)',
            whiteSpace: 'nowrap'
          }}
        >
          {isLinked ? '📅 Open Google Calendar' : '📅 Link Google Calendar'}
        </button>
      </div>

      {alert && (
        <div className={`alert alert-${alert.type}`}>
          <div>{alert.message}</div>
        </div>
      )}

      {/* Tabs */}
      <div style={{ borderBottom: '2px solid var(--border-color)', display: 'flex', gap: '0' }}>
        {[
          { key: 'appointments', label: `My Appointments`, count: appointments.length },
          { key: 'book', label: 'Book New Consultation', count: null },
          { key: 'reminders', label: 'Medication Reminders', count: reminders.length },
        ].map(tab => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            style={{
              padding: '0.75rem 1.5rem',
              border: 'none',
              borderBottom: activeTab === tab.key ? '3px solid var(--accent-primary)' : '3px solid transparent',
              background: 'transparent',
              color: activeTab === tab.key ? 'var(--accent-primary)' : 'var(--text-secondary)',
              fontWeight: activeTab === tab.key ? '700' : '500',
              fontSize: '0.9rem',
              cursor: 'pointer',
              transition: 'var(--transition)',
              whiteSpace: 'nowrap',
              display: 'flex',
              alignItems: 'center',
              gap: '0.4rem',
              marginBottom: '-2px'
            }}
          >
            {tab.label}
            {tab.count !== null && (
              <span style={{
                background: activeTab === tab.key ? 'var(--accent-primary)' : 'var(--border-color)',
                color: activeTab === tab.key ? 'white' : 'var(--text-secondary)',
                borderRadius: '50px',
                fontSize: '0.72rem',
                fontWeight: '700',
                padding: '0.1rem 0.5rem',
                minWidth: '20px',
                textAlign: 'center'
              }}>
                {tab.count}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* MY APPOINTMENTS VIEW */}
      {activeTab === 'appointments' && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.1fr', gap: '1.5rem', alignItems: 'start' }}>
          {/* Left: List of bookings */}
          <div style={{ minWidth: 0 }}>
            <h2 style={{ fontSize: '1.25rem', fontWeight: '800', marginBottom: '1rem', color: 'var(--text-primary)' }}>
              Consultation Schedule
            </h2>
            {appointments.length === 0 ? (
              <div className="card" style={{ textAlign: 'center', padding: '2.5rem', color: 'var(--text-muted)' }}>
                <span style={{ fontSize: '2rem' }}>📋</span>
                <p style={{ marginTop: '0.75rem' }}>No appointments yet.</p>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                {appointments.map(app => {
                  const isSelected = viewingApp && viewingApp.id === app.id;
                  return (
                    <div
                      key={app.id}
                      onClick={() => setViewingApp(app)}
                      style={{
                        background: isSelected ? 'var(--accent-light)' : 'var(--bg-secondary)',
                        border: isSelected ? '2px solid var(--accent-primary)' : '1.5px solid var(--border-color)',
                        borderRadius: 'var(--border-radius-md)',
                        padding: '1rem 1.25rem',
                        cursor: 'pointer',
                        transition: 'var(--transition)',
                        boxShadow: isSelected ? 'var(--hover-shadow)' : 'var(--card-shadow)',
                        transform: isSelected ? 'translateX(4px)' : 'none'
                      }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '0.5rem' }}>
                        <div style={{ minWidth: 0 }}>
                          <h4 style={{ fontSize: '1rem', fontWeight: '700', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            Dr. {app.doctor_name.replace(/^dr\.?\s+/i, '')}
                          </h4>
                          <p style={{ fontSize: '0.8rem', color: 'var(--accent-primary)', fontWeight: '600', marginTop: '0.15rem' }}>
                            {app.specialization}
                          </p>
                        </div>
                        <span className={`status-badge ${app.status}`}>{app.status}</span>
                      </div>
                      <div style={{ display: 'flex', gap: '1rem', marginTop: '0.6rem', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                        <span>📅 {app.appointment_date}</span>
                        <span>⏰ {app.start_time} – {app.end_time}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Right: Detailed Summary Block */}
          <div style={{ alignSelf: 'start', minWidth: 0 }}>
            {viewingApp ? (
              <div
                className="card"
                style={{
                  position: 'sticky',
                  top: '90px',
                  maxHeight: 'calc(100vh - 130px)',
                  overflowY: 'auto',
                  alignSelf: 'start',
                  scrollbarWidth: 'thin'
                }}
              >
                <h2 className="card-title">Consultation File</h2>
                <div style={{ borderBottom: '1px solid var(--border-color)', paddingBottom: '0.75rem', marginBottom: '1rem' }}>
                  <p>Doctor: <strong>Dr. {viewingApp.doctor_name.replace(/^dr\.?\s+/i, '')}</strong> ({viewingApp.specialization})</p>
                  <p>Scheduled: <strong>{viewingApp.appointment_date}</strong> at <strong>{viewingApp.start_time} - {viewingApp.end_time}</strong></p>
                  <p style={{ marginTop: '0.5rem' }}>Symptoms reported: <em>"{viewingApp.symptoms}"</em></p>
                </div>

                {/* Pre-Visit AI Insights */}
                <div style={{ background: 'var(--bg-tertiary)', padding: '1rem', borderRadius: '8px', marginBottom: '1rem' }}>
                  <h4 style={{ fontWeight: '800', color: 'var(--accent-primary)', fontSize: '0.9rem' }}>🤖 Pre-Visit AI Symptom Review</h4>
                  <p style={{ fontSize: '0.85rem', fontWeight: '700', marginTop: '0.4rem' }}>
                    Urgency Rating: <span className={`urgency-indicator urgency-${viewingApp.urgency_level}`}>{viewingApp.urgency_level}</span>
                  </p>
                  <p style={{ fontSize: '0.85rem', marginTop: '0.4rem' }}>
                    <strong>Chief Complaint:</strong> {viewingApp.chief_complaint || 'Pending analysis'}
                  </p>
                </div>

                {/* Post-Visit clinical findings */}
                {viewingApp.status === 'completed' ? (
                  <div>
                    <h3 style={{ fontWeight: '800', color: 'var(--accent-primary)', marginBottom: '0.5rem', fontSize: '1.1rem' }}>✨ Post-Consultation Summary</h3>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', fontSize: '0.9rem' }}>
                      <div style={{ background: 'var(--accent-light)', padding: '0.75rem', borderRadius: '6px', border: '1px dashed var(--accent-primary)' }}>
                        <strong>Doctor Summary (Patient-Friendly):</strong>
                        <p style={{ whiteSpace: 'pre-line', marginTop: '0.25rem', color: 'var(--text-secondary)' }}>{viewingApp.patient_summary}</p>
                      </div>
                      <div>
                        <strong>Clinical Notes:</strong>
                        <p style={{ background: 'var(--bg-tertiary)', padding: '0.5rem', borderRadius: '4px', whiteSpace: 'pre-line', marginTop: '0.25rem', color: 'var(--text-secondary)' }}>{viewingApp.clinical_notes}</p>
                      </div>
                      <div>
                        <strong>Prescribed Medications:</strong>
                        <p style={{ background: 'var(--bg-tertiary)', padding: '0.5rem', borderRadius: '4px', whiteSpace: 'pre-line', marginTop: '0.25rem', color: 'var(--text-secondary)', fontFamily: 'monospace' }}>{viewingApp.prescription}</p>
                      </div>
                    </div>
                  </div>
                ) : viewingApp.status === 'cancelled' ? (
                  <div className="alert alert-error">
                    <strong>Appointment Cancelled</strong>
                    <p style={{ fontSize: '0.85rem', marginTop: '0.25rem' }}>This appointment has been cancelled. Dr. {viewingApp.doctor_name.replace(/^dr\.?\s+/i, '')} has declared leave on this date. Please schedule another slot.</p>
                  </div>
                ) : (
                  <div style={{ textAlign: 'center', padding: '1.5rem', background: 'var(--bg-tertiary)', borderRadius: '8px' }}>
                    <span style={{ fontSize: '1.5rem' }}>⏳</span>
                    <p style={{ fontSize: '0.9rem', color: 'var(--text-secondary)', marginTop: '0.5rem' }}>Consultation has not taken place yet. The post-visit summary and prescription log will appear here once Dr. {viewingApp.doctor_name.replace(/^dr\.?\s+/i, '')} completes the consultation.</p>
                  </div>
                )}
              </div>
            ) : (
              <div className="card" style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '3rem 1.5rem', position: 'sticky', top: '90px' }}>
                <span style={{ fontSize: '2.5rem' }}>📋</span>
                <h3 style={{ marginTop: '1rem', fontWeight: '700' }}>No Appointment Selected</h3>
                <p style={{ fontSize: '0.9rem', marginTop: '0.5rem' }}>Select a scheduled consultation from the list to review diagnostics, pre-visit summaries, prescriptions, and follow-up medical guidance.</p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* BOOK NEW APPOINTMENT VIEW */}
      {activeTab === 'book' && (
        <div className="grid-2">
          {/* Search and Select Doctor */}
          <div>
            <h2 style={{ fontSize: '1.5rem', fontWeight: '800', marginBottom: '1rem' }}>1. Find a Specialist</h2>
            <form onSubmit={handleSearch} style={{ display: 'flex', gap: '0.5rem', marginBottom: '1.5rem' }}>
              <input 
                type="text" 
                className="form-input" 
                placeholder="Search by specialization (e.g. Diagnostics, Cardiology)..."
                value={searchSpecialization}
                onChange={e => setSearchSpecialization(e.target.value)}
                style={{ flex: 1 }}
              />
              <button type="submit" className="btn btn-primary">Search</button>
            </form>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', maxHeight: '450px', overflowY: 'auto' }}>
              {doctors.length === 0 ? (
                <p style={{ color: 'var(--text-muted)' }}>No doctors found matching this specialization.</p>
              ) : (
                doctors.map(doc => {
                  const isSelected = selectedDoctor && selectedDoctor.id === doc.id;
                  return (
                    <div 
                      key={doc.id} 
                      className="card"
                      style={{ 
                        cursor: 'pointer',
                        border: isSelected ? '2px solid var(--accent-primary)' : '1px solid var(--border-color)',
                        background: isSelected ? 'var(--accent-light)' : 'var(--bg-secondary)'
                      }}
                      onClick={() => handleSelectDoctor(doc)}
                    >
                      <h4 style={{ fontWeight: '700', fontSize: '1.1rem' }}>Dr. {doc.full_name.replace(/^dr\.?\s+/i, '')}</h4>
                      <p style={{ fontSize: '0.9rem', color: 'var(--accent-primary)', fontWeight: '600' }}>{doc.specialization}</p>
                      <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginTop: '0.25rem' }}>Slot size: {doc.slot_duration} minutes</p>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.25rem', marginTop: '0.5rem' }}>
                        {Object.keys(doc.working_hours).map(day => (
                          <span key={day} style={{ fontSize: '0.7rem', padding: '0.1rem 0.3rem', background: 'var(--bg-tertiary)', borderRadius: '3px' }}>
                            {day.substring(0,3)}: {doc.working_hours[day].start}-{doc.working_hours[day].end}
                          </span>
                        ))}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>

          {/* Slots & Symptoms details */}
          <div>
            <h2 style={{ fontSize: '1.5rem', fontWeight: '800', marginBottom: '1rem' }}>2. Date & Symptoms Form</h2>
            {selectedDoctor ? (
              <form onSubmit={handleBookAppointment} className="card">
                <p style={{ fontSize: '0.9rem', marginBottom: '1rem' }}>
                  Booking with: <strong>Dr. {selectedDoctor.full_name.replace(/^dr\.?\s+/i, '')}</strong> ({selectedDoctor.specialization})
                </p>

                <div className="form-group">
                  <label>Select Date</label>
                  <input 
                    type="date" 
                    className="form-input" 
                    value={bookingDate}
                    min={new Date().toISOString().split('T')[0]}
                    onChange={handleDateChange}
                    required
                  />
                </div>

                <div className="form-group" style={{ marginTop: '1rem' }}>
                  <label>Select Available Time Slot</label>
                  {slotsLoading ? (
                    <p style={{ fontSize: '0.9rem', color: 'var(--text-muted)' }}>Calculating schedule availability...</p>
                  ) : bookingDate === '' ? (
                    <p style={{ fontSize: '0.9rem', color: 'var(--text-muted)' }}>Select a date to view available time slots.</p>
                  ) : availableSlots.length === 0 ? (
                    <p style={{ fontSize: '0.9rem', color: 'var(--status-high)', fontWeight: '600' }}>No available slots on this date. Doctor may be on leave or fully booked.</p>
                  ) : (
                    <div className="slots-grid">
                      {availableSlots.map(slot => (
                        <button
                          key={slot.start}
                          type="button"
                          className={`slot-option ${selectedSlotTime === slot.start ? 'selected' : ''}`}
                          onClick={() => handleSlotSelection(slot.start)}
                        >
                          {slot.start}
                        </button>
                      ))}
                    </div>
                  )}
                  {heldSlot && timeLeft > 0 && (
                    <div style={{
                      marginTop: '0.75rem',
                      padding: '0.6rem 1rem',
                      background: 'var(--accent-light)',
                      border: '1px solid var(--accent-primary)',
                      borderRadius: '6px',
                      fontSize: '0.85rem',
                      color: 'var(--accent-primary)',
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      fontWeight: '600'
                    }}>
                      <span>Slot Held: {heldSlot.time}</span>
                      <span>⏱️ Hold expires in: {Math.floor(timeLeft / 60)}:{(timeLeft % 60).toString().padStart(2, '0')}</span>
                    </div>
                  )}
                </div>

                <div className="form-group" style={{ marginTop: '1.25rem' }}>
                  <label>Describe Your Symptoms</label>
                  <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginBottom: '0.25rem' }}>
                    Providing detailed signs (e.g., chest tightness, fever duration) triggers an automatic pre-visit AI review.
                  </p>
                  <textarea 
                    className="form-input" 
                    rows="4" 
                    placeholder="Describe symptoms, start date, pain levels..."
                    value={symptoms}
                    onChange={e => setSymptoms(e.target.value)}
                    required
                    style={{ resize: 'vertical' }}
                  ></textarea>
                </div>

                <button 
                  type="submit" 
                  className="btn btn-primary" 
                  style={{ width: '100%', marginTop: '1.25rem' }} 
                  disabled={loading || !selectedSlotTime}
                >
                  {loading ? 'Analyzing symptoms & booking...' : 'Confirm Appointment Booking'}
                </button>
              </form>
            ) : (
              <div className="card" style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '4rem 1.5rem' }}>
                <span style={{ fontSize: '2.5rem' }}>📅</span>
                <p style={{ fontSize: '0.95rem', marginTop: '1rem' }}>Select a doctor from the list on the left to start setting up your consultation slots.</p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* MEDICATION REMINDERS VIEW */}
      {activeTab === 'reminders' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          <h2 style={{ fontSize: '1.5rem', fontWeight: '800', marginBottom: '0.25rem' }}>Prescribed Active Medications</h2>
          {reminders.length === 0 ? (
            <p style={{ color: 'var(--text-muted)', textAlign: 'center', padding: '3rem 1rem' }}>No active medication schedules are currently registered.</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              {reminders.map(rem => {
                const todayStr = new Date().toISOString().split('T')[0];
                const isActive = todayStr >= rem.start_date && todayStr <= rem.end_date;
                const isUpcoming = todayStr < rem.start_date;

                let badgeText = 'EXPIRED';
                let badgeBg = 'var(--bg-tertiary)';
                let badgeColor = 'var(--text-muted)';
                let borderLeftColor = 'var(--border-color)';

                if (isActive) {
                  badgeText = 'ACTIVE';
                  badgeBg = 'var(--status-low-bg)';
                  badgeColor = 'var(--status-low)';
                  borderLeftColor = 'var(--accent-primary)';
                } else if (isUpcoming) {
                  badgeText = 'UPCOMING';
                  badgeBg = 'var(--status-medium-bg)';
                  badgeColor = 'var(--status-medium)';
                  borderLeftColor = 'var(--status-medium)';
                }

                return (
                  <div 
                    key={rem.id} 
                    className="reminder-item" 
                    style={{ 
                      background: 'var(--bg-secondary)', 
                      border: '1px solid var(--border-color)', 
                      borderLeft: `5px solid ${borderLeftColor}`, 
                      padding: '1.25rem', 
                      borderRadius: '8px', 
                      display: 'flex', 
                      justifyContent: 'space-between', 
                      alignItems: 'flex-start' 
                    }}
                  >
                    <div>
                      <h3 style={{ fontWeight: '800', fontSize: '1.2rem', color: 'var(--text-primary)' }}>{rem.medication_name}</h3>
                      <p style={{ fontSize: '0.95rem', color: 'var(--text-secondary)', marginTop: '0.4rem' }}>
                        <strong>{formatReminderText(rem.medication_name, rem.dosage, rem.frequency)}</strong>
                      </p>
                      <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '0.4rem' }}>
                        📅 Validity: {rem.start_date} to {rem.end_date}
                      </p>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '0.5rem', textAlign: 'right' }}>
                      <span style={{ 
                        fontSize: '0.75rem', 
                        background: badgeBg, 
                        color: badgeColor, 
                        padding: '0.25rem 0.6rem', 
                        borderRadius: '4px', 
                        fontWeight: '700',
                        textTransform: 'uppercase',
                        letterSpacing: '0.5px'
                      }}>
                        {badgeText}
                      </span>
                      {rem.last_reminded_at && (
                        <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                          <span>⏱️ Last sent:</span>
                          <strong>{new Date(rem.last_reminded_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</strong>
                        </p>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
