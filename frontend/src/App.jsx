import { useState, useEffect } from 'react';
import AdminPortal from './portals/AdminPortal';
import DoctorPortal from './portals/DoctorPortal';
import PatientPortal from './portals/PatientPortal';

const EyeOpenIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth="1.5" stroke="currentColor" style={{ width: '1.25rem', height: '1.25rem' }}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z" />
    <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
  </svg>
);

const EyeClosedIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth="1.5" stroke="currentColor" style={{ width: '1.25rem', height: '1.25rem' }}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M3.98 8.223A10.477 10.477 0 001.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.451 10.451 0 0112 4.5c4.756 0 8.773 3.162 10.065 7.498a10.522 10.522 0 01-4.293 5.774M6.228 6.228L3 3m3.228 3.228l3.65 3.65m7.894 7.894L21 21m-3.228-3.228l-3.65-3.65m0 0a3 3 0 10-4.243-4.243m4.242 4.242L9.88 9.88" />
  </svg>
);

export default function App() {
  const [token, setToken] = useState(''); // Start on login page every time
  const [user, setUser] = useState(null);
  const [selectedRole, setSelectedRole] = useState(null); // 'patient', 'doctor', 'admin', or null
  
  // Auth view toggles
  const [isRegistering, setIsRegistering] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fullName, setFullName] = useState('');
  const [showLoginPassword, setShowLoginPassword] = useState(false);
  const [showRegisterPassword, setShowRegisterPassword] = useState(false);

  useEffect(() => {
    setShowLoginPassword(false);
    setShowRegisterPassword(false);
  }, [isRegistering, selectedRole]);
  
  // Theme state
  const [darkTheme, setDarkTheme] = useState(localStorage.getItem('theme') === 'dark');

  const [authError, setAuthError] = useState('');
  const [authSuccess, setAuthSuccess] = useState('');
  const [loading, setLoading] = useState(false);

  // Sync token to API validation
  useEffect(() => {
    if (token) {
      localStorage.setItem('token', token);
      // We parse token payload locally to get user profile details
      try {
        const base64Url = token.split('.')[1];
        const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
        const pad = base64.length % 4;
        const padded = pad ? base64 + '='.repeat(4 - pad) : base64;
        const jsonPayload = decodeURIComponent(atob(padded).split('').map(c => {
          return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
        }).join(''));
        const payload = JSON.parse(jsonPayload);
        setUser({
          id: payload.id,
          email: payload.email,
          role: payload.role,
          fullName: payload.fullName
        });
      } catch (e) {
        handleLogout();
      }
    } else {
      localStorage.removeItem('token');
      setUser(null);
    }
  }, [token]);

  // Sync theme changes
  useEffect(() => {
    if (darkTheme) {
      document.documentElement.classList.add('dark-theme');
      localStorage.setItem('theme', 'dark');
    } else {
      document.documentElement.classList.remove('dark-theme');
      localStorage.setItem('theme', 'light');
    }
  }, [darkTheme]);

  const handleLogout = () => {
    setToken('');
    setUser(null);
    setSelectedRole(null);
    setShowLoginPassword(false);
    setShowRegisterPassword(false);
  };

  const handleLogin = async (e) => {
    e.preventDefault();
    setLoading(true);
    setAuthError('');
    setAuthSuccess('');

    try {
      const res = await fetch('http://localhost:5000/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      });

      const data = await res.json();
      if (res.ok) {
        setToken(data.token);
        setEmail('');
        setPassword('');
      } else {
        setAuthError(data.error || 'Login failed. Please check credentials.');
      }
    } catch (err) {
      setAuthError('Unable to reach backend API. Make sure the server is running.');
    } finally {
      setLoading(false);
    }
  };

  const handleRegister = async (e) => {
    e.preventDefault();
    setLoading(true);
    setAuthError('');
    setAuthSuccess('');

    const hasUpper = /[A-Z]/.test(password);
    const hasLower = /[a-z]/.test(password);
    const hasNumber = /[0-9]/.test(password);
    const hasSpecial = /[^A-Za-z0-9]/.test(password);

    if (password.length < 6 || !hasUpper || !hasLower || !hasNumber || !hasSpecial) {
      setAuthError('Password must be at least 6 characters and contain uppercase, lowercase, numbers, and special characters.');
      setLoading(false);
      return;
    }

    try {
      const res = await fetch('http://localhost:5000/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, fullName })
      });

      const data = await res.json();
      if (res.ok) {
        setAuthSuccess(data.message || 'Registration successful! Please log in.');
        setIsRegistering(false);
        setPassword('');
      } else {
        setAuthError(data.error || 'Registration failed.');
      }
    } catch (err) {
      setAuthError('Connection error during registration.');
    } finally {
      setLoading(false);
    }
  };

  const toggleTheme = () => {
    setDarkTheme(!darkTheme);
  };

  // Seeded credential quick log-ins
  const handleQuickLogin = (emailStr, passwordStr) => {
    setEmail(emailStr);
    setPassword(passwordStr);
  };

  return (
    <div className="app-container">
      {/* Navigation Header */}
      <header className="navbar">
        <div className="nav-brand">
          <span className="nav-brand-icon">🏥</span> ClinicPulse
        </div>
        
        <div className="nav-links">
          {/* Light/Dark Toggle */}
          <button onClick={toggleTheme} className="btn-icon" title="Toggle Theme" aria-label="Toggle Theme">
            {darkTheme ? '☀️' : '🌙'}
          </button>
          
          {user && (
            <>
              <div className="nav-user-info">
                <span>{user.fullName}</span>
                <span className={`nav-role-badge badge-${user.role}`}>{user.role}</span>
              </div>
              <button onClick={handleLogout} className="btn btn-secondary">
                Logout
              </button>
            </>
          )}
        </div>
      </header>

      {/* Main Content Area */}
      <main style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
        {user ? (
          /* Render portal based on user role */
          user.role === 'admin' ? (
            <AdminPortal token={token} />
          ) : user.role === 'doctor' ? (
            <DoctorPortal token={token} user={user} />
          ) : (
            <PatientPortal token={token} user={user} />
          )
        ) : !selectedRole ? (
          /* Portal Role Selection Screen */
          <div className="portal-selection-container">
            <div className="portal-selection-header">
              <h1>🏥 ClinicPulse Portal Access</h1>
              <p>Please select your access portal to proceed with authentication</p>
            </div>
            <div className="portal-grid">
              {/* Box 1: Patient Portal */}
              <div className="portal-box" onClick={() => { setSelectedRole('patient'); setIsRegistering(false); setAuthError(''); setAuthSuccess(''); }}>
                <div className="portal-box-icon">👤</div>
                <div className="portal-box-title">Patient Portal</div>
                <div className="portal-box-desc">
                  Book specialist appointments, track clinical files, view prescriptions, and manage recurring medication reminders.
                </div>
                <button className="portal-box-btn">Access Patient Portal</button>
              </div>

              {/* Box 2: Doctor Portal */}
              <div className="portal-box" onClick={() => { setSelectedRole('doctor'); setIsRegistering(false); setAuthError(''); setAuthSuccess(''); }}>
                <div className="portal-box-icon">🩺</div>
                <div className="portal-box-title">Doctor Portal</div>
                <div className="portal-box-desc">
                  Access scheduled patient bookings, review reported symptoms pre-visit, write prescriptions, and link Google Calendar.
                </div>
                <button className="portal-box-btn">Access Doctor Portal</button>
              </div>

              {/* Box 3: Administrator Portal */}
              <div className="portal-box" onClick={() => { setSelectedRole('admin'); setIsRegistering(false); setAuthError(''); setAuthSuccess(''); }}>
                <div className="portal-box-icon">⚙️</div>
                <div className="portal-box-title">Admin Portal</div>
                <div className="portal-box-desc">
                  Register clinic medical personnel, declare leave override calendars, cancel conflict bookings, and update slot duration.
                </div>
                <button className="portal-box-btn">Access Admin Portal</button>
              </div>
            </div>
          </div>
        ) : (
          /* Auth Portal Container for Selected Role */
          <div className="auth-wrapper" style={{ animation: 'floatIn 0.3s ease-out', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
            <button className="btn btn-back" onClick={() => { setSelectedRole(null); setAuthError(''); setAuthSuccess(''); }}>
              ← Back to Portal Selection
            </button>
            
            <div className="auth-card">
              <div className="auth-header">
                <h2>
                  {isRegistering 
                    ? 'Patient Registration' 
                    : selectedRole === 'patient' 
                      ? 'Patient Account Login' 
                      : selectedRole === 'doctor' 
                        ? 'Doctor Account Login' 
                        : 'Administrator Login'}
                </h2>
                <p>
                  {isRegistering 
                    ? 'Register to consult specialists and view clinic files' 
                    : selectedRole === 'patient' 
                      ? 'Access your appointments, prescriptions, and health summaries' 
                      : selectedRole === 'doctor' 
                        ? 'Manage your consultations, schedules, and clinical notes' 
                        : 'Manage clinic configurations, doctors, and calendars'}
                </p>
              </div>

              {authError && <div className="alert alert-error"><div>{authError}</div></div>}
              {authSuccess && <div className="alert alert-success"><div>{authSuccess}</div></div>}

              {isRegistering && selectedRole === 'patient' ? (
                <form onSubmit={handleRegister} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                  <div className="form-group">
                    <label>Full Name</label>
                    <input 
                      type="text" 
                      className="form-input" 
                      placeholder="John Doe"
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
                      placeholder="john@example.com"
                      value={email}
                      onChange={e => setEmail(e.target.value)}
                      required 
                    />
                  </div>
                  <div className="form-group">
                    <label>Password</label>
                    <div className="password-input-container">
                      <input 
                        type={showRegisterPassword ? 'text' : 'password'} 
                        className="form-input" 
                        placeholder="Min 6 characters"
                        value={password}
                        onChange={e => setPassword(e.target.value)}
                        required 
                      />
                      <button
                        type="button"
                        className="password-toggle-btn"
                        onClick={() => setShowRegisterPassword(!showRegisterPassword)}
                        aria-label={showRegisterPassword ? "Hide password" : "Show password"}
                      >
                        {showRegisterPassword ? <EyeClosedIcon /> : <EyeOpenIcon />}
                      </button>
                    </div>
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
                  <button type="submit" className="btn btn-primary" disabled={loading}>
                    {loading ? 'Registering...' : 'Register Account'}
                  </button>
                  <button type="button" className="btn btn-text" onClick={() => { setIsRegistering(false); setAuthError(''); }}>
                    Already have an account? Sign In
                  </button>
                </form>
              ) : (
                <form onSubmit={handleLogin} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                  <div className="form-group">
                    <label>Email Address</label>
                    <input 
                      type="email" 
                      className="form-input" 
                      placeholder={selectedRole === 'patient' ? 'patient@clinic.com' : selectedRole === 'doctor' ? 'doctor@clinic.com' : 'admin@clinic.com'}
                      value={email}
                      onChange={e => setEmail(e.target.value)}
                      required 
                    />
                  </div>
                  <div className="form-group">
                    <label>Password</label>
                    <div className="password-input-container">
                      <input 
                        type={showLoginPassword ? 'text' : 'password'} 
                        className="form-input" 
                        placeholder="Enter password"
                        value={password}
                        onChange={e => setPassword(e.target.value)}
                        required 
                      />
                      <button
                        type="button"
                        className="password-toggle-btn"
                        onClick={() => setShowLoginPassword(!showLoginPassword)}
                        aria-label={showLoginPassword ? "Hide password" : "Show password"}
                      >
                        {showLoginPassword ? <EyeClosedIcon /> : <EyeOpenIcon />}
                      </button>
                    </div>
                  </div>
                  <button type="submit" className="btn btn-primary" disabled={loading}>
                    {loading ? 'Signing In...' : 'Sign In'}
                  </button>
                  
                  {selectedRole === 'patient' && (
                    <button type="button" className="btn btn-text" onClick={() => { setIsRegistering(true); setAuthError(''); }}>
                      Need an account? Register Now
                    </button>
                  )}

                  {/* Seeded logins quick fill helpful utility tailored for selected role */}
                  <div style={{ marginTop: '1rem', borderTop: '1px solid var(--border-color)', paddingTop: '1rem' }}>
                    <p style={{ fontSize: '0.8rem', fontWeight: 'bold', color: 'var(--text-secondary)', marginBottom: '0.5rem' }}>Demo Seeded Accounts (Quick Access):</p>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                      {selectedRole === 'patient' && (
                        <>
                          <button 
                            type="button" 
                            className="btn btn-secondary" 
                            style={{ fontSize: '0.8rem', padding: '0.35rem' }} 
                            onClick={() => handleQuickLogin('patient@clinic.com', 'patient123')}
                          >
                            Seeded Patient (patient@clinic.com)
                          </button>

                        </>
                      )}
                      {selectedRole === 'doctor' && (
                        <>
                          <button 
                            type="button" 
                            className="btn btn-secondary" 
                            style={{ fontSize: '0.8rem', padding: '0.35rem' }} 
                            onClick={() => handleQuickLogin('doctor@clinic.com', 'doctor123')}
                          >
                            Seeded Doctor (doctor@clinic.com)
                          </button>
                          <button 
                            type="button" 
                            className="btn btn-secondary" 
                            style={{ fontSize: '0.8rem', padding: '0.35rem' }} 
                            onClick={() => handleQuickLogin('rohanverma@healthcare.com', 'rohan123')}
                          >
                            Dr. Rohan Verma (rohanverma@healthcare.com)
                          </button>
                        </>
                      )}
                      {selectedRole === 'admin' && (
                        <button 
                          type="button" 
                          className="btn btn-secondary" 
                          style={{ fontSize: '0.8rem', padding: '0.35rem' }} 
                          onClick={() => handleQuickLogin('admin@clinic.com', 'admin123')}
                        >
                          Admin Quick Login (admin@clinic.com)
                        </button>
                      )}
                    </div>
                  </div>
                </form>
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
