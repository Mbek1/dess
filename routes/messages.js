const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const Message = require('../models/Message');
const User = require('../models/User');
const Case = require('../models/Case');
const CaseChat = require('../models/CaseChat');
const CaseChatMessage = require('../models/CaseChatMessage');
const { authenticateToken } = require('../middleware/auth');
const { syncCaseChatParticipants } = require('../utils/case-chat');
const { notifyCaseTeam } = require('../utils/notifications');

// Apply authentication middleware to all routes
router.use(authenticateToken);

// Helper function to generate conversation ID
function generateConversationId(userId1, userId2) {
  const ids = [userId1, userId2].map(id => id.toString()).sort();
  return `${ids[0]}-${ids[1]}`;
}

function isParticipant(message, userId) {
  return message.senderId.equals(userId) || message.recipientId.equals(userId);
}

function userMessageFilter(userId, view = 'all') {
  const archived = view === 'archived';
  const visible = view === 'inbox' ? ['recipient'] : view === 'sent' ? ['sender'] : ['sender', 'recipient'];
  const query = visible.map(side => {
    const isSender = side === 'sender';
    const participantField = isSender ? 'senderId' : 'recipientId';
    const archiveField = isSender ? 'archivedBySender' : 'archivedByRecipient';
    const deletedField = isSender ? 'deletedBySender' : 'deletedByRecipient';
    return {
      [participantField]: userId,
      [archiveField]: archived ? true : { $ne: true },
      [deletedField]: { $ne: true },
      deleted: { $ne: true }
    };
  });
  return { $or: query };
}

function hasCaseAccess(caseItem, user) {
  if (user.role === 'admin') return true;
  if (user.role === 'researcher') return caseItem.status === 'closed';
  if (user.role === 'investigator') {
    return caseItem.team.some(member => member.id?.toString() === user._id.toString());
  }
  return false;
}

async function getAuthorizedInvestigatorCase(caseId, user) {
  if (!user?.id || user.role !== 'investigator' || !mongoose.isValidObjectId(caseId)) return null;
  const caseItem = await Case.findById(caseId);
  if (!caseItem || !caseItem.team.some(member => member.id?.toString() === user.id)) return null;
  return caseItem;
}

// GET /api/messages/case-chats - list case rooms for the investigator's assigned cases
router.get('/case-chats', async (req, res) => {
  try {
    if (!req.user?.id) return res.status(401).json({ error: 'Authentication required' });
    if (req.user.role !== 'investigator') return res.status(403).json({ error: 'Case rooms are available to investigators only' });
    const userId = new mongoose.Types.ObjectId(req.user.id);
    const cases = await Case.find({ 'team.id': userId }).sort({ updatedAt: -1 }).limit(200);
    const chats = await Promise.all(cases.map(caseItem => syncCaseChatParticipants(caseItem, userId)));
    const validChats = chats.filter(Boolean);
    const rooms = await Promise.all(validChats.map(async chat => ({
      ...chat.toObject(),
      unreadCount: await CaseChatMessage.countDocuments({
        caseChatId: chat._id,
        senderId: { $ne: userId },
        'readBy.userId': { $ne: userId }
      })
    })));
    res.json(rooms.sort((a, b) => new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime()));
  } catch (err) {
    res.status(500).json({ error: 'Failed to load case rooms' });
  }
});

// GET /api/messages/case-chats/:caseId/messages - read a case room history
router.get('/case-chats/:caseId/messages', async (req, res) => {
  try {
    if (!req.user?.id) return res.status(401).json({ error: 'Authentication required' });
    const caseItem = await getAuthorizedInvestigatorCase(req.params.caseId, req.user);
    if (!caseItem) return res.status(403).json({ error: 'You are not assigned to this case' });
    const chat = await syncCaseChatParticipants(caseItem, req.user.id);
    const userId = new mongoose.Types.ObjectId(req.user.id);
    const unreadFilter = {
      caseChatId: chat._id,
      senderId: { $ne: userId },
      'readBy.userId': { $ne: userId }
    };
    await CaseChatMessage.updateMany(unreadFilter, { $push: { readBy: { userId, readAt: new Date() } } });
    const messages = await CaseChatMessage.find({ caseChatId: chat._id }).sort({ createdAt: 1 }).lean();
    res.json({ chat, messages });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load case conversation' });
  }
});

