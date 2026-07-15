import { useState, useEffect } from 'react';

export default function AdminPortal({ token }) {
  const [doctors, setDoctors] = useState([]);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fullName, setFullName] = useState('');
  const [specialization, setSpecialization] = useState('');
  const [slotDuration, setSlotDuration] = useState('30');
  
  // Shift hours defaults
  const [workingHours, setWorkingHours] = useState({
    Monday: { active: true, start: '09:00', end: '17:00' },
    Tuesday: { active: true, start: '09:00', end: '17:00' },
    Wednesday: { active: true, start: '09:00', end: '17:00' },
    Thursday: { active: true, start: '09:00', end: '17:00' },
    Friday: { active: true, start: '09:00', end: '17:00' }
  });

  const [leaveDoctorId, setLeaveDoctorId] = useState('');
  const [leaveDate, setLeaveDate] = useState('');
  const [alert, setAlert] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetchDoctors();
  }, []);

  const fetchDoctors = async () => {
    try {
      const res = await fetch('http://localhost:5000/api/admin/doctors', {
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await res.json();
      if (res.ok) {
        setDoctors(data);
      } else {
        setAlert({ type: 'error', message: data.error });
      }
    } catch (err) {
      setAlert({ type: 'error', message: 'Failed to connect to backend server.' });
    }
  };

  const handleRegisterDoctor = async (e) => {
    e.preventDefault();
    setLoading(true);
    setAlert(null);

    const hasUpper = /[A-Z]/.test(password);
    const hasLower = /[a-z]/.test(password);
    const hasNumber = /[0-9]/.test(password);
    const hasSpecial = /[^A-Za-z0-9]/.test(password);

    if (password.length < 6 || !hasUpper || !hasLower || !hasNumber || !hasSpecial) {
      setAlert({ type: 'error', message: 'Password must be at least 6 characters and contain uppercase, lowercase, numbers, and special characters.' });
      setLoading(false);
      return;
    }

    // Format active working hours
    const finalWorkingHours = {};
    Object.keys(workingHours).forEach(day => {
      if (workingHours[day].active) {
        finalWorkingHours[day] = {
          start: workingHours[day].start,
          end: workingHours[day].end
        };
      }
    });

    try {
      const res = await fetch('http://localhost:5000/api/admin/doctors', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({
          email,
          password,
          fullName,
          specialization,
          workingHours: finalWorkingHours,
          slotDuration: parseInt(slotDuration)
        })
      });

      const data = await res.json();
      if (res.ok) {
        setAlert({ type: 'success', message: 'Doctor registered successfully!' });
        setEmail('');
        setPassword('');
        setFullName('');
        setSpecialization('');
        fetchDoctors();
      } else {
        setAlert({ type: 'error', message: data.error || 'Failed to register doctor.' });
      }
    } catch (err) {
      setAlert({ type: 'error', message: 'Connection error while registering doctor.' });
    } finally {
      setLoading(false);
    }
  };

  const handleDeclareLeave = async (e) => {
    e.preventDefault();
    if (!leaveDoctorId || !leaveDate) {
      setAlert({ type: 'error', message: 'Please select a doctor and date.' });
      return;
    }
    
    setLoading(true);
    setAlert(null);

    try {
      const res = await fetch(`http://localhost:5000/api/admin/doctors/${leaveDoctorId}/leave`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ date: leaveDate })
      });

      const data = await res.json();
      if (res.ok) {
        setAlert({ 
          type: 'success', 
          message: data.message 
        });
        setLeaveDate('');
        fetchDoctors();
      } else {
        setAlert({ type: 'error', message: data.error || 'Failed to schedule doctor leave.' });
      }
    } catch (err) {
      setAlert({ type: 'error', message: 'Connection error while declaring leave.' });
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteDoctor = async (docId) => {
    if (!window.confirm('Are you sure you want to delete this doctor? All active appointments will be cancelled, patient invitations deleted, and the doctor account removed.')) {
      return;
    }

    setLoading(true);
    setAlert(null);

    try {
      const res = await fetch(`http://localhost:5000/api/admin/doctors/${docId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      });

      const data = await res.json();
      if (res.ok) {
        setAlert({ type: 'success', message: data.message });
        if (leaveDoctorId === docId) {
          setLeaveDoctorId('');
        }
        fetchDoctors();
      } else {
        setAlert({ type: 'error', message: data.error || 'Failed to delete doctor.' });
      }
    } catch (err) {
      setAlert({ type: 'error', message: 'Connection error while deleting doctor.' });
    } finally {
      setLoading(false);
    }
  };

  const updateShiftDay = (day, field, value) => {
    setWorkingHours(prev => ({
      ...prev,
      [day]: {
        ...prev[day],
        [field]: value
      }
    }));
  };

  return (
    <div className="dashboard-container">
      <div className="dashboard-header">
        <div>
          <h1>Administrator Dashboard</h1>
          <p>Register medical personnel, customize consultation slot sizes, and schedule leave calendars.</p>
        </div>
      </div>

      {alert && (
        <div className={`alert alert-${alert.type}`}>
          <div>{alert.message}</div>
        </div>
      )}

      <div className="grid-2">
        {/* Register Doctor Section */}
        <div className="card">
          <h2 className="card-title">Register New Doctor Account</h2>
          <form onSubmit={handleRegisterDoctor} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <div className="form-group">
              <label>Full Name</label>
              <input 
                type="text" 
                className="form-input" 
                placeholder="Dr. Gregory House"
                value={fullName}
                onChange={e => setFullName(e.target.value)}
                required
              />
            </div>

            <div className="form-group">
              <label>Email Address</label>
              <input 
                type="email" 
                className="form-input" 
                placeholder="house@clinic.com"
                value={email}
                onChange={e => setEmail(e.target.value)}
                required
              />
            </div>

            <div className="form-group">
              <label>Password</label>
              <input 
                type="password" 
                className="form-input" 
                placeholder="••••••••"
                value={password}
                onChange={e => setPassword(e.target.value)}
                required
              />
              <div style={{ marginTop: '0.4rem', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                {!password ? (
                  <span>Must enter a password of at least 6 characters with uppercase, lowercase, numbers, and special characters.</span>
                ) : (
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.25rem', marginTop: '0.25rem' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', color: password.length >= 6 ? '#10b981' : '#f43f5e', fontWeight: '500' }}>
                      <span>{password.length >= 6 ? '✓' : '✗'}</span> At least 6 chars
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', color: /[A-Z]/.test(password) ? '#10b981' : '#f43f5e', fontWeight: '500' }}>
                      <span>{/[A-Z]/.test(password) ? '✓' : '✗'}</span> Uppercase letter
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', color: /[a-z]/.test(password) ? '#10b981' : '#f43f5e', fontWeight: '500' }}>
                      <span>{/[a-z]/.test(password) ? '✓' : '✗'}</span> Lowercase letter
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', color: /[0-9]/.test(password) ? '#10b981' : '#f43f5e', fontWeight: '500' }}>
                      <span>{/[0-9]/.test(password) ? '✓' : '✗'}</span> Number (0-9)
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', color: /[^A-Za-z0-9]/.test(password) ? '#10b981' : '#f43f5e', fontWeight: '500', gridColumn: 'span 2' }}>
                      <span>{/[^A-Za-z0-9]/.test(password) ? '✓' : '✗'}</span> Special character (e.g. !, @, #, etc.)
                    </div>
                  </div>
                )}
              </div>
            </div>

            <div className="form-group">
              <label>Specialization</label>
              <input 
                type="text" 
                className="form-input" 
                placeholder="Diagnostics & Internal Medicine"
                value={specialization}
                onChange={e => setSpecialization(e.target.value)}
                required
              />
            </div>

            <div className="form-group">
              <label>Default Slot Duration (Minutes)</label>
              <select 
                className="form-select"
                value={slotDuration}
                onChange={e => setSlotDuration(e.target.value)}
              >
                <option value="15">15 Minutes</option>
                <option value="20">20 Minutes</option>
                <option value="30">30 Minutes</option>
                <option value="45">45 Minutes</option>
                <option value="60">60 Minutes</option>
              </select>
            </div>

            <div style={{ marginTop: '0.5rem' }}>
              <label style={{ fontSize: '0.9rem', fontWeight: '700', color: 'var(--text-secondary)' }}>Shift Schedule Settings</label>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginTop: '0.5rem' }}>
                {Object.keys(workingHours).map(day => (
                  <div key={day} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.5rem', background: 'var(--bg-tertiary)', borderRadius: '4px' }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer', fontSize: '0.85rem' }}>
                      <input 
                        type="checkbox" 
                        checked={workingHours[day].active} 
                        onChange={e => updateShiftDay(day, 'active', e.target.checked)}
                      />
                      {day}
                    </label>
                    {workingHours[day].active && (
                      <div style={{ display: 'flex', gap: '0.25rem', alignItems: 'center' }}>
                        <input 
                          type="text" 
                          placeholder="09:00" 
                          value={workingHours[day].start} 
                          onChange={e => updateShiftDay(day, 'start', e.target.value)}
                          style={{ width: '60px', padding: '0.2rem 0.4rem', textAlign: 'center', fontSize: '0.8rem', border: '1px solid var(--border-color)', borderRadius: '4px', background: 'var(--bg-secondary)', color: 'var(--text-primary)' }}
                        />
                        <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>to</span>
                        <input 
                          type="text" 
                          placeholder="17:00" 
                          value={workingHours[day].end} 
                          onChange={e => updateShiftDay(day, 'end', e.target.value)}
                          style={{ width: '60px', padding: '0.2rem 0.4rem', textAlign: 'center', fontSize: '0.8rem', border: '1px solid var(--border-color)', borderRadius: '4px', background: 'var(--bg-secondary)', color: 'var(--text-primary)' }}
                        />
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>

            <button type="submit" className="btn btn-primary" disabled={loading} style={{ marginTop: '0.5rem' }}>
              {loading ? 'Processing...' : 'Register Doctor Profile'}
            </button>
          </form>
        </div>

        {/* Manage Calendars & Leaves Section */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
          <div className="card">
            <h2 className="card-title">Schedule Doctor Leave Override</h2>
            <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '1rem' }}>
              Declaring leave will automatically cancel active bookings on that date, notify patients by email, and delete Google Calendar reservations.
            </p>
            <form onSubmit={handleDeclareLeave} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <div className="form-group">
                <label>Select Doctor</label>
                <select 
                  className="form-select"
                  value={leaveDoctorId}
                  onChange={e => setLeaveDoctorId(e.target.value)}
                  required
                >
                  <option value="">-- Choose Doctor --</option>
                  {doctors.map(doc => (
                    <option key={doc.id} value={doc.id}>Dr. {doc.full_name} ({doc.specialization})</option>
                  ))}
                </select>
              </div>

              <div className="form-group">
                <label>Select Date</label>
                <input 
                  type="date" 
                  className="form-input" 
                  value={leaveDate}
                  min={new Date().toISOString().split('T')[0]}
                  onChange={e => setLeaveDate(e.target.value)}
                  required
                />
              </div>

              <button type="submit" className="btn btn-danger" disabled={loading}>
                {loading ? 'Processing...' : 'Declare Calendar Leave & Cancel Bookings'}
              </button>
            </form>
          </div>

          <div className="card">
            <h2 className="card-title">Registered Doctor Profiles</h2>
            <div style={{ maxHeight: '300px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              {doctors.length === 0 ? (
                <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>No doctors registered yet.</p>
              ) : (
                doctors.map(doc => (
                  <div key={doc.id} style={{ padding: '0.75rem', border: '1px solid var(--border-color)', borderRadius: '6px' }}>
                    <h4 style={{ fontWeight: '700' }}>Dr. {doc.full_name}</h4>
                    <p style={{ fontSize: '0.85rem', color: 'var(--accent-primary)', fontWeight: '600' }}>{doc.specialization}</p>
                    <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginTop: '0.25rem' }}>
                      Slot duration: <strong>{doc.slot_duration} min</strong>
                    </p>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.25rem', marginTop: '0.4rem' }}>
                      {Object.keys(doc.working_hours).map(day => (
                        <span key={day} style={{ fontSize: '0.7rem', padding: '0.1rem 0.3rem', background: 'var(--bg-tertiary)', borderRadius: '3px' }}>
                          {day.substring(0, 3)}: {doc.working_hours[day].start}-{doc.working_hours[day].end}
                        </span>
                      ))}
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginTop: '0.5rem' }}>
                      {doc.leave_days && doc.leave_days.length > 0 ? (
                        <p style={{ fontSize: '0.8rem', color: 'var(--status-high)' }}>
                          Leave dates: <strong>{doc.leave_days.join(', ')}</strong>
                        </p>
                      ) : (
                        <div />
                      )}
                      <button 
                        onClick={() => handleDeleteDoctor(doc.id)} 
                        className="btn-remove"
                        disabled={loading}
                      >
                        Remove Doctor
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
