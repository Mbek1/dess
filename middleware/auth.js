// JWT authentication middleware with server-side session validation.
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const UserSession = require('../models/UserSession');

const JWT_SECRET = process.env.JWT_SECRET || 'supersecretkey';
const IDLE_TIMEOUT_MS = Number(process.env.SESSION_IDLE_TIMEOUT_MINUTES || 30) * 60 * 1000;

async function authenticateToken(req, res, next) {
  const authHeader = req.headers.authorization;
  const headerToken = authHeader && authHeader.startsWith('Bearer ')
    ? authHeader.slice(7)
    : null;
  const token = headerToken || req.cookies?.accessToken;

  if (!token) {
    req.user = null;
    return next();
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (!decoded.id) {
      return res.status(401).json({ error: 'Invalid authentication token.' });
    }

    const user = await User.findById(decoded.id).select('role active');
    if (!user || user.active === false || user.role !== decoded.role) {
      return res.status(401).json({ error: 'This account is unavailable. Please sign in again.' });
    }

    // Tokens issued before session tracking was deployed remain valid only
    // until their short access-token expiry. All new tokens carry a sid.
    if (decoded.sid) {
      const now = new Date();
      const session = await UserSession.findOne({
        _id: decoded.sid,
        userId: user._id,
        revokedAt: null,
        expiresAt: { $gt: now }
      }).select('+refreshTokenHash');

      if (!session || (now.getTime() - new Date(session.lastActivityAt).getTime()) > IDLE_TIMEOUT_MS) {
        if (session) {
          session.revokedAt = now;
          session.revokedReason = 'Session expired due to inactivity';
          await session.save();
        }
        return res.status(401).json({ error: 'Your session has expired. Please sign in again.' });
      }

      // Avoid a database write on every API request.
      if (now.getTime() - new Date(session.lastActivityAt).getTime() > 5 * 60 * 1000) {
        session.lastActivityAt = now;
        await session.save();
      }
    }

    req.user = { id: user._id.toString(), _id: user._id, role: user.role, sid: decoded.sid || null };
    return next();
  } catch (err) {
    if (err.name === 'TokenExpiredError' || err.name === 'JsonWebTokenError') {
      return res.status(401).json({ error: 'Your session is invalid or has expired. Please sign in again.' });
    }
    console.error('Authentication middleware error:', err);
    return res.status(500).json({ error: 'Authentication could not be verified.' });
  }
}

module.exports = { authenticateToken };
