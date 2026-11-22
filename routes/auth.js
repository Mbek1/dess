// Authentication routes: registration, login, session refresh and session management.
const express = require('express');
const router = express.Router();
const User = require('../models/User');
const UserSession = require('../models/UserSession');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const logger = require('../utils/logger');
const { authenticateToken } = require('../middleware/auth');

const JWT_SECRET = process.env.JWT_SECRET || 'supersecretkey';
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'superrefreshsecret';
const SESSION_MAX_HOURS = Number(process.env.SESSION_MAX_HOURS || 12);
const MAX_ACTIVE_SESSIONS = Number(process.env.MAX_ACTIVE_SESSIONS || 3);
const IDLE_TIMEOUT_MINUTES = Number(process.env.SESSION_IDLE_TIMEOUT_MINUTES || 30);

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function getRequestMetadata(req) {
  const ipAddress = req.ip || '';
  const userAgent = req.get('user-agent') || '';
  let deviceLabel = 'Unknown device';
  if (/windows/i.test(userAgent)) deviceLabel = 'Windows device';
  else if (/macintosh|mac os/i.test(userAgent)) deviceLabel = 'Mac device';
  else if (/android/i.test(userAgent)) deviceLabel = 'Android device';
  else if (/iphone|ipad/i.test(userAgent)) deviceLabel = 'iOS device';
  else if (/linux/i.test(userAgent)) deviceLabel = 'Linux device';
  return { ipAddress: String(ipAddress).trim(), userAgent, deviceLabel };
}

function setAuthCookies(res, accessToken, refreshToken, maxAge) {
  const cookieOptions = {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax'
  };
  res.cookie('refreshToken', refreshToken, { ...cookieOptions, maxAge, path: '/api/auth' });
  res.cookie('accessToken', accessToken, { ...cookieOptions, maxAge: 15 * 60 * 1000, path: '/' });
}

function clearAuthCookies(res) {
  const cookieOptions = {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax'
  };
  res.clearCookie('refreshToken', { ...cookieOptions, path: '/api/auth' });
  res.clearCookie('accessToken', { ...cookieOptions, path: '/' });
}

function createTokens(user, sessionId) {
  const claims = { id: user._id.toString(), role: user.role, sid: sessionId.toString() };
  return {
    accessToken: jwt.sign(claims, JWT_SECRET, { expiresIn: '15m' }),
    refreshToken: jwt.sign(claims, JWT_REFRESH_SECRET, { expiresIn: `${SESSION_MAX_HOURS}h` })
  };
}

