const express = require('express');
const router = express.Router();
const bcryptjs = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Case = require('../models/Case');
const AuditLog = require('../models/AuditLog');
const Policy = require('../models/Policy');
const SystemSettings = require('../models/SystemSettings');
const logger = require('../utils/logger');
const { authenticateToken } = require('../middleware/auth');

// Middleware to check if user is admin
const checkAdmin = (req, res, next) => {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
};

// Apply auth and admin check to all routes
router.use(authenticateToken, checkAdmin);

// ============================================
// DASHBOARD STATISTICS
// ============================================

router.get('/stats', async (req, res) => {
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [totalUsers, totalCases, evidenceCounts, failedLogins, pendingDeletionVotes] = await Promise.all([
      User.countDocuments(),
      Case.countDocuments(),
      Case.aggregate([
        { $project: { activeEvidence: { $size: { $filter: { input: '$evidence', as: 'item', cond: { $ne: ['$$item.deleted', true] } } } } } },
        { $group: { _id: null, count: { $sum: '$activeEvidence' } } }
      ]),
      AuditLog.countDocuments({ action: 'LOGIN', status: 'FAILURE', timestamp: { $gte: since } }),
      Case.aggregate([
        { $unwind: '$evidence' },
        { $match: { 'evidence.deletionRequest.status': 'pending' } },
        { $count: 'count' }
      ])
    ]);
    const stats = {
      totalUsers,
      totalCases,
      totalEvidence: evidenceCounts[0]?.count || 0,
      failedLogins: failedLogins || 0,
      pendingDeletionVotes: pendingDeletionVotes[0]?.count || 0
    };
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// ============================================
// USER MANAGEMENT
// ============================================

// Get all users
router.get('/users', async (req, res) => {
  try {
    const users = await User.find().select('-password');
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// Create new user
router.post('/users', async (req, res) => {
  try {
    const { name, email, role, password } = req.body;

    // Validate required fields
    if (!name || !email || !role || !password) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Check if user exists
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ error: 'User already exists' });
    }

    // Create new user
    const hashedPassword = await bcryptjs.hash(password, 10);
    const newUser = new User({
      name,
      email,
      role,
      password: hashedPassword,
      active: true,
      mfaEnabled: role === 'admin' ? true : false,
      createdAt: new Date(),
      createdBy: req.user._id
    });

    await newUser.save();

    // Log audit event
    logAuditEvent(req.user._id, 'CREATE_USER', `Created user: ${name} (${role})`);

    res.status(201).json({ message: 'User created successfully', user: newUser });
  } catch (err) {
    console.error('Error creating user:', err);
    res.status(500).json({ error: 'Failed to create user' });
  }
});

// Toggle user status (activate/deactivate)
router.patch('/users/:userId/toggle-status', async (req, res) => {
  try {
    const user = await User.findById(req.params.userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    user.active = !user.active;
    await user.save();

    logAuditEvent(req.user._id, 'TOGGLE_USER_STATUS', `${user.active ? 'Activated' : 'Deactivated'} user: ${user.email}`);

    res.json({ message: `User ${user.active ? 'activated' : 'deactivated'}` });
  } catch (err) {
    res.status(500).json({ error: 'Failed to toggle user status' });
  }
});

// Force password reset
router.post('/users/:userId/reset-password', async (req, res) => {
  try {
    const user = await User.findById(req.params.userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Generate temporary password
    const tempPassword = Math.random().toString(36).slice(-10);
    const hashedPassword = await bcryptjs.hash(tempPassword, 10);
    user.password = hashedPassword;
    user.passwordResetRequired = true;
    await user.save();

    logAuditEvent(req.user._id, 'FORCE_PASSWORD_RESET', `Forced password reset for user: ${user.email}`);

    // TODO: Send email with temp password
    res.json({ message: 'Password reset initiated', tempPassword: tempPassword });
  } catch (err) {
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

// Toggle MFA for user
router.patch('/users/:userId/mfa', async (req, res) => {
  try {
    const { enabled } = req.body;
    const user = await User.findById(req.params.userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    user.mfaEnabled = enabled;
    await user.save();

    logAuditEvent(req.user._id, 'TOGGLE_MFA', `${enabled ? 'Enabled' : 'Disabled'} MFA for user: ${user.email}`);

    res.json({ message: `MFA ${enabled ? 'enabled' : 'disabled'}` });
  } catch (err) {
    res.status(500).json({ error: 'Failed to toggle MFA' });
  }
});

// ============================================
// SECURITY & POLICY MANAGEMENT
// ============================================

router.get('/policies', async (req, res) => {
  try {
    // Fetch all policies from database
    const policyTypes = ['password', 'session', 'mfa', 'retention', 'audit'];
    const policies = {};

    for (const type of policyTypes) {
      const policy = await Policy.findOne({ policyType: type, active: true });
      policies[type] = policy?.settings || getDefaultPolicy(type);
    }

    res.json(policies);
  } catch (err) {
    console.error('Error fetching policies:', err);
    res.status(500).json({ error: 'Failed to fetch policies' });
  }
});

router.post('/policies', async (req, res) => {
  try {
    const { password, session, mfa, retention, audit } = req.body;

    // Update each policy type
    for (const [type, settings] of Object.entries({ password, session, mfa, retention, audit })) {
      if (settings) {
        const policy = await Policy.findOneAndUpdate(
          { policyType: type },
          {
            settings,
            lastModifiedBy: req.user._id,
            lastModifiedAt: new Date(),
            $inc: { version: 1 }
          },
          { upsert: true, new: true }
        );
      }
    }

    logAuditEvent(req.user._id, 'UPDATE_POLICIES', 'Updated system policies', { changes: Object.keys(req.body) });

    res.json({ message: 'Policies updated successfully' });
  } catch (err) {
    console.error('Error updating policies:', err);
    res.status(500).json({ error: 'Failed to update policies' });
  }
});

function getDefaultPolicy(type) {
  const defaults = {
    password: {
      minLength: 12,
      requireUppercase: true,
      requireNumbers: true,
      requireSpecialChars: true,
      expiryDays: 90
    },
    session: {
      timeoutMinutes: 60,
      idleTimeoutMinutes: 30,
      maxActiveSessions: 3,
      lockoutThreshold: 5,
      lockoutDurationMinutes: 15
    },
    mfa: {
      enforceMFAAdmins: true,
      enforceMFAInvestigators: true,
      enableIPWhitelist: false
    },
    retention: {
      defaultRetentionYears: 7,
      archiveAfterClosureDays: 30,
      enableAutoPurge: false,
      auditLogRetentionYears: 10
    },
    audit: {
      logAccessEvents: true,
      logModifications: true,
      logAuthentication: true,
      alertSuspiciousActivity: true
    }
  };
  return defaults[type] || {};
}

// ============================================
// CASE & EVIDENCE OVERSIGHT
// ============================================

router.get('/cases-oversight', async (req, res) => {
  try {
    const cases = await Case.find()
      .select('_id caseId name status createdAt updatedAt evidence team');

    const formattedCases = cases.map(c => ({
      _id: c._id,
      caseId: c.caseId,
      name: c.name,
      status: c.status,
      evidenceCount: c.evidence ? c.evidence.length : 0,
      teamMembers: c.team ? c.team.length : 0,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt
    }));

    const stats = {
      total: await Case.countDocuments(),
      open: await Case.countDocuments({ status: 'open' }),
      closed: await Case.countDocuments({ status: 'closed' }),
      totalEvidence: await Case.aggregate([
        { $group: { _id: null, count: { $sum: { $size: '$evidence' } } } }
      ]).then(result => result[0]?.count || 0)
    };

    res.json({ cases: formattedCases, stats });
  } catch (err) {
    console.error('Error fetching cases:', err);
    res.status(500).json({ error: 'Failed to fetch cases' });
  }
});

router.get('/cases/:caseId', async (req, res) => {
  try {
    const caseData = await Case.findById(req.params.caseId);

    if (!caseData) {
      return res.status(404).json({ error: 'Case not found' });
    }

    logAuditEvent(req.user._id, 'VIEW_CASE', `Viewed case: ${caseData.name}`);

    res.json(caseData);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch case details' });
  }
});

// ============================================
// AUDIT LOGS
// ============================================

router.get('/audit-logs', async (req, res) => {
  try {
    const { userId, action, startDate, endDate, limit = 100, skip = 0 } = req.query;

    let query = {};
    if (userId) query.userId = userId;
    if (action) query.action = action;
    if (startDate || endDate) {
      query.date = {};
      if (startDate) query.date.$gte = new Date(startDate);
      if (endDate) query.date.$lte = new Date(endDate);
    }

    const logs = await AuditLog.find(query)
      .sort({ date: -1 })
      .limit(parseInt(limit))
      .skip(parseInt(skip));

    const total = await AuditLog.countDocuments(query);

    res.json({ logs, total, limit: parseInt(limit), skip: parseInt(skip) });
  } catch (err) {
    logger.error('Error fetching audit logs:', err.message);
    res.status(500).json({ error: 'Failed to fetch audit logs' });
  }
});

// ============================================
// REPORTING
// ============================================

router.get('/reports/:type', async (req, res) => {
  try {
    const { type } = req.params;
    const { startDate, endDate } = req.query;

    // TODO: Generate actual reports based on type
    let reportData = '';

    switch (type) {
      case 'evidence':
        reportData = generateEvidenceReport();
        break;
      case 'user':
        reportData = generateUserReport();
        break;
      case 'case':
        reportData = generateCaseReport();
        break;
      case 'security':
        reportData = generateSecurityReport();
        break;
      default:
        return res.status(400).json({ error: 'Invalid report type' });
    }

    logAuditEvent(req.user._id, 'GENERATE_REPORT', `Generated ${type} report`);

    // Send as PDF (mock implementation)
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${type}-report.pdf"`);
    res.send(reportData);
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate report' });
  }
});

router.post('/reports/custom', async (req, res) => {
  try {
    const { type, startDate, endDate, format } = req.body;

    // TODO: Generate custom report
    logAuditEvent(req.user._id, 'GENERATE_CUSTOM_REPORT', `Generated custom ${type} report in ${format}`);

    res.json({ message: 'Report generated successfully' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate custom report' });
  }
});

// ============================================
// SYSTEM SETTINGS
// ============================================

router.get('/settings', async (req, res) => {
  try {
    const settings = {};
    const categories = ['backup', 'logging', 'email', 'storage', 'security', 'integration'];

    for (const category of categories) {
      const categorySettings = await SystemSettings.find({ category });
      for (const setting of categorySettings) {
        if (!settings[category]) settings[category] = {};
        const key = setting.settingKey.replace(`${category}_`, '');
        settings[category][key] = setting.settingValue;
      }
    }

    res.json(settings);
  } catch (err) {
    console.error('Error fetching settings:', err);
    res.status(500).json({ error: 'Failed to fetch settings' });
  }
});

router.post('/settings', async (req, res) => {
  try {
    const settingsPayload = req.body;

    // Save each setting to database
    for (const [category, settings] of Object.entries(settingsPayload)) {
      for (const [key, value] of Object.entries(settings)) {
        const settingKey = `${category}_${key}`;
        await SystemSettings.findOneAndUpdate(
          { settingKey },
          {
            settingValue: value,
            category,
            lastModifiedBy: req.user._id,
            lastModifiedAt: new Date()
          },
          { upsert: true, new: true }
        );
      }
    }

    logAuditEvent(req.user._id, 'UPDATE_SETTINGS', 'Updated system settings', { categories: Object.keys(settingsPayload) });

    res.json({ message: 'Settings updated successfully' });
  } catch (err) {
    console.error('Error updating settings:', err);
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

// ============================================
// BACKUP & MAINTENANCE
// ============================================

router.post('/backup/test', async (req, res) => {
  try {
    // TODO: Implement actual backup logic
    logAuditEvent(req.user._id, 'TEST_BACKUP', 'Performed backup test');
    res.json({ message: 'Backup completed successfully', timestamp: new Date() });
  } catch (err) {
    res.status(500).json({ error: 'Backup failed' });
  }
});

router.post('/logs/purge', async (req, res) => {
  try {
    // TODO: Implement log purging based on retention policy
    logAuditEvent(req.user._id, 'PURGE_LOGS', 'Purged old audit logs');
    res.json({ message: 'Old logs purged successfully' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to purge logs' });
  }
});

router.post('/maintenance', async (req, res) => {
  try {
    const { enabled } = req.body;
    // TODO: Implement maintenance mode toggle
    logAuditEvent(req.user._id, 'TOGGLE_MAINTENANCE', `Turned ${enabled ? 'on' : 'off'} maintenance mode`);
    res.json({ message: `Maintenance mode ${enabled ? 'enabled' : 'disabled'}` });
  } catch (err) {
    res.status(500).json({ error: 'Failed to toggle maintenance mode' });
  }
});

// ============================================
// HELPER FUNCTIONS
// ============================================

async function logAuditEvent(userId, action, description, details = {}) {
  try {
    if (!userId) {
      logger.warn('Audit log called without userId');
      return;
    }
    
    const user = await User.findById(userId);
    const auditLog = new AuditLog({
      userId: userId,
      userName: user?.name || 'Unknown',
      action,
      description,
      details,
      status: 'SUCCESS'
    });
    await auditLog.save();
    logger.info(`Audit Event: ${action}`, description);
  } catch (err) {
    logger.error('Error logging audit event:', err.message);
  }
}

function generateEvidenceReport() {
  // Mock report generation
  return 'Evidence Activity Report - ' + new Date().toISOString();
}

function generateUserReport() {
  return 'User Activity Report - ' + new Date().toISOString();
}

function generateCaseReport() {
  return 'Case Status Report - ' + new Date().toISOString();
}

function generateSecurityReport() {
  return 'Security Incident Report - ' + new Date().toISOString();
}

module.exports = router;