// POST /api/messages/case-chats/:caseId/messages - send a message to assigned investigators
router.post('/case-chats/:caseId/messages', async (req, res) => {
  try {
    if (!req.user?.id) return res.status(401).json({ error: 'Authentication required' });
    const caseItem = await getAuthorizedInvestigatorCase(req.params.caseId, req.user);
    if (!caseItem) return res.status(403).json({ error: 'You are not assigned to this case' });
    const content = typeof req.body.content === 'string' ? req.body.content.trim() : '';
    if (!content) return res.status(400).json({ error: 'Message content is required' });
    if (content.length > 10000) return res.status(400).json({ error: 'Message must be 10,000 characters or fewer' });

    const sender = await User.findById(req.user.id).select('name role');
    if (!sender || sender.role !== 'investigator') return res.status(403).json({ error: 'Investigator access required' });
    const chat = await syncCaseChatParticipants(caseItem, sender._id);
    const message = await CaseChatMessage.create({
      caseChatId: chat._id,
      caseId: caseItem._id,
      senderId: sender._id,
      senderName: sender.name,
      senderRole: sender.role,
      content
    });
    chat.lastMessage = content;
    chat.lastMessageAt = message.createdAt;
    await chat.save();
    await notifyCaseTeam(caseItem, {
      actorId: sender._id,
      actorName: sender.name,
      kind: 'CASE_CHAT_MESSAGE',
      title: 'New case-room message',
      body: `${sender.name} posted in ${caseItem.caseId}.`
    }, sender._id);
    res.status(201).json(message);
  } catch (err) {
    res.status(500).json({ error: 'Failed to send case-room message' });
  }
});

// GET /api/messages - get all messages for the user (inbox)
router.get('/', async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const userId = new mongoose.Types.ObjectId(req.user.id);
    const view = req.query.view === 'inbox' || req.query.view === 'sent' || req.query.view === 'archived'
      ? req.query.view
      : 'all';

    const messages = await Message.find(userMessageFilter(userId, view))
      .sort({ createdAt: -1 })
      .limit(100);

    res.json(messages);
  } catch (err) {
    console.error('Error fetching messages:', err);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

// GET /api/messages/unread-count - get count of unread messages
router.get('/unread-count', async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const userId = new mongoose.Types.ObjectId(req.user.id);
    const directUnreadCount = await Message.countDocuments({
      recipientId: userId,
      read: false,
      archivedByRecipient: { $ne: true },
      deletedByRecipient: { $ne: true },
      deleted: { $ne: true }
    });
    let caseChatUnreadCount = 0;
    if (req.user.role === 'investigator') {
      const chats = await CaseChat.find({ 'participants.userId': userId }).select('_id');
      caseChatUnreadCount = await CaseChatMessage.countDocuments({
        caseChatId: { $in: chats.map(chat => chat._id) },
        senderId: { $ne: userId },
        'readBy.userId': { $ne: userId }
      });
    }

    res.json({ unreadCount: directUnreadCount + caseChatUnreadCount, directUnreadCount, caseChatUnreadCount });
  } catch (err) {
    console.error('Error fetching unread count:', err);
    res.status(500).json({ error: 'Failed to fetch unread count' });
  }
});

