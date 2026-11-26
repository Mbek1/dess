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
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  password: { type: String, required: true },
  role: { type: String, enum: ['researcher', 'investigator', 'admin'], required: true },
  active: { type: Boolean, default: true },
  userType: { type: String, enum: ['student', 'researcher', null], default: null },
  organizationName: { type: String, default: '' },
  organizationRole: { type: String, default: '' },
  organizationIdNumber: { type: String, default: '' },
  profilePicture: { type: String, default: '' },
  avatarData: { type: Buffer, select: false },
  avatarContentType: { type: String, select: false },
  avatarUpdatedAt: { type: Date, select: false },
  emailVerified: { type: Boolean, default: false },
  verificationDocuments: {
    identity: { type: VerificationDocumentSchema, default: null },
    organization: { type: VerificationDocumentSchema, default: null }
  },
  // Kept temporarily for compatibility with older deployments. New sessions
  // store refresh-token hashes independently in UserSession documents.
  refreshToken: { type: String, default: '', select: false },
  mfaEnabled: { type: Boolean, default: false },
  mfaSecret: { type: String, select: false },
  mfaRecoveryCodes: { type: [String], select: false, default: [] }
}, { timestamps: true });

module.exports = mongoose.model('User', UserSchema);
