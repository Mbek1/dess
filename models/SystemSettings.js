const mongoose = require('mongoose');

const systemSettingsSchema = new mongoose.Schema({
  settingKey: {
    type: String,
    unique: true,
    required: true
  },
  settingValue: mongoose.Schema.Types.Mixed,
  description: String,
  category: {
    type: String,
    enum: ['backup', 'logging', 'email', 'storage', 'security', 'integration']
  },
  lastModifiedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  lastModifiedAt: {
    type: Date,
    default: Date.now
  }
});

module.exports = mongoose.model('SystemSettings', systemSettingsSchema);
