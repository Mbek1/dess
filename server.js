
// Basic Express server setup for Digital Evidence Storage System
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
require('dotenv').config();
const logger = require('./utils/logger');
const path = require('path');
const cookieParser = require('cookie-parser');
const { settleExpiredEvidenceDeletionRequests } = require('./utils/evidence-deletion');
const app = express();
const PORT = process.env.PORT || 3001;

// Allow cross-origin requests from frontend and accept credentials (cookies)
app.use(cors({ origin: process.env.FRONTEND_URL || 'http://localhost:5173', credentials: true }));
// Increase payload size limits to allow uploads and base64 payloads
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(cookieParser());
// Only profile avatars are public; evidence and verification documents are served by authenticated routes.
app.use('/uploads/avatars', express.static(path.join(__dirname, 'uploads', 'avatars')));

// Production Content Security Policy
app.use((req, res, next) => {
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; connect-src 'self' https:; img-src 'self' data: https:; style-src 'self' 'unsafe-inline' https:; object-src 'none'; base-uri 'self'; frame-ancestors 'none';");
  }
  next();
});

// Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/cases', require('./routes/cases'));
app.use('/api/evidence', require('./routes/evidence'));
app.use('/api/users', require('./routes/users'));
app.use('/api/messages', require('./routes/messages'));
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api/researcher', require('./routes/researcher'));
app.use('/api/admin', require('./routes/admin'));

app.get('/', (req, res) => {
  res.send('Digital Evidence Storage System API');
});

// 404 handler
app.use((req, res) => {
  logger.warn('404 - Route not found:', `${req.method} ${req.url}`);
  res.status(404).json({ error: 'Route not found' });
});

async function startServer() {
  try {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/dess');
    logger.info('MongoDB connected');
    settleExpiredEvidenceDeletionRequests().catch(err => logger.error('Failed to settle expired evidence votes:', err.message));
    const deletionVoteTimer = setInterval(() => {
      settleExpiredEvidenceDeletionRequests().catch(err => logger.error('Failed to settle expired evidence votes:', err.message));
    }, 60 * 60 * 1000);
    deletionVoteTimer.unref();
    app.listen(PORT, () => {
      logger.info(`Server running on port ${PORT}`);
    });
  } catch (err) {
    logger.error('MongoDB connection error; API server was not started:', err.message);
    await mongoose.disconnect();
    process.exitCode = 1;
  }
}

startServer();
