const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();
const Case = require('../models/Case');
const User = require('../models/User');
const Notification = require('../models/Notification');
const RepositoryDiscussion = require('../models/RepositoryDiscussion');
const ResearchCollaborationRequest = require('../models/ResearchCollaborationRequest');
const { authenticateToken } = require('../middleware/auth');

router.use(authenticateToken);

function requireResearcher(req, res, next) {
  if (req.user?.role !== 'researcher') {
    return res.status(403).json({ error: 'Only researcher accounts can use repository collaboration.' });
  }
  next();
}
router.use(requireResearcher);

async function getClosedCase(caseId) {
  if (!mongoose.isValidObjectId(caseId)) return null;
  const caseItem = await Case.findById(caseId);
  return caseItem && caseItem.status === 'closed' && !['under_review', 'hidden'].includes(caseItem.repositoryStatus || 'visible') ? caseItem : null;
}

async function getActor(userId) {
  return User.findById(userId).select('name role userType organizationName active');
}

function authorView(item, currentUserId, profiles) {
  const userId = String(item.authorId);
  const profile = profiles.get(userId);
  return {
    _id: userId,
    name: item.authorName,
    userType: item.authorUserType || profile?.userType || null,
    organizationName: item.organizationName || profile?.organizationName || '',
    profilePicture: profile?.profilePicture || '',
    isMine: userId === String(currentUserId)
  };
}

function discussionView(item, currentUserId, profiles) {
  return {
    ...item,
    content: item.moderationStatus === 'hidden' ? 'This contribution is temporarily hidden by a moderator.' : item.content,
    isModerated: item.moderationStatus === 'hidden',
    author: authorView(item, currentUserId, profiles),
    isMine: String(item.authorId) === String(currentUserId),
    replies: (item.replies || []).map(reply => ({
      ...reply,
      content: reply.moderationStatus === 'hidden' ? 'This contribution is temporarily hidden by a moderator.' : reply.content,
      isModerated: reply.moderationStatus === 'hidden',
      author: authorView(reply, currentUserId, profiles),
      isMine: String(reply.authorId) === String(currentUserId)
    }))
  };
}

async function attachDiscussionProfiles(threads, currentUserId) {
  const all = threads.flatMap(thread => [thread, ...(thread.replies || [])]);
  const ids = [...new Set(all.map(item => String(item.authorId)))];
  const users = ids.length ? await User.find({ _id: { $in: ids } }).select('_id userType organizationName profilePicture').lean() : [];
  const profiles = new Map(users.map(user => [String(user._id), user]));
  return threads.map(thread => discussionView(thread, currentUserId, profiles));
}

// Return top-level researcher discussions with their replies for one closed case.
router.get('/cases/:caseId/discussions', async (req, res) => {
  try {
    const caseItem = await getClosedCase(req.params.caseId);
    if (!caseItem) return res.status(404).json({ error: 'Closed repository case not found' });
    const threads = await RepositoryDiscussion.find({
      caseId: caseItem._id,
      parentDiscussionId: null
    }).sort({ isPinned: -1, updatedAt: -1 }).limit(40).lean();

    if (!threads.length) return res.json({ discussions: [] });
    const threadIds = threads.map(item => item._id);
    const replies = await RepositoryDiscussion.find({
      caseId: caseItem._id,
      parentDiscussionId: { $in: threadIds }
    }).sort({ createdAt: 1 }).lean();
    const repliesByParent = new Map();
    for (const reply of replies) {
      const key = String(reply.parentDiscussionId);
      if (!repliesByParent.has(key)) repliesByParent.set(key, []);
      repliesByParent.get(key).push(reply);
    }
    const withReplies = threads.map(thread => ({
      ...thread,
      replies: repliesByParent.get(String(thread._id)) || []
    }));
    res.json({ discussions: await attachDiscussionProfiles(withReplies, req.user.id) });
  } catch (error) {
    res.status(500).json({ error: 'Could not load repository discussions' });
  }
});

