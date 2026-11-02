const mongoose = require('mongoose');

const CaseChatSchema = new mongoose.Schema({
  caseId: { type: mongoose.Schema.Types.ObjectId, ref: 'Case', required: true, unique: true },
  caseNumber: { type: String, required: true },
  title: { type: String, required: true },
  participants: [{
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    name: { type: String, required: true },
    email: { type: String, required: true },
    role: { type: String, enum: ['investigator', 'admin'], required: true },
    joinedAt: { type: Date, default: Date.now }
  }],
  lastMessage: { type: String, default: '' },
  lastMessageAt: { type: Date, default: Date.now },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }
}, { timestamps: true });

CaseChatSchema.index({ 'participants.userId': 1, lastMessageAt: -1 });

module.exports = mongoose.model('CaseChat', CaseChatSchema);