const mongoose = require('mongoose');

const NotificationSchema = new mongoose.Schema({
  recipientId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  actorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  actorName: { type: String, trim: true },
  kind: {
    type: String,
    enum: [
      'EVIDENCE_UPLOAD',
      'EVIDENCE_VISIBILITY',
      'EVIDENCE_DELETION_VOTE',
      'EVIDENCE_DELETION_RESOLVED',
      'CASE_UPDATE',
      'CASE_CLOSED',
      'CASE_CHAT_MESSAGE',
      'MESSAGE'
    ],
    required: true
  },
  title: { type: String, required: true, trim: true, maxlength: 140 },
  body: { type: String, required: true, trim: true, maxlength: 500 },
  caseId: { type: mongoose.Schema.Types.ObjectId, ref: 'Case' },
  caseNumber: { type: String },
  evidenceId: { type: mongoose.Schema.Types.ObjectId },
  link: { type: String, maxlength: 300 },
  readAt: { type: Date },
  createdAt: { type: Date, default: Date.now, index: true }
}, { versionKey: false });

NotificationSchema.index({ recipientId: 1, readAt: 1, createdAt: -1 });

module.exports = mongoose.model('Notification', NotificationSchema);
