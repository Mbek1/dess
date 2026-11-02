const mongoose = require('mongoose');

const MessageSchema = new mongoose.Schema({
  conversationId: { type: String, required: true, index: true },
  parentMessageId: { type: mongoose.Schema.Types.ObjectId, ref: 'Message' }, // For reply hierarchy
  
  // Core participants - cleaner schema with just IDs
  senderId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  senderName: { type: String, required: true }, // Cached for display without lookup
  senderEmail: { type: String, required: true },
  senderRole: { type: String, enum: ['researcher', 'investigator', 'admin'], required: true },
  
  recipientId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  recipientName: { type: String, required: true },
  recipientEmail: { type: String, required: true },
  recipientRole: { type: String, enum: ['researcher', 'investigator', 'admin'], required: true },
  
  // Case reference
  caseId: { type: mongoose.Schema.Types.ObjectId, ref: 'Case' },
  caseNumber: { type: String }, // e.g., 2026-NYC-001
  
  // Message content
  subject: { type: String, required: true, trim: true, maxlength: 180 },
  content: { type: String, required: true, trim: true, maxlength: 20000 },
  
  // Message categorization
  type: { 
    type: String, 
    enum: ['case-related', 'general', 'urgent', 'follow-up'],
    default: 'general'
  },
  
  // Priority levels
  priority: {
    type: String,
    enum: ['low', 'normal', 'high', 'urgent'],
    default: 'normal'
  },
  
  // Read/unread tracking
  read: { type: Boolean, default: false },
  readAt: { type: Date },
  
  // Message delivery status
  status: {
    type: String,
    enum: ['draft', 'sent', 'delivered', 'read'],
    default: 'delivered',
    required: true
  },
  sentAt: { type: Date, default: Date.now },
  
  // Attachments
  attachments: [{
    filename: String,
    originalName: String,
    mimetype: String,
    size: Number,
    uploadedAt: { type: Date, default: Date.now }
  }],
  
  // Archiving per user
  archivedBySender: { type: Boolean, default: false },
  archivedByRecipient: { type: Boolean, default: false },
  deletedBySender: { type: Boolean, default: false },
  deletedByRecipient: { type: Boolean, default: false },
  
  // Soft delete
  deleted: { type: Boolean, default: false },
  deletedAt: { type: Date },
  
  // Timestamps
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

// Indexes for fast lookups
MessageSchema.index({ senderId: 1, createdAt: -1 });
MessageSchema.index({ recipientId: 1, createdAt: -1 });
MessageSchema.index({ conversationId: 1, createdAt: -1 });
MessageSchema.index({ caseId: 1, createdAt: -1 });
MessageSchema.index({ senderId: 1, recipientId: 1, conversationId: 1, createdAt: -1 });

module.exports = mongoose.model('Message', MessageSchema);
