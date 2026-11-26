const mongoose = require('mongoose');

const ResearchCollaborationRequestSchema = new mongoose.Schema({
  caseId: { type: mongoose.Schema.Types.ObjectId, ref: 'Case', required: true, index: true },
  caseNumber: { type: String, required: true, maxlength: 80 },
  caseTitle: { type: String, required: true, maxlength: 200 },
  fromUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  toUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  fromName: { type: String, required: true, maxlength: 120 },
  toName: { type: String, required: true, maxlength: 120 },
  fromUserType: { type: String, enum: ['student', 'researcher', null], default: null },
  toUserType: { type: String, enum: ['student', 'researcher', null], default: null },
  message: { type: String, default: '', trim: true, maxlength: 1000 },
  status: { type: String, enum: ['pending', 'accepted', 'declined', 'cancelled'], default: 'pending', index: true },
  responseMessage: { type: String, default: '', trim: true, maxlength: 1000 },
  respondedAt: { type: Date, default: null },
  cancelledAt: { type: Date, default: null }
}, { timestamps: true });

ResearchCollaborationRequestSchema.index({ toUser: 1, status: 1, createdAt: -1 });
ResearchCollaborationRequestSchema.index({ fromUser: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model('ResearchCollaborationRequest', ResearchCollaborationRequestSchema);