// GET /api/messages/conversation/:userId - get conversation with specific user
router.get('/conversation/:userId', async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const currentUserId = new mongoose.Types.ObjectId(req.user.id);
    const otherUserId = new mongoose.Types.ObjectId(req.params.userId);
    const conversationId = generateConversationId(currentUserId, otherUserId);

    const messages = await Message.find({
      conversationId,
      $or: [
        { senderId: currentUserId, deletedBySender: { $ne: true } },
        { recipientId: currentUserId, deletedByRecipient: { $ne: true } }
      ],
      deleted: { $ne: true }
    }).sort({ createdAt: 1 });

    // Mark recipient messages as read
    await Message.updateMany(
      {
        conversationId,
        recipientId: currentUserId,
        read: false,
        deleted: { $ne: true },
        deletedByRecipient: { $ne: true }
      },
      { 
        read: true, 
        readAt: new Date(),
        status: 'read'
      }
    );

    res.json(messages);
  } catch (err) {
    console.error('Error fetching conversation:', err);
    res.status(500).json({ error: 'Failed to fetch conversation' });
  }
});

// GET /api/messages/:id - get single message
router.get('/:id', async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    const message = await Message.findById(req.params.id);
    if (!message || message.deleted) {
      return res.status(404).json({ error: 'Message not found' });
    }
    if (!isParticipant(message, req.user.id)) return res.status(404).json({ error: 'Message not found' });
    if ((message.senderId.toString() === req.user.id && message.deletedBySender) ||
        (message.recipientId.toString() === req.user.id && message.deletedByRecipient)) {
      return res.status(404).json({ error: 'Message not found' });
    }

    // Mark as read if recipient
    if (message.recipientId.toString() === req.user.id) {
      message.read = true;
      message.readAt = new Date();
      message.status = 'read';
      await message.save();
    }

    res.json(message);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch message' });
  }
});

