const mongoose = require('mongoose');

const RepositoryModerationReportSchema = new mongoose.Schema({
  targetType: { type: String, enum: ['case', 'discussion'], required: true, index: true },
  targetId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  caseId: { type: mongoose.Schema.Types.ObjectId, ref: 'Case', required: true, index: true },
  caseNumber: { type: String, required: true, maxlength: 80 },
  caseTitle: { type: String, required: true, maxlength: 200 },
  reporterId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  reporterName: { type: String, required: true, maxlength: 120 },
  category: {
    type: String,
    enum: ['inaccurate_information', 'privacy_concern', 'sensitive_information', 'inappropriate_content', 'copyright_concern', 'other'],
    required: true
  },
  description: { type: String, required: true, trim: true, minlength: 10, maxlength: 2000 },
  status: { type: String, enum: ['pending', 'in_review', 'actioned', 'dismissed'], default: 'pending', index: true },
  reviewNote: { type: String, default: '', trim: true, maxlength: 2000 },
  reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  reviewedAt: { type: Date, default: null }
}, { timestamps: true });

RepositoryModerationReportSchema.index({ status: 1, createdAt: -1 });
RepositoryModerationReportSchema.index({ targetType: 1, targetId: 1, status: 1 });

module.exports = mongoose.model('RepositoryModerationReport', RepositoryModerationReportSchema);
