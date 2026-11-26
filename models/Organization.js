const mongoose = require('mongoose');

const MembershipSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  userType: { type: String, enum: ['student', 'researcher'], default: 'researcher' },
  role: { type: String, enum: ['member', 'manager'], default: 'member' },
  status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
  requestedAt: { type: Date, default: Date.now },
  reviewedAt: { type: Date, default: null },
  reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
}, { _id: true });

const OrganizationSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 140 },
  normalizedName: { type: String, required: true, unique: true, index: true },
  type: { type: String, enum: ['university', 'research-institution', 'forensics-organization', 'government', 'private-organization', 'other'], default: 'other' },
  description: { type: String, default: '', maxlength: 1200 },
  website: { type: String, default: '', maxlength: 240 },
  location: { type: String, default: '', maxlength: 160 },
  verificationStatus: { type: String, enum: ['pending', 'verified', 'rejected'], default: 'pending' },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  members: { type: [MembershipSchema], default: [] }
}, { timestamps: true });

OrganizationSchema.index({ name: 'text', description: 'text', location: 'text' });

module.exports = mongoose.model('Organization', OrganizationSchema);