// Create a case discussion or a one-level reply. Only closed cases are available.
router.post('/cases/:caseId/discussions', async (req, res) => {
  try {
    const caseItem = await getClosedCase(req.params.caseId);
    if (!caseItem) return res.status(404).json({ error: 'Closed repository case not found' });
    const content = typeof req.body?.content === 'string' ? req.body.content.trim() : '';
    if (!content) return res.status(400).json({ error: 'Discussion content is required' });
    if (content.length > 5000) return res.status(400).json({ error: 'Discussion content must be 5,000 characters or fewer' });

    let parent = null;
    if (req.body?.parentDiscussionId) {
      if (!mongoose.isValidObjectId(req.body.parentDiscussionId)) return res.status(400).json({ error: 'Invalid discussion reply reference' });
      parent = await RepositoryDiscussion.findOne({
        _id: req.body.parentDiscussionId,
        caseId: caseItem._id,
        parentDiscussionId: null,
        isDeleted: false,
        moderationStatus: { $ne: 'hidden' }
      });
      if (!parent) return res.status(404).json({ error: 'Discussion thread not found' });
    }

    const actor = await getActor(req.user.id);
    if (!actor || actor.active === false || actor.role !== 'researcher') return res.status(403).json({ error: 'Active researcher account required' });
    const discussion = await RepositoryDiscussion.create({
      caseId: caseItem._id,
      authorId: actor._id,
      authorName: actor.name,
      authorUserType: actor.userType || null,
      organizationName: actor.organizationName || '',
      content,
      parentDiscussionId: parent?._id || null
    });

    if (parent && String(parent.authorId) !== String(actor._id)) {
      await Notification.create({
        recipientId: parent.authorId,
        actorId: actor._id,
        actorName: actor.name,
        kind: 'REPOSITORY_DISCUSSION_REPLY',
        title: 'New reply to your repository discussion',
        body: `${actor.name} replied to a discussion on ${caseItem.caseId}.`,
        caseId: caseItem._id,
        caseNumber: caseItem.caseId,
        link: '/researcher'
      });
    }

    res.status(201).json({ discussion: discussion.toObject() });
  } catch (error) {
    res.status(500).json({ error: 'Could not post repository discussion' });
  }
});

// A thread author may pin/unpin their own discussion; replies cannot be pinned.
router.patch('/discussions/:discussionId/pin', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.discussionId)) return res.status(404).json({ error: 'Discussion not found' });
    const discussion = await RepositoryDiscussion.findOne({
      _id: req.params.discussionId,
      parentDiscussionId: null,
      isDeleted: false,
      moderationStatus: { $ne: 'hidden' },
      authorId: req.user.id
    });
    if (!discussion) return res.status(404).json({ error: 'Only the author can pin their own discussion thread' });
    const isPinned = req.body?.isPinned === true;
    discussion.isPinned = isPinned;
    discussion.pinnedBy = isPinned ? req.user.id : null;
    discussion.pinnedAt = isPinned ? new Date() : null;
    await discussion.save();
    res.json({ discussion });
  } catch (error) {
    res.status(500).json({ error: 'Could not update discussion pin' });
  }
});

// Authors may remove their own posts. A placeholder remains so replies keep their thread context.
router.delete('/discussions/:discussionId', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.discussionId)) return res.status(404).json({ error: 'Discussion not found' });
    const discussion = await RepositoryDiscussion.findOne({
      _id: req.params.discussionId,
      authorId: req.user.id,
      isDeleted: false,
      moderationStatus: { $ne: 'hidden' }
    });
    if (!discussion) return res.status(404).json({ error: 'Discussion not found' });
    discussion.isDeleted = true;
    discussion.deletedAt = new Date();
    discussion.content = 'This discussion was removed by its author.';
    discussion.isPinned = false;
    discussion.pinnedBy = null;
    discussion.pinnedAt = null;
    await discussion.save();
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Could not remove discussion' });
  }
});

