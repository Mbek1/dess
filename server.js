
// ======================================================
// DIGITAL EVIDENCE STORAGE SYSTEM (DESS)
// Express Backend Server
// Render Production Deployment
// ======================================================

const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
require('dotenv').config();

const logger = require('./utils/logger');
const path = require('path');
const cookieParser = require('cookie-parser');

const {
    settleExpiredEvidenceDeletionRequests
} = require('./utils/evidence-deletion');

const app = express();

// Render automatically supplies PORT (default: 10000).
// Locally, the application defaults to port 3001.
const PORT = process.env.PORT || 3001;

// ======================================================
// 1. CORS CONFIGURATION
// ======================================================

// Production frontend:
// https://dess-frontend.onrender.com
//
// Local frontend:
// http://localhost:5173
//
// FRONTEND_URL supports multiple comma-separated origins.

const defaultFrontendOrigin =
    process.env.NODE_ENV === 'production'
        ? 'https://dess-frontend.onrender.com'
        : 'http://localhost:5173';

const configuredOrigins = (
    process.env.FRONTEND_URL || ''
)
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean);

const allowedOrigins = [
    ...new Set([
        defaultFrontendOrigin,
        ...configuredOrigins
    ].map(origin => origin.replace(/\/+$/, '')))
];

const corsOptions = {
    origin: (origin, callback) => {

        // Allow requests without an Origin header.
        if (!origin || allowedOrigins.includes(origin)) {
            return callback(null, true);
        }

        logger.warn(
            `CORS blocked request from origin: ${origin}`
        );

        return callback(
            new Error(`CORS blocked origin: ${origin}`)
        );
    },

    credentials: true
};

// CORS must run before API routes.
// This also handles browser OPTIONS preflight requests.
app.use(cors(corsOptions));

// ======================================================
// 2. GENERAL MIDDLEWARE
// ======================================================

app.use(express.json({ limit: '10mb' }));

app.use(express.urlencoded({
    extended: true,
    limit: '10mb'
}));

app.use(cookieParser());

// ======================================================
// 3. STATIC FILES
// ======================================================

// Only profile avatars are publicly accessible.
// Evidence and verification documents remain protected
// through their authenticated routes.

app.use(
    '/uploads/avatars',
    express.static(
        path.join(__dirname, 'uploads', 'avatars')
    )
);

// ======================================================
// 4. PRODUCTION CONTENT SECURITY POLICY
// ======================================================

app.use((req, res, next) => {

    if (process.env.NODE_ENV === 'production') {

        res.setHeader(
            'Content-Security-Policy',
            "default-src 'self'; " +
            "script-src 'self'; " +
            "connect-src 'self' https:; " +
            "img-src 'self' data: https:; " +
            "style-src 'self' 'unsafe-inline' https:; " +
            "object-src 'none'; " +
            "base-uri 'self'; " +
            "frame-ancestors 'none';"
        );

    }

    next();
});

// ======================================================
// 5. HEALTH CHECK
// ======================================================

app.get('/api/health', (req, res) => {

    res.status(200).json({
        success: true,
        message: 'Digital Evidence Storage System API is running',
        database: mongoose.connection.readyState === 1
            ? 'connected'
            : 'disconnected'
    });

});

// ======================================================
// 6. API ROUTES
// ======================================================

// Authentication
app.use('/api/auth', require('./routes/auth'));

// Case management
app.use('/api/cases', require('./routes/cases'));

// Evidence management
app.use('/api/evidence', require('./routes/evidence'));

// User management
app.use('/api/users', require('./routes/users'));

// Messaging
app.use('/api/messages', require('./routes/messages'));

// Notifications
app.use('/api/notifications', require('./routes/notifications'));

// Researcher functionality
app.use('/api/researcher', require('./routes/researcher'));

// Administration
app.use('/api/admin', require('./routes/admin'));

// ======================================================
// 7. ROOT ROUTE
// ======================================================

app.get('/', (req, res) => {

    res.send('Digital Evidence Storage System API');

});

// ======================================================
// 8. 404 HANDLER
// ======================================================

app.use((req, res) => {

    logger.warn(
        '404 - Route not found:',
        `${req.method} ${req.url}`
    );

    res.status(404).json({
        error: 'Route not found'
    });

});

// ======================================================
// 9. DATABASE CONNECTION AND SERVER STARTUP
// ======================================================

async function startServer() {

    try {

        // Connect to MongoDB.
        await mongoose.connect(
            process.env.MONGODB_URI ||
            'mongodb://localhost:27017/dess'
        );

        logger.info('MongoDB connected');

        // Process expired evidence deletion requests.
        settleExpiredEvidenceDeletionRequests()
            .catch(err => {

                logger.error(
                    'Failed to settle expired evidence votes:',
                    err.message
                );

            });

        // Automatically check expired deletion requests
        // every hour.

        const deletionVoteTimer = setInterval(() => {

            settleExpiredEvidenceDeletionRequests()
                .catch(err => {

                    logger.error(
                        'Failed to settle expired evidence votes:',
                        err.message
                    );

                });

        }, 60 * 60 * 1000);

        deletionVoteTimer.unref();

        // Start Express server.
        // Render requires binding to 0.0.0.0.

        app.listen(PORT, '0.0.0.0', () => {

            logger.info(`Server running on port ${PORT}`);

            logger.info(
                `Allowed frontend origins: ${allowedOrigins.join(', ')}`
            );

        });

    } catch (err) {

        logger.error(
            'MongoDB connection error; API server was not started:',
            err.message
        );

        await mongoose.disconnect();

        process.exitCode = 1;

    }

}

// ======================================================
// 10. START APPLICATION
// ======================================================

startServer();