// POST /api/messages - send a new message
router.post('/', async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    let { recipientId, subject, content, caseId, caseNumber, type = 'general', priority = 'normal', parentMessageId } = req.body;
    subject = typeof subject === 'string' ? subject.trim() : '';
    content = typeof content === 'string' ? content.trim() : '';
    if (!recipientId || !subject || !content) {
      return res.status(400).json({ error: 'Missing required fields: recipientId, subject, content' });
    }
    if (!mongoose.isValidObjectId(recipientId) || !mongoose.isValidObjectId(req.user.id)) {
      return res.status(400).json({ error: 'Invalid message participant' });
    }
    if (subject.length > 180 || content.length > 20000) {
      return res.status(400).json({ error: 'Subject or message body exceeds the allowed length' });
    }
    if (!['case-related', 'general', 'urgent', 'follow-up'].includes(type)) {
      return res.status(400).json({ error: 'Invalid message type' });
    }
    if (!['low', 'normal', 'high', 'urgent'].includes(priority)) {
      return res.status(400).json({ error: 'Invalid message priority' });
    }

    const senderObjId = new mongoose.Types.ObjectId(req.user.id);
    const recipientObjId = new mongoose.Types.ObjectId(recipientId);
    if (senderObjId.equals(recipientObjId)) {
      return res.status(400).json({ error: 'You cannot send a message to yourself' });
    }

    const [sender, recipient] = await Promise.all([
      User.findById(senderObjId),
      User.findById(recipientObjId)
    ]);
    if (!sender) {
      return res.status(401).json({ error: 'Authenticated sender not found' });
    }
    if (!recipient) {
      return res.status(404).json({ error: 'Recipient not found' });
    }

    const conversationId = generateConversationId(senderObjId, recipientObjId);

    let parentMessage;
    if (parentMessageId) {
      if (!mongoose.isValidObjectId(parentMessageId)) return res.status(400).json({ error: 'Invalid parent message' });
      parentMessage = await Message.findById(parentMessageId);
      if (!parentMessage || !isParticipant(parentMessage, senderObjId) || !isParticipant(parentMessage, recipientObjId)) {
        return res.status(404).json({ error: 'Conversation not found' });
      }
      if (parentMessage.conversationId !== conversationId) return res.status(400).json({ error: 'Reply must belong to the same conversation' });
      if (!caseId && parentMessage.caseId) caseId = parentMessage.caseId.toString();
      if (!caseNumber && parentMessage.caseNumber) caseNumber = parentMessage.caseNumber;
      if (parentMessage.subject && !subject.toLowerCase().startsWith('re:')) subject = `RE: ${parentMessage.subject}`;
    }

    let linkedCase;
    if (caseId) {
      if (!mongoose.isValidObjectId(caseId)) return res.status(400).json({ error: 'Invalid case reference' });
      linkedCase = await Case.findById(caseId);
    } else if (caseNumber) {
      linkedCase = await Case.findOne({ caseId: String(caseNumber).trim() });
    }
    if ((caseId || caseNumber) && !linkedCase) return res.status(404).json({ error: 'Linked case not found' });
    if (linkedCase) {
      const senderAssigned = sender.role === 'investigator' && linkedCase.team.some(member => member.id?.toString() === sender._id.toString());
      const recipientAssigned = recipient.role === 'investigator' && linkedCase.team.some(member => member.id?.toString() === recipient._id.toString());
      const hasResearcherParticipant = sender.role === 'researcher' || recipient.role === 'researcher';
      const caseTeamContactAllowed = linkedCase.status === 'open' && hasResearcherParticipant &&
        (sender.role === 'researcher' ? recipientAssigned : senderAssigned) &&
        (parentMessage
          ? isParticipant(parentMessage, senderObjId) && isParticipant(parentMessage, recipientObjId)
          : sender.role === 'researcher');
      if (!caseTeamContactAllowed && (!hasCaseAccess(linkedCase, sender) || !hasCaseAccess(linkedCase, recipient))) {
        return res.status(403).json({ error: 'Message participants must have access to the linked case' });
      }
    }

    const message = new Message({
      conversationId,
      parentMessageId: parentMessage?._id,
      senderId: senderObjId,
      senderName: sender.name,
      senderEmail: sender.email,
      senderRole: sender.role,
      recipientId: recipientObjId,
      recipientName: recipient.name,
      recipientEmail: recipient.email,
      recipientRole: recipient.role,
      subject,
      content,
      type,
      priority,
      status: 'delivered',
      sentAt: new Date(),
      ...(linkedCase && {
        caseId: linkedCase._id,
        caseNumber: linkedCase.caseId || String(linkedCase.number)
      })
    });

    await message.save();
    res.status(201).json(message);
  } catch (err) {
    console.error('Error sending message:', err);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// PATCH /api/messages/:id/read - mark message as read
router.patch('/:id/read', async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    const message = await Message.findById(req.params.id);
    if (!message || message.deleted) {
      return res.status(404).json({ error: 'Message not found' });
    }
    if (!message.recipientId.equals(req.user.id)) {
      return res.status(403).json({ error: 'Only the recipient can mark this message as read' });
    }
    if (message.deletedByRecipient) return res.status(404).json({ error: 'Message not found' });

    message.read = true;
    message.readAt = new Date();
    message.status = 'read';
    await message.save();

    res.json(message);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update message' });
  }
});

// PATCH /api/messages/conversation/:userId/archive - archive a conversation for the current user
router.patch('/conversation/:userId/archive', async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    if (!mongoose.isValidObjectId(req.params.userId)) return res.status(400).json({ error: 'Invalid conversation participant' });
    const userId = new mongoose.Types.ObjectId(req.user.id);
    const otherUserId = new mongoose.Types.ObjectId(req.params.userId);
    const conversationId = generateConversationId(userId, otherUserId);
    const participantFilter = { conversationId, deleted: { $ne: true }, $or: [{ senderId: userId }, { recipientId: userId }] };
    const existing = await Message.exists(participantFilter);
    if (!existing) return res.status(404).json({ error: 'Conversation not found' });
    await Message.updateMany({ conversationId, senderId: userId }, { archivedBySender: true });
    await Message.updateMany({ conversationId, recipientId: userId }, { archivedByRecipient: true });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to archive conversation' });
  }
});

