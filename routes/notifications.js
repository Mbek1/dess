const express = require('express');
const mongoose = require('mongoose');
const Notification = require('../models/Notification');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();
router.use(authenticateToken);

router.get('/', async (req, res) => {
  try {
    if (!req.user?.id) return res.status(401).json({ error: 'Authentication required' });
    const limit = Math.min(Math.max(Number(req.query.limit) || 40, 1), 100);
    const unreadOnly = req.query.unread === 'true';
    const query = { recipientId: new mongoose.Types.ObjectId(req.user.id) };
    if (unreadOnly) query.readAt = null;
    const [notifications, unreadCount] = await Promise.all([
      Notification.find(query).sort({ createdAt: -1 }).limit(limit).lean(),
      Notification.countDocuments({ recipientId: query.recipientId, readAt: null })
    ]);
    res.json({ notifications, unreadCount });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load notifications' });
  }
});

router.patch('/read-all', async (req, res) => {
  try {
    if (!req.user?.id) return res.status(401).json({ error: 'Authentication required' });
    const result = await Notification.updateMany(
      { recipientId: new mongoose.Types.ObjectId(req.user.id), readAt: null },
      { $set: { readAt: new Date() } }
    );
    res.json({ success: true, updatedCount: result.modifiedCount });
  } catch (err) {
    res.status(500).json({ error: 'Failed to mark notifications as read' });
  }
});

router.patch('/:id/read', async (req, res) => {
  try {
    if (!req.user?.id) return res.status(401).json({ error: 'Authentication required' });
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: 'Notification not found' });
    const notification = await Notification.findOneAndUpdate(
      { _id: req.params.id, recipientId: new mongoose.Types.ObjectId(req.user.id) },
      { $set: { readAt: new Date() } },
      { new: true }
    );
    if (!notification) return res.status(404).json({ error: 'Notification not found' });
    res.json(notification);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update notification' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    if (!req.user?.id) return res.status(401).json({ error: 'Authentication required' });
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: 'Notification not found' });
    const result = await Notification.deleteOne({
      _id: req.params.id,
      recipientId: new mongoose.Types.ObjectId(req.user.id)
    });
    if (!result.deletedCount) return res.status(404).json({ error: 'Notification not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to dismiss notification' });
  }
});

module.exports = router;
