const mongoose = require('mongoose');

const BookmarkSchema = new mongoose.Schema({
  caseId: { type: mongoose.Schema.Types.ObjectId, ref: 'Case', required: true },
  evidenceId: { type: mongoose.Schema.Types.ObjectId, default: null },
  caseReference: { type: String, default: '' },
  caseTitle: { type: String, default: '' },
  evidenceName: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now }
});

const NoteSchema = new mongoose.Schema({
  caseId: { type: mongoose.Schema.Types.ObjectId, ref: 'Case', required: true },
  evidenceId: { type: mongoose.Schema.Types.ObjectId, default: null },
  caseReference: { type: String, default: '' },
  caseTitle: { type: String, default: '' },
  evidenceName: { type: String, default: '' },
  title: { type: String, required: true, trim: true, maxlength: 160 },
  content: { type: String, required: true, trim: true, maxlength: 12000 },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

const CollectionSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 100 },
  description: { type: String, trim: true, maxlength: 500, default: '' },
  caseIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Case' }],
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

const ResearchWorkspaceSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true, index: true },
  bookmarks: { type: [BookmarkSchema], default: [] },
  notes: { type: [NoteSchema], default: [] },
  collections: { type: [CollectionSchema], default: [] }
}, { timestamps: true });

module.exports = mongoose.model('ResearchWorkspace', ResearchWorkspaceSchema);