// DELETE /api/messages/conversation/:userId - remove a conversation from the current user's view
router.delete('/conversation/:userId', async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    if (!mongoose.isValidObjectId(req.params.userId)) return res.status(400).json({ error: 'Invalid conversation participant' });
    const userId = new mongoose.Types.ObjectId(req.user.id);
    const otherUserId = new mongoose.Types.ObjectId(req.params.userId);
    const conversationId = generateConversationId(userId, otherUserId);
    const participantFilter = { conversationId, deleted: { $ne: true }, $or: [{ senderId: userId }, { recipientId: userId }] };
    const existing = await Message.exists(participantFilter);
    if (!existing) return res.status(404).json({ error: 'Conversation not found' });
    await Message.updateMany({ conversationId, senderId: userId }, { deletedBySender: true, deletedAt: new Date() });
    await Message.updateMany({ conversationId, recipientId: userId }, { deletedByRecipient: true, deletedAt: new Date() });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete conversation' });
  }
});

// PATCH /api/messages/:id/priority - set message priority
router.patch('/:id/priority', async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    const { priority } = req.body;
    
    if (!['low', 'normal', 'high', 'urgent'].includes(priority)) {
      return res.status(400).json({ error: 'Invalid priority level' });
    }

    const message = await Message.findById(req.params.id);
    if (!message) {
      return res.status(404).json({ error: 'Message not found' });
    }
    if (!message.senderId.equals(req.user.id)) return res.status(403).json({ error: 'Only the sender can change message priority' });
    message.priority = priority;
    await message.save();

    res.json(message);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update message priority' });
  }
});

// PATCH /api/messages/:id/type - set message type
router.patch('/:id/type', async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    const { type } = req.body;
    
    if (!['case-related', 'general', 'urgent', 'follow-up'].includes(type)) {
      return res.status(400).json({ error: 'Invalid message type' });
    }

    const message = await Message.findById(req.params.id);
    if (!message) {
      return res.status(404).json({ error: 'Message not found' });
    }
    if (!message.senderId.equals(req.user.id)) return res.status(403).json({ error: 'Only the sender can change message type' });
    message.type = type;
    await message.save();

    res.json(message);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update message type' });
  }
});

// PATCH /api/messages/:id/archive - archive a message (per user)
router.patch('/:id/archive', async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    const message = await Message.findById(req.params.id);
    if (!message || message.deleted) {
      return res.status(404).json({ error: 'Message not found' });
    }

    const userId = new mongoose.Types.ObjectId(req.user.id);
    
    if (message.senderId.toString() === userId.toString()) {
      message.archivedBySender = true;
    } else if (message.recipientId.toString() === userId.toString()) {
      message.archivedByRecipient = true;
    } else {
      return res.status(403).json({ error: 'Not authorized to archive this message' });
    }

    await message.save();
    res.json(message);
  } catch (err) {
    res.status(500).json({ error: 'Failed to archive message' });
  }
});

// DELETE /api/messages/:id - soft delete a message
router.delete('/:id', async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    const message = await Message.findById(req.params.id);
    if (!message || message.deleted) {
      return res.status(404).json({ error: 'Message not found' });
    }

    const userId = new mongoose.Types.ObjectId(req.user.id);
    
    // Only sender or recipient can delete
    if (message.senderId.toString() !== userId.toString() && message.recipientId.toString() !== userId.toString()) {
      return res.status(403).json({ error: 'Not authorized to delete this message' });
    }

    if (message.senderId.equals(userId)) {
      message.deletedBySender = true;
    } else if (message.recipientId.equals(userId)) {
      message.deletedByRecipient = true;
    } else {
      return res.status(404).json({ error: 'Message not found' });
    }
    if (!message.deletedAt) message.deletedAt = new Date();
    await message.save();

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete message' });
  }
});

module.exports = router;
