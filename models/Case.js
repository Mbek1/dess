const mongoose = require('mongoose');

const EvidenceSchema = new mongoose.Schema({
  filename: { type: String, required: true },
  originalName: { type: String },
  mimeType: { type: String },
  type: { type: String, required: true },
  name: { type: String, required: true },
  description: { type: String, required: true },
  hash: { type: String, required: true },
  format: { type: String, required: true },
  uploadedAt: { type: Date, default: Date.now },
  visibleToResearchers: { type: Boolean, default: false },
  deletionRequest: {
    requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    reason: { type: String, trim: true, maxlength: 1000 },
    requestedAt: { type: Date },
    expiresAt: { type: Date },
    eligibleVoterIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    votes: [{
      userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
      decision: { type: String, enum: ['delete', 'keep'], required: true },
      votedAt: { type: Date, default: Date.now }
    }],
    status: { type: String, enum: ['pending', 'deleted', 'kept'] },
    resolution: { type: String, enum: ['majority_delete', 'majority_keep', 'tie_keep', 'timeout_keep'] },
    resolvedAt: { type: Date }
  },
  deleted: { type: Boolean, default: false },
  deletedReason: { type: String },
  deletedAt: { type: Date },
});

const AuditLogSchema = new mongoose.Schema({
  action: { type: String, required: true }, // e.g., 'EVIDENCE_UPLOAD', 'EVIDENCE_DELETE', 'CASE_UPDATE', 'CASE_CLOSE'
  type: { type: String, required: true }, // file type or action type
  filename: { type: String }, // if action involves a file
  description: { type: String, required: true }, // human readable description of the action
  performedBy: {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    name: { type: String, required: true },
    email: { type: String, required: true }
  },
  details: { type: mongoose.Schema.Types.Mixed }, // additional action-specific details
  date: { type: Date, default: Date.now },
});

const CaseSchema = new mongoose.Schema({
  number: { type: Number, required: true, unique: true },
  caseId: { type: String, required: true, unique: true },  // Format: YYYY-INITIALS-NUMBER (e.g., 2026-NYC-001)
  caseType: { type: String, enum: ['civil', 'criminal'], required: true },  // Case type
  name: { type: String, required: true },
  description: { type: String, required: true },
  keywords: { type: String },  // New field for case keywords
  docketNumber: { type: String },  // New field for docket number (used instead of courtNumber for court escalation)
  status: { type: String, enum: ['open', 'closed'], default: 'open' },
  escalationStatus: { type: String, enum: ['police', 'court'], default: 'police' },  // Track case escalation
  escalationDetails: {
    escalatedToCourtDate: { type: Date },
    escalatedToCourtBy: {
      userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      name: String,
      email: String
    },
    courtDocketNumber: { type: String }  // Docket number assigned when escalated to court
  },
  createdBy: {
    id: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    name: String,
    email: String,
    role: String
  },
  team: [{
    id: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    name: String,
    email: String,
  }],
  caseUpdates: [{
    date: { type: Date, default: Date.now },
    updatedBy: {
      userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      name: String,
      email: String
    },
    details: { type: String, required: true }
  }],
  evidence: [EvidenceSchema],
  auditLog: [AuditLogSchema],
  closureDocs: [
    {
      filename: String,
      originalname: String,
      path: String,
      uploadedAt: { type: Date, default: Date.now }
    }
  ],
}, { timestamps: true });

module.exports = mongoose.model('Case', CaseSchema);