// Invite a researcher who has already contributed to this closed case.
router.post('/cases/:caseId/collaboration-requests', async (req, res) => {
  try {
    const caseItem = await getClosedCase(req.params.caseId);
    if (!caseItem) return res.status(404).json({ error: 'Closed repository case not found' });
    const recipientId = String(req.body?.recipientId || '');
    if (!mongoose.isValidObjectId(recipientId)) return res.status(400).json({ error: 'Choose a valid researcher to invite' });
    if (recipientId === String(req.user.id)) return res.status(400).json({ error: 'You cannot invite yourself' });

    const [actor, recipient] = await Promise.all([
      getActor(req.user.id),
      User.findOne({ _id: recipientId, role: 'researcher', active: { $ne: false } }).select('name role userType organizationName')
    ]);
    if (!actor || actor.active === false || actor.role !== 'researcher') return res.status(403).json({ error: 'Active researcher account required' });
    if (!recipient) return res.status(404).json({ error: 'Research collaborator not found' });
    const hasContributed = await RepositoryDiscussion.exists({
      caseId: caseItem._id,
      authorId: recipient._id,
      isDeleted: false,
      moderationStatus: { $ne: 'hidden' }
    });
    if (!hasContributed) return res.status(403).json({ error: 'You can invite researchers who have participated in this case discussion' });

    const pending = await ResearchCollaborationRequest.findOne({
      caseId: caseItem._id,
      fromUser: actor._id,
      toUser: recipient._id,
      status: 'pending'
    });
    if (pending) return res.status(409).json({ error: 'A collaboration request is already pending for this researcher' });

    const request = await ResearchCollaborationRequest.create({
      caseId: caseItem._id,
      caseNumber: caseItem.caseId,
      caseTitle: caseItem.name,
      fromUser: actor._id,
      toUser: recipient._id,
      fromName: actor.name,
      toName: recipient.name,
      fromUserType: actor.userType || null,
      toUserType: recipient.userType || null,
      message: String(req.body?.message || '').trim().slice(0, 1000)
    });
    await Notification.create({
      recipientId: recipient._id,
      actorId: actor._id,
      actorName: actor.name,
      kind: 'RESEARCH_COLLABORATION_REQUEST',
      title: 'Research collaboration invitation',
      body: `${actor.name} invited you to collaborate on ${caseItem.caseId}.`,
      caseId: caseItem._id,
      caseNumber: caseItem.caseId,
      link: '/research-workspace?tab=collaborations'
    });
    res.status(201).json({ request });
  } catch (error) {
    res.status(500).json({ error: 'Could not send collaboration request' });
  }
});

router.get('/collaboration-requests', async (req, res) => {
  try {
    const requests = await ResearchCollaborationRequest.find({
      $or: [{ fromUser: req.user.id }, { toUser: req.user.id }]
    }).sort({ createdAt: -1 }).limit(100).lean();
    res.json({
      requests: requests.map(item => ({
        ...item,
        fromUser: { _id: String(item.fromUser), name: item.fromName, userType: item.fromUserType },
        toUser: { _id: String(item.toUser), name: item.toName, userType: item.toUserType },
        direction: String(item.toUser) === String(req.user.id) ? 'received' : 'sent'
      }))
    });
  } catch (error) {
    res.status(500).json({ error: 'Could not load collaboration requests' });
  }
});

router.patch('/collaboration-requests/:requestId/respond', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.requestId)) return res.status(404).json({ error: 'Collaboration request not found' });
    const status = req.body?.status;
    if (!['accepted', 'declined'].includes(status)) return res.status(400).json({ error: 'Choose accepted or declined' });
    const request = await ResearchCollaborationRequest.findOne({
      _id: req.params.requestId,
      toUser: req.user.id,
      status: 'pending'
    });
    if (!request) return res.status(404).json({ error: 'Pending collaboration request not found' });
    request.status = status;
    request.responseMessage = String(req.body?.responseMessage || '').trim().slice(0, 1000);
    request.respondedAt = new Date();
    await request.save();

    await Notification.create({
      recipientId: request.fromUser,
      actorId: req.user.id,
      actorName: request.toName,
      kind: 'RESEARCH_COLLABORATION_RESPONSE',
      title: `Collaboration invitation ${status}`,
      body: `${request.toName} ${status} your invitation for ${request.caseNumber}.`,
      caseId: request.caseId,
      caseNumber: request.caseNumber,
      link: '/research-workspace?tab=collaborations'
    });
    res.json({ request });
  } catch (error) {
    res.status(500).json({ error: 'Could not respond to collaboration request' });
  }
});

router.patch('/collaboration-requests/:requestId/cancel', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.requestId)) return res.status(404).json({ error: 'Collaboration request not found' });
    const request = await ResearchCollaborationRequest.findOne({
      _id: req.params.requestId,
      fromUser: req.user.id,
      status: 'pending'
    });
    if (!request) return res.status(404).json({ error: 'Pending collaboration request not found' });
    request.status = 'cancelled';
    request.cancelledAt = new Date();
    await request.save();
    res.json({ request });
  } catch (error) {
    res.status(500).json({ error: 'Could not cancel collaboration request' });
  }
});

module.exports = router;
