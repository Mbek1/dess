const mongoose = require('mongoose');

const FeedbackSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  userName: { type: String, trim: true, maxlength: 120 },
  userEmail: { type: String, trim: true, lowercase: true, maxlength: 254 },
  category: {
    type: String,
    enum: ['bug', 'feature-request', 'usability', 'general'],
    required: true
  },
  rating: { type: Number, min: 1, max: 5 },
  subject: { type: String, required: true, trim: true, maxlength: 150 },
  message: { type: String, required: true, trim: true, maxlength: 5000 },
  status: {
    type: String,
    enum: ['new', 'in-review', 'resolved'],
    default: 'new',
    index: true
  }
}, { timestamps: true });

FeedbackSchema.index({ createdAt: -1 });

module.exports = mongoose.model('Feedback', FeedbackSchema);
