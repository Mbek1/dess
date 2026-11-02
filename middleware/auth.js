// Authentication middleware to extract user info from JWT token
const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || 'supersecretkey';

function authenticateToken(req, res, next) {
  // Get token from Authorization header
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

  if (!token) {
    // Try cookie-based access token
    const cookieToken = req.cookies?.accessToken;
    if (!cookieToken) {
      req.user = null;
      return next();
    }
    try {
      const decoded = jwt.verify(cookieToken, JWT_SECRET);
      req.user = decoded;
      return next();
    } catch (err) {
      console.error('Cookie token verification failed:', err);
      req.user = null;
      return next();
    }
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded; // { id, role }
    next();
  } catch (err) {
    console.error('Token verification failed:', err);
    req.user = null;
    next();
  }
}

module.exports = { authenticateToken };
