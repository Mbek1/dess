const mongoose = require('mongoose');

const CaseChatMessageSchema = new mongoose.Schema({
  caseChatId: { type: mongoose.Schema.Types.ObjectId, ref: 'CaseChat', required: true, index: true },
  caseId: { type: mongoose.Schema.Types.ObjectId, ref: 'Case', required: true, index: true },
  senderId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  senderName: { type: String, required: true },
  senderRole: { type: String, enum: ['investigator', 'admin'], required: true },
  content: { type: String, required: true, trim: true, maxlength: 10000 },
  readBy: [{
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    readAt: { type: Date, default: Date.now }
  }],
  createdAt: { type: Date, default: Date.now, index: true }
}, { versionKey: false });

CaseChatMessageSchema.index({ caseChatId: 1, createdAt: 1 });

module.exports = mongoose.model('CaseChatMessage', CaseChatMessageSchema);