// Public registration remains limited to investigator and researcher accounts.
router.post('/signup', async (req, res) => {
  try {
    const { name, email, password, role } = req.body;
    if (!name || !email || !password || !role) {
      return res.status(400).json({ error: 'All fields are required.' });
    }
    if (!['investigator', 'researcher'].includes(role)) {
      return res.status(400).json({ error: 'Public registration is limited to DESS accounts.' });
    }
    if (String(password).length < 8) {
      return res.status(400).json({ error: 'Password must contain at least 8 characters.' });
    }
    const normalizedEmail = String(email).trim().toLowerCase();
    const existing = await User.findOne({ email: normalizedEmail });
    if (existing) return res.status(409).json({ error: 'Email already registered.' });
    const hashed = await bcrypt.hash(password, 12);
    const user = await User.create({ name: String(name).trim(), email: normalizedEmail, password: hashed, role });
    return res.status(201).json({
      message: 'Signup successful',
      user: { id: user._id, name: user.name, email: user.email, role: user.role }
    });
  } catch (err) {
    logger.error('Error during signup:', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
});

// Login creates a separate server-side session for each device/browser.
router.post('/login', async (req, res) => {
  try {
    const { email, password, role } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });

    const normalizedEmail = String(email).trim().toLowerCase();
    const query = { email: normalizedEmail };
    if (role) query.role = role;

    const user = await User.findOne(query);
    const passwordMatches = user ? await bcrypt.compare(password, user.password) : false;
    if (!user || !passwordMatches || user.active === false) {
      logger.warn('Login failed', { email: normalizedEmail, ipAddress: req.ip });
      return res.status(401).json({ error: 'Invalid credentials.' });
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + SESSION_MAX_HOURS * 60 * 60 * 1000);
    const metadata = getRequestMetadata(req);
    const session = await UserSession.create({
      userId: user._id,
      ipAddress: metadata.ipAddress,
      userAgent: metadata.userAgent,
      deviceLabel: metadata.deviceLabel,
      createdAt: now,
      lastActivityAt: now,
      expiresAt,
      refreshTokenHash: 'pending'
    });

    const tokens = createTokens(user, session._id);
    session.refreshTokenHash = hashToken(tokens.refreshToken);
    await session.save();

    // Enforce the configured concurrent-session cap by revoking oldest sessions.
    const activeSessions = await UserSession.find({
      userId: user._id,
      revokedAt: null,
      expiresAt: { $gt: now }
    }).sort({ createdAt: -1 });
    if (activeSessions.length > MAX_ACTIVE_SESSIONS) {
      const excess = activeSessions.slice(MAX_ACTIVE_SESSIONS);
      await UserSession.updateMany(
        { _id: { $in: excess.map(item => item._id) } },
        { $set: { revokedAt: now, revokedReason: 'Maximum active session limit reached' } }
      );
    }

    setAuthCookies(res, tokens.accessToken, tokens.refreshToken, SESSION_MAX_HOURS * 60 * 60 * 1000);
    logger.info('Login successful', { userId: user._id.toString(), role: user.role, ipAddress: metadata.ipAddress });
    return res.json({
      message: 'Login successful',
      token: tokens.accessToken,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        organizationName: user.organizationName,
        organizationRole: user.organizationRole
      },
      session: { id: session._id, deviceLabel: session.deviceLabel, expiresAt: session.expiresAt }
    });
  } catch (err) {
    logger.error('Error during login:', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
});

// Refresh only the session represented by the HttpOnly refresh-token cookie.
router.post('/refresh', async (req, res) => {
  try {
    const refreshToken = req.cookies?.refreshToken;
    if (!refreshToken) return res.status(400).json({ error: 'Refresh token required' });

    let decoded;
    try {
      decoded = jwt.verify(refreshToken, JWT_REFRESH_SECRET);
    } catch (err) {
      clearAuthCookies(res);
      return res.status(401).json({ error: 'Invalid or expired refresh token' });
    }

    const session = await UserSession.findOne({
      _id: decoded.sid,
      userId: decoded.id,
      revokedAt: null,
      expiresAt: { $gt: new Date() }
    }).select('+refreshTokenHash');

    if (!session || session.refreshTokenHash !== hashToken(refreshToken)) {
      clearAuthCookies(res);
      return res.status(401).json({ error: 'Session is no longer active. Please sign in again.' });
    }

    const idleExpired = Date.now() - new Date(session.lastActivityAt).getTime() > IDLE_TIMEOUT_MINUTES * 60 * 1000;
    if (idleExpired) {
      session.revokedAt = new Date();
      session.revokedReason = 'Session expired due to inactivity';
      await session.save();
      clearAuthCookies(res);
      return res.status(401).json({ error: 'Session expired due to inactivity. Please sign in again.' });
    }

    const user = await User.findById(decoded.id);
    if (!user || user.active === false) {
      session.revokedAt = new Date();
      session.revokedReason = 'Account disabled';
      await session.save();
      clearAuthCookies(res);
      return res.status(401).json({ error: 'Account is unavailable.' });
    }

    const tokens = createTokens(user, session._id);
    session.refreshTokenHash = hashToken(tokens.refreshToken);
    session.lastActivityAt = new Date();
    await session.save();
    setAuthCookies(res, tokens.accessToken, tokens.refreshToken, Math.max(0, session.expiresAt.getTime() - Date.now()));
    return res.json({ token: tokens.accessToken });
  } catch (err) {
    logger.error('Refresh token error:', err.message);
    return res.status(500).json({ error: 'Failed to refresh token' });
  }
});

// List the current user's login history and active sessions.
router.get('/sessions', authenticateToken, async (req, res) => {
  try {
    const sessions = await UserSession.find({ userId: req.user.id })
      .sort({ createdAt: -1 })
      .limit(50)
      .select('-refreshTokenHash');
    const now = new Date();
    const idleCutoff = new Date(now.getTime() - IDLE_TIMEOUT_MINUTES * 60 * 1000);
    return res.json({
      sessions: sessions.map(session => ({
        id: session._id,
        deviceLabel: session.deviceLabel,
        ipAddress: session.ipAddress,
        userAgent: session.userAgent,
        createdAt: session.createdAt,
        lastActivityAt: session.lastActivityAt,
        expiresAt: session.expiresAt,
        revokedAt: session.revokedAt,
        revokedReason: session.revokedReason,
        isCurrent: String(session._id) === String(req.user.sid),
        isActive: !session.revokedAt && session.expiresAt > now && session.lastActivityAt > idleCutoff
      }))
    });
  } catch (err) {
    logger.error('Unable to load sessions:', err.message);
    return res.status(500).json({ error: 'Unable to load login history' });
  }
});

// Revoke one of the current user's sessions.
router.delete('/sessions/:sessionId', authenticateToken, async (req, res) => {
  try {
    const session = await UserSession.findOne({ _id: req.params.sessionId, userId: req.user.id, revokedAt: null });
    if (!session) return res.status(404).json({ error: 'Active session not found.' });
    session.revokedAt = new Date();
    session.revokedReason = 'Revoked by user';
    await session.save();
    const isCurrent = String(session._id) === String(req.user.sid);
    if (isCurrent) clearAuthCookies(res);
    return res.json({ message: isCurrent ? 'Current session revoked.' : 'Session revoked.' });
  } catch (err) {
    return res.status(500).json({ error: 'Unable to revoke session' });
  }
});

// Revoke every other active session without ending the current one.
router.post('/sessions/revoke-others', authenticateToken, async (req, res) => {
  try {
    await UserSession.updateMany(
      { userId: req.user.id, _id: { $ne: req.user.sid }, revokedAt: null },
      { $set: { revokedAt: new Date(), revokedReason: 'Revoked by user' } }
    );
    return res.json({ message: 'Other active sessions have been revoked.' });
  } catch (err) {
    return res.status(500).json({ error: 'Unable to revoke other sessions' });
  }
});

// Logout revokes the current server-side session, not every device.
router.post('/logout', async (req, res) => {
  try {
    const accessToken = (req.headers.authorization || '').startsWith('Bearer ')
      ? req.headers.authorization.slice(7)
      : req.cookies?.accessToken;
    if (accessToken) {
      try {
        const decoded = jwt.verify(accessToken, JWT_SECRET);
        if (decoded.sid) {
          await UserSession.updateOne(
            { _id: decoded.sid, userId: decoded.id, revokedAt: null },
            { $set: { revokedAt: new Date(), revokedReason: 'User logged out' } }
          );
        }
      } catch (err) {
        // Expired access tokens can still be logged out by clearing cookies.
      }
    }
    clearAuthCookies(res);
    return res.json({ message: 'Logged out' });
  } catch (err) {
    logger.error('Logout error:', err.message);
    return res.status(500).json({ error: 'Failed to logout' });
  }
});

module.exports = router;
