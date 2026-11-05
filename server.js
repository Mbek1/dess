
// ======================================================
// DIGITAL EVIDENCE STORAGE SYSTEM (DESS)
// Express Backend Server
// Production Configuration: Render
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
const PORT = process.env.PORT || 3001;

// Render runs the application behind a reverse proxy.
// This also helps Express correctly recognize HTTPS when
// using secure authentication cookies.
app.set('trust proxy', 1);

// ======================================================
// 1. CORS CONFIGURATION
// ======================================================

// Production frontend:
// https://dess-frontend.onrender.com
//
// Local development frontend:
// http://localhost:5173
//
// Additional frontend origins can be supplied through
// FRONTEND_URL as comma-separated values.

const defaultOrigins =
    process.env.NODE_ENV === 'production'
        ? ['https://dess-frontend.onrender.com']
        : ['http://localhost:5173'];

const configuredOrigins = (process.env.FRONTEND_URL || '')
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean);

const allowedOrigins = [
    ...new Set(
        [...defaultOrigins, ...configuredOrigins]
            .map(origin => origin.replace(/\/+$/, ''))
    )
];

const corsOptions = {
    origin: (origin, callback) => {

        // Permit requests without an Origin header,
        // such as server-to-server requests and Postman.

        if (!origin || allowedOrigins.includes(origin)) {
            return callback(null, true);
        }

        logger.warn(`CORS blocked request from origin: ${origin}`);

        return callback(
            new Error(`CORS blocked origin: ${origin}`)
        );
    },

    credentials: true,

    methods: [
        'GET',
        'POST',
        'PUT',
        'PATCH',
        'DELETE',
        'OPTIONS'
    ],

    allowedHeaders: [
        'Content-Type',
        'Authorization'
    ],

    optionsSuccessStatus: 204
};

// Apply CORS before all API routes and request handlers.
// This also handles OPTIONS preflight requests.

app.use(cors(corsOptions));

// ======================================================
// 2. GENERAL MIDDLEWARE
// ======================================================

app.use(express.json({
    limit: '10mb'
}));

app.use(express.urlencoded({
    extended: true,
    limit: '10mb'
}));

app.use(cookieParser());

// ======================================================
// 3. STATIC FILE CONFIGURATION
// ======================================================

// Only profile avatars are publicly accessible.
// Evidence and verification documents must use
// authenticated routes.

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

// Used to verify that the backend is running on Render.

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

app.use('/api/auth', require('./routes/auth'));

app.use('/api/cases', require('./routes/cases'));

app.use('/api/evidence', require('./routes/evidence'));

app.use('/api/users', require('./routes/users'));

app.use('/api/messages', require('./routes/messages'));

app.use('/api/notifications', require('./routes/notifications'));

app.use('/api/researcher', require('./routes/researcher'));

app.use('/api/admin', require('./routes/admin'));

// ======================================================
// 7. ROOT ROUTE
// ======================================================

app.get('/', (req, res) => {

    res.status(200).json({
        success: true,
        application: 'Digital Evidence Storage System',
        message: 'DESS API is running successfully'
    });

});

// ======================================================
// 8. 404 HANDLER
// ======================================================

app.use((req, res) => {

    logger.warn(
        `404 - Route not found: ${req.method} ${req.url}`
    );

    res.status(404).json({
        success: false,
        error: 'Route not found'
    });

});

// ======================================================
// 9. DATABASE CONNECTION AND SERVER STARTUP
// ======================================================

async function startServer() {

    try {

        // Connect to MongoDB Atlas in production.
        await mongoose.connect(
            process.env.MONGODB_URI ||
            'mongodb://localhost:27017/dess'
        );

        logger.info('MongoDB connected successfully');

        // Settle expired evidence deletion requests.
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

        // Start Express on Render's assigned port.

        app.listen(PORT, '0.0.0.0', () => {

            logger.info(
                `DESS server running on port ${PORT}`
            );

            logger.info(
                `Environment: ${process.env.NODE_ENV || 'development'}`
            );

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
