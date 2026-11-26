const mongoose = require('mongoose');

const RepositoryAccessRequestSchema = new mongoose.Schema({
  caseId: { type: mongoose.Schema.Types.ObjectId, ref: 'Case', required: true, index: true },
  caseNumber: { type: String, required: true, maxlength: 80 },
  caseTitle: { type: String, required: true, maxlength: 200 },
  requesterId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  requesterName: { type: String, required: true, maxlength: 120 },
  requesterUserType: { type: String, enum: ['student', 'researcher', null], default: null },
  requesterOrganization: { type: String, default: '', maxlength: 140 },
  purpose: { type: String, required: true, trim: true, minlength: 20, maxlength: 2000 },
  status: { type: String, enum: ['pending', 'approved', 'declined', 'cancelled'], default: 'pending', index: true },
  decisionNote: { type: String, default: '', trim: true, maxlength: 1200 },
  approvedEvidenceIds: [{ type: mongoose.Schema.Types.ObjectId }],
  reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  reviewedByName: { type: String, default: '', maxlength: 120 },
  reviewedAt: { type: Date, default: null },
  cancelledAt: { type: Date, default: null }
}, { timestamps: true });

RepositoryAccessRequestSchema.index({ caseId: 1, requesterId: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model('RepositoryAccessRequest', RepositoryAccessRequestSchema);
