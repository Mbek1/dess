const mongoose = require('mongoose');

const auditLogSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  userName: String,
  action: {
    type: String,
    required: true,
    enum: [
      'LOGIN',
      'LOGOUT',
      'CREATE_USER',
      'UPDATE_USER',
      'DELETE_USER',
      'TOGGLE_USER_STATUS',
      'FORCE_PASSWORD_RESET',
      'TOGGLE_MFA',
      'UPLOAD_EVIDENCE',
      'DOWNLOAD_EVIDENCE',
      'DELETE_EVIDENCE',
      'VIEW_CASE',
      'CREATE_CASE',
      'CLOSE_CASE',
      'MODIFY_CASE',
      'VIEW_MESSAGE',
      'SEND_MESSAGE',
      'UPDATE_POLICIES',
      'UPDATE_SETTINGS',
      'TOGGLE_MAINTENANCE',
      'GENERATE_REPORT',
      'TEST_BACKUP',
      'PURGE_LOGS',
      'ACCESS_DENIED',
      'SUSPICIOUS_ACTIVITY'
    ]
  },
  description: String,
  details: mongoose.Schema.Types.Mixed,
  ipAddress: String,
  userAgent: String,
  sourceEntity: {
    type: String,
    enum: ['User', 'Case', 'Evidence', 'Message', 'System']
  },
  sourceEntityId: mongoose.Schema.Types.ObjectId,
  status: {
    type: String,
    enum: ['SUCCESS', 'FAILURE'],
    default: 'SUCCESS'
  },
  timestamp: {
    type: Date,
    default: Date.now,
    index: true
  }
});

// Index for faster queries
auditLogSchema.index({ userId: 1, timestamp: -1 });
auditLogSchema.index({ action: 1, timestamp: -1 });
auditLogSchema.index({ timestamp: -1 });

module.exports = mongoose.model('AuditLog', auditLogSchema);
