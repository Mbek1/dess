const mongoose = require('mongoose');

const policySchema = new mongoose.Schema({
  policyType: {
    type: String,
    enum: ['password', 'session', 'mfa', 'retention', 'audit', 'general'],
    unique: true,
    required: true
  },
  settings: mongoose.Schema.Types.Mixed,
  lastModifiedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  lastModifiedAt: {
    type: Date,
    default: Date.now
  },
  version: Number,
  active: {
    type: Boolean,
    default: true
  }
});

module.exports = mongoose.model('Policy', policySchema);
