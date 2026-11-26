const mongoose = require('mongoose');

const RepositoryDiscussionSchema = new mongoose.Schema({
  caseId: { type: mongoose.Schema.Types.ObjectId, ref: 'Case', required: true, index: true },
  authorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  authorName: { type: String, required: true, trim: true, maxlength: 120 },
  authorUserType: { type: String, enum: ['student', 'researcher', null], default: null },
  organizationName: { type: String, default: '', trim: true, maxlength: 140 },
  content: { type: String, required: true, trim: true, maxlength: 5000 },
  parentDiscussionId: { type: mongoose.Schema.Types.ObjectId, ref: 'RepositoryDiscussion', default: null, index: true },
  isPinned: { type: Boolean, default: false, index: true },
  pinnedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  pinnedAt: { type: Date, default: null },
  moderationStatus: { type: String, enum: ['visible', 'hidden'], default: 'visible', index: true },
  moderationReason: { type: String, default: '', maxlength: 1200 },
  moderatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  moderatedAt: { type: Date, default: null },
  isDeleted: { type: Boolean, default: false },
  deletedAt: { type: Date, default: null }
}, { timestamps: true });

RepositoryDiscussionSchema.index({ caseId: 1, parentDiscussionId: 1, isPinned: -1, createdAt: -1 });
RepositoryDiscussionSchema.index({ caseId: 1, authorId: 1, createdAt: -1 });

module.exports = mongoose.model('RepositoryDiscussion', RepositoryDiscussionSchema);
