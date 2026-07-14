const jwt = require('jsonwebtoken');
require('dotenv').config();

const JWT_SECRET = process.env.JWT_SECRET || 'healthcare_jwt_secret_token_123!';

/**
 * Middleware to authenticate JWT token.
 */
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[2]; // Expects "Bearer token <JWT>" or standard "Bearer <JWT>"
  // Wait, let's check standard "Bearer <JWT>" first
  let jwtToken = token;
  if (!jwtToken && authHeader) {
    const parts = authHeader.split(' ');
    if (parts.length === 2 && parts[0].toLowerCase() === 'bearer') {
      jwtToken = parts[1];
    }
  }

  if (!jwtToken) {
    return res.status(401).json({ error: 'Access denied. Authorization token is missing.' });
  }

  try {
    const decoded = jwt.verify(jwtToken, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(403).json({ error: 'Session expired or invalid authorization token.' });
  }
}

/**
 * Role checking helper.
 */
function requireRole(roles = []) {
  if (typeof roles === 'string') {
    roles = [roles];
  }

  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Access forbidden. Insufficient permissions for this action.' });
    }
    next();
  };
}

module.exports = {
  authenticateToken,
  requireRole,
  JWT_SECRET
};
