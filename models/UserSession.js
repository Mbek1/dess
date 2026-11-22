const mongoose = require('mongoose');

const UserSessionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  refreshTokenHash: { type: String, required: true, select: false },
  ipAddress: { type: String, default: '' },
  userAgent: { type: String, default: '' },
  deviceLabel: { type: String, default: 'Unknown device' },
  createdAt: { type: Date, default: Date.now },
  lastActivityAt: { type: Date, default: Date.now },
  expiresAt: { type: Date, required: true, index: true },
  revokedAt: { type: Date, default: null },
  revokedReason: { type: String, default: '' }
}, { timestamps: false });

UserSessionSchema.index({ userId: 1, createdAt: -1 });
UserSessionSchema.index({ userId: 1, revokedAt: 1, expiresAt: 1 });

module.exports = mongoose.model('UserSession', UserSessionSchema);
