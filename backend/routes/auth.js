const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db');
const { JWT_SECRET } = require('../authMiddleware');
const calendarService = require('../calendarService');

/**
 * @route POST /api/auth/register
 * @desc Registers a new patient. Doctors and admins are registered by admin.
 */
router.post('/register', async (req, res) => {
  const { email, password, fullName } = req.body;

  if (!email || !password || !fullName) {
    return res.status(400).json({ error: 'Please supply email, password, and full name.' });
  }

  try {
    // Check if user already exists
    const existingUser = await db.get('SELECT id FROM users WHERE email = ?', [email.trim().toLowerCase()]);
    if (existingUser) {
      return res.status(400).json({ error: 'An account with this email already exists.' });
    }

    const userId = Math.random().toString(36).substring(2, 15);
    const passwordHash = await bcrypt.hash(password, 10);

    await db.run(
      'INSERT INTO users (id, email, password_hash, role, full_name) VALUES (?, ?, ?, ?, ?)',
      [userId, email.trim().toLowerCase(), passwordHash, 'patient', fullName]
    );

    res.status(201).json({ message: 'Registration successful! You may now log in.' });
  } catch (err) {
    console.error('Registration error:', err.message);
    res.status(500).json({ error: 'Internal server error during registration.' });
  }
});

/**
 * @route POST /api/auth/login
 * @desc Logs in any user and issues JWT.
 */
router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Please supply email and password.' });
  }

  try {
    const user = await db.get('SELECT * FROM users WHERE email = ?', [email.trim().toLowerCase()]);
    if (!user) {
      return res.status(400).json({ error: 'Invalid email or password.' });
    }

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      return res.status(400).json({ error: 'Invalid email or password.' });
    }

    // Generate JWT token
    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role, fullName: user.full_name },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.json({
      message: 'Login successful!',
      token,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        fullName: user.full_name
      }
    });
  } catch (err) {
    console.error('Login error:', err.message);
    res.status(500).json({ error: 'Internal server error during login.' });
  }
});

/**
 * @route GET /api/auth/google/url
 * @desc Gets Google OAuth authentication URL for calendar syncing.
 */
router.get('/google/url', (req, res) => {
  const userId = req.query.userId;
  if (!userId) {
    return res.status(400).json({ error: 'userId query parameter is required.' });
  }

  const authUrl = calendarService.getAuthUrl(userId);
  if (!authUrl) {
    return res.json({ url: null, message: 'Google OAuth credentials are not configured on the server. Falling back to local logging.' });
  }

  res.json({ url: authUrl });
});

/**
 * @route GET /api/auth/google/callback
 * @desc Process OAuth redirect callback.
 */
router.get('/google/callback', async (req, res) => {
  const { code, state: userId } = req.query;

  if (!code || !userId) {
    return res.status(400).send('<h3>Invalid callback request. Missing code or state.</h3>');
  }

  try {
    await calendarService.saveUserTokens(userId, code);
    res.send(`
      <div style="font-family: sans-serif; text-align: center; margin-top: 100px;">
        <h2 style="color: #2e7d32;">Google Calendar Linked Successfully!</h2>
        <p>You can close this window now. Your appointments will now sync with Google Calendar.</p>
        <button onclick="window.close()" style="padding: 10px 20px; font-weight: bold; background: #1976d2; color: white; border: none; border-radius: 4px; cursor: pointer;">Close Window</button>
      </div>
    `);
  } catch (err) {
    console.error('OAuth Callback Error:', err.message);
    res.status(500).send(`<h3>Failed to authorize Google account: ${err.message}</h3>`);
  }
});

/**
 * @route GET /api/auth/google/status
 * @desc Checks if a user has linked their Google account.
 */
router.get('/google/status', async (req, res) => {
  const userId = req.query.userId;
  if (!userId) {
    return res.status(400).json({ error: 'userId query parameter is required.' });
  }

  try {
    const tokenRecord = await db.get('SELECT user_id FROM google_tokens WHERE user_id = ?', [userId]);
    res.json({ linked: !!tokenRecord });
  } catch (err) {
    console.error('Google status error:', err.message);
    res.status(500).json({ error: 'Internal server error checking status.' });
  }
});

module.exports = router;
