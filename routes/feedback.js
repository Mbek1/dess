const express = require('express');
const mongoose = require('mongoose');
const Feedback = require('../models/Feedback');
const User = require('../models/User');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();
router.use(authenticateToken);

// Submit feedback. Every submission is tied to the authenticated account.
router.post('/', async (req, res) => {
  try {
    if (!req.user?.id || !mongoose.isValidObjectId(req.user.id)) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const category = typeof req.body.category === 'string' ? req.body.category : '';
    const subject = typeof req.body.subject === 'string' ? req.body.subject.trim() : '';
    const message = typeof req.body.message === 'string' ? req.body.message.trim() : '';
    const rating = req.body.rating === '' || req.body.rating == null ? undefined : Number(req.body.rating);
    const allowedCategories = ['bug', 'feature-request', 'usability', 'general'];

    if (!allowedCategories.includes(category)) {
      return res.status(400).json({ error: 'Choose a valid feedback category' });
    }
    if (!subject || subject.length > 150) {
      return res.status(400).json({ error: 'Subject is required and must be 150 characters or fewer' });
    }
    if (!message || message.length > 5000) {
      return res.status(400).json({ error: 'Feedback is required and must be 5,000 characters or fewer' });
    }
    if (rating !== undefined && (!Number.isInteger(rating) || rating < 1 || rating > 5)) {
      return res.status(400).json({ error: 'Rating must be between 1 and 5' });
    }

    const user = await User.findById(req.user.id).select('name email');
    if (!user) return res.status(401).json({ error: 'Authenticated user not found' });

    const feedback = await Feedback.create({
      userId: user._id,
      userName: user.name,
      userEmail: user.email,
      category,
      rating,
      subject,
      message
    });

    return res.status(201).json({
      message: 'Thank you. Your feedback has been submitted.',
      feedbackId: feedback._id
    });
  } catch (err) {
    console.error('Feedback submission failed:', err);
    return res.status(500).json({ error: 'Failed to submit feedback' });
  }
});

// Admin-only feedback inbox.
router.get('/', async (req, res) => {
  try {
    if (!req.user?.id) return res.status(401).json({ error: 'Authentication required' });
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Administrator access required' });

    const page = Math.max(Number.parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 20, 1), 100);
    const filter = {};
    if (['new', 'in-review', 'resolved'].includes(req.query.status)) filter.status = req.query.status;

    const [feedback, total] = await Promise.all([
      Feedback.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      Feedback.countDocuments(filter)
    ]);

    return res.json({ feedback, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (err) {
    console.error('Feedback retrieval failed:', err);
    return res.status(500).json({ error: 'Failed to retrieve feedback' });
  }
});

// Admin-only status update.
router.patch('/:id/status', async (req, res) => {
  try {
    if (!req.user?.id) return res.status(401).json({ error: 'Authentication required' });
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Administrator access required' });
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: 'Feedback not found' });
    if (!['new', 'in-review', 'resolved'].includes(req.body.status)) {
      return res.status(400).json({ error: 'Invalid feedback status' });
    }

    const item = await Feedback.findByIdAndUpdate(
      req.params.id,
      { $set: { status: req.body.status } },
      { new: true, runValidators: true }
    );
    if (!item) return res.status(404).json({ error: 'Feedback not found' });
    return res.json(item);
  } catch (err) {
    console.error('Feedback status update failed:', err);
    return res.status(500).json({ error: 'Failed to update feedback status' });
  }
});

module.exports = router;
