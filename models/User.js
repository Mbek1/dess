const mongoose = require('mongoose');

const VerificationDocumentSchema = new mongoose.Schema({
  filename: { type: String, required: true },
  originalName: { type: String, required: true },
  path: { type: String, required: true },
  mimeType: { type: String, required: true },
  size: { type: Number, required: true },
  status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
  uploadedAt: { type: Date, default: Date.now }
}, { _id: false });

const UserSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  role: { type: String, enum: ['researcher', 'investigator', 'admin'], required: true },
  organizationName: { type: String, default: '' },
  organizationRole: { type: String, default: '' },
  organizationIdNumber: { type: String, default: '' },
  profilePicture: { type: String, default: '' },
  emailVerified: { type: Boolean, default: false },
  verificationDocuments: {
    identity: { type: VerificationDocumentSchema, default: null },
    organization: { type: VerificationDocumentSchema, default: null }
  },
  refreshToken: { type: String, default: '' },
}, { timestamps: true });

module.exports = mongoose.model('User', UserSchema);