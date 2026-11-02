// Authentication routes (login, signup, role-based)
const express = require('express');
const router = express.Router();

const User = require('../models/User');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const logger = require('../utils/logger');
const JWT_SECRET = process.env.JWT_SECRET || 'supersecretkey';
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'superrefreshsecret';

// POST /api/auth/signup

// Signup route
router.post('/signup', async (req, res) => {
  try {
    const { name, email, password, role } = req.body;
    if (!name || !email || !password || !role) {
      return res.status(400).json({ error: 'All fields are required.' });
    }
    if (!['investigator', 'researcher'].includes(role)) {
      return res.status(400).json({ error: 'Public registration is limited to investigator and researcher accounts.' });
    }
    const existing = await User.findOne({ email });
    if (existing) {
      return res.status(409).json({ error: 'Email already registered.' });
    }
    const hashed = await bcrypt.hash(password, 10);
    const user = await User.create({ name, email, password: hashed, role });
    return res.status(201).json({ message: 'Signup successful', user: { id: user._id, name: user.name, email: user.email, role: user.role } });
  } catch (err) {
    logger.error('Error during signup:', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/auth/login

// Login route
router.post('/login', async (req, res) => {
  try {
    const { email, password, role } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }
    
    // Build query - include role if specified
    let query = { email };
    if (role) {
      query.role = role;
    }
    
    const user = await User.findOne(query);
    if (!user) {
      logger.error('Login failed - user not found:', `email: ${email}, role: ${role}`);
      return res.status(401).json({ error: 'Invalid credentials.' });
    }
    const match = await bcrypt.compare(password, user.password);
    if (!match) {
      logger.error('Login failed - password mismatch:', `email: ${email}`);
      return res.status(401).json({ error: 'Invalid credentials.' });
    }
    logger.info('Login successful:', `${email} (${user.role})`);
    const token = jwt.sign({ id: user._id, role: user.role }, JWT_SECRET, { expiresIn: '2h' });
    const refreshToken = jwt.sign({ id: user._id, role: user.role }, JWT_REFRESH_SECRET, { expiresIn: '7d' });
    // persist refresh token on user record and set cookie
    user.refreshToken = refreshToken;
    await user.save();
    // Set HttpOnly refresh token cookie (scoped to /api/auth)
    res.cookie('refreshToken', refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: process.env.NODE_ENV === 'production' ? 'strict' : 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000,
      path: '/api/auth'
    });
    // Set HttpOnly access token cookie (short-lived)
    res.cookie('accessToken', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: process.env.NODE_ENV === 'production' ? 'strict' : 'lax',
      maxAge: 2 * 60 * 60 * 1000,
      path: '/'
    });
    return res.json({ 
      message: 'Login successful', 
      token, 
      user: { 
        id: user._id, 
        name: user.name, 
        email: user.email, 
        role: user.role,
        organizationName: user.organizationName,
        organizationRole: user.organizationRole
      } 
    });
  } catch (err) {
    logger.error('Error during login:', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/auth/refresh - exchange refresh token for new access token
router.post('/refresh', async (req, res) => {
  try {
    // Read refresh token from HttpOnly cookie
    const refreshToken = req.cookies?.refreshToken;
    if (!refreshToken) return res.status(400).json({ error: 'Refresh token required' });
    let decoded;
    try {
      decoded = jwt.verify(refreshToken, JWT_REFRESH_SECRET);
    } catch (e) {
      return res.status(401).json({ error: 'Invalid refresh token' });
    }
    const user = await User.findById(decoded.id);
    if (!user || user.refreshToken !== refreshToken) {
      return res.status(401).json({ error: 'Invalid refresh token' });
    }
    const newToken = jwt.sign({ id: user._id, role: user.role }, JWT_SECRET, { expiresIn: '2h' });
    // Rotate refresh token and set cookie
    const newRefresh = jwt.sign({ id: user._id, role: user.role }, JWT_REFRESH_SECRET, { expiresIn: '7d' });
    user.refreshToken = newRefresh;
    await user.save();
    // Rotate refresh cookie and update access cookie
    res.cookie('refreshToken', newRefresh, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: process.env.NODE_ENV === 'production' ? 'strict' : 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000,
      path: '/api/auth'
    });
    res.cookie('accessToken', newToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: process.env.NODE_ENV === 'production' ? 'strict' : 'lax',
      maxAge: 2 * 60 * 60 * 1000,
      path: '/'
    });
    res.json({ token: newToken });
  } catch (err) {
    logger.error('Refresh token error:', err.message);
    res.status(500).json({ error: 'Failed to refresh token' });
  }
});

// POST /api/auth/logout - clear refresh token
router.post('/logout', async (req, res) => {
  try {
    // Clear refresh token cookie and server-side token
    const refreshToken = req.cookies?.refreshToken;
    if (refreshToken) {
      try {
        const decoded = jwt.verify(refreshToken, JWT_REFRESH_SECRET);
        const user = await User.findById(decoded.id);
        if (user && user.refreshToken === refreshToken) {
          user.refreshToken = '';
          await user.save();
        }
      } catch (e) {
        // ignore
      }
    }
    // Clear both cookies
    res.clearCookie('refreshToken', { path: '/api/auth' });
    res.clearCookie('accessToken', { path: '/' });
    res.json({ message: 'Logged out' });
  } catch (err) {
    logger.error('Logout error:', err.message);
    res.status(500).json({ error: 'Failed to logout' });
  }
});

module.exports = router;
