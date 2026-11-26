const express = require('express');
const mongoose = require('mongoose');
const Organization = require('../models/Organization');
const User = require('../models/User');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();
router.use(authenticateToken);

function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Authentication required' });
  next();
}
function isAdmin(req) { return req.user?.role === 'admin'; }
function publicOrganization(org, userId) {
  const membership = org.members.find(item => String(item.user) === String(userId));
  return {
    _id: org._id, name: org.name, type: org.type, description: org.description,
    website: org.website, location: org.location, verificationStatus: org.verificationStatus,
    memberCount: org.members.filter(item => item.status === 'approved').length,
    membershipStatus: membership?.status || 'none',
    canManage: Boolean(membership?.role === 'manager' && membership?.status === 'approved'),
    createdAt: org.createdAt
  };
}

// Search/browse organizations. Pending and verified organizations are visible; rejected ones are hidden.
router.get('/', requireUser, async (req, res) => {
  try {
    const search = String(req.query.search || '').trim().slice(0, 100);
    const type = String(req.query.type || '').trim();
    const query = { verificationStatus: { $in: ['pending', 'verified'] } };
    if (type) query.type = type;
    if (search) query.$or = [
      { name: { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } },
      { description: { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } },
      { location: { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } }
    ];
    const organizations = await Organization.find(query).sort({ verificationStatus: 1, name: 1 }).limit(100);
    res.json({ organizations: organizations.map(org => publicOrganization(org, req.user.id)) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load organizations' });
  }
});

// Create an organization. It remains pending until an administrator verifies it.
router.post('/', requireUser, async (req, res) => {
  try {
    if (!['researcher', 'investigator'].includes(req.user.role)) return res.status(403).json({ error: 'This account cannot create an organization.' });
    const name = String(req.body.name || '').trim();
    if (name.length < 3 || name.length > 140) return res.status(400).json({ error: 'Organization name must be between 3 and 140 characters.' });
    const normalizedName = name.toLocaleLowerCase().replace(/\s+/g, ' ');
    let org = await Organization.findOne({ normalizedName });
    if (org) return res.status(409).json({ error: 'An organization with this name already exists.', organization: publicOrganization(org, req.user.id) });
    const creator = await User.findById(req.user.id).select('userType');
    org = await Organization.create({
      name, normalizedName,
      type: ['university', 'research-institution', 'forensics-organization', 'government', 'private-organization', 'other'].includes(req.body.type) ? req.body.type : 'other',
      description: String(req.body.description || '').trim().slice(0, 1200),
      website: String(req.body.website || '').trim().slice(0, 240),
      location: String(req.body.location || '').trim().slice(0, 160),
      createdBy: req.user.id,
      members: [{ user: req.user.id, userType: creator?.userType || 'researcher', role: 'manager', status: 'approved' }]
    });
    await User.findByIdAndUpdate(req.user.id, { organizationId: org._id, organizationName: org.name });
    res.status(201).json({ organization: publicOrganization(org, req.user.id) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create organization' });
  }
});

// Request membership in an existing organization.
router.post('/:id/join', requireUser, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid organization ID' });
    const org = await Organization.findById(req.params.id);
    if (!org || org.verificationStatus === 'rejected') return res.status(404).json({ error: 'Organization not found' });
    const existing = org.members.find(item => String(item.user) === req.user.id);
    if (existing?.status === 'approved') return res.status(409).json({ error: 'You are already a member of this organization.' });
    if (existing?.status === 'pending') return res.status(409).json({ error: 'Your membership request is already pending.' });
    if (existing) {
      existing.status = 'pending'; existing.requestedAt = new Date(); existing.reviewedAt = null; existing.reviewedBy = null;
    } else {
      const user = await User.findById(req.user.id).select('userType');
      org.members.push({ user: req.user.id, userType: user?.userType || 'researcher', status: 'pending' });
    }
    await org.save();
    res.status(201).json({ membershipStatus: 'pending', message: 'Membership request submitted.' });
  } catch (err) {
    res.status(500).json({ error: 'Could not request organization membership' });
  }
});

// Organization managers review membership requests.
router.get('/:id/members', requireUser, async (req, res) => {
  try {
    const org = await Organization.findById(req.params.id).populate('members.user', 'name email role userType organizationRole');
    if (!org) return res.status(404).json({ error: 'Organization not found' });
    const manager = org.members.some(item => String(item.user?._id || item.user) === req.user.id && item.role === 'manager' && item.status === 'approved');
    if (!manager && !isAdmin(req)) return res.status(403).json({ error: 'Organization manager access required.' });
    res.json({ members: org.members.map(item => ({
      membershipId: item._id, user: item.user, userType: item.userType, role: item.role,
      status: item.status, requestedAt: item.requestedAt
    })) });
  } catch (err) { res.status(500).json({ error: 'Could not load organization members' }); }
});

router.patch('/:id/members/:membershipId', requireUser, async (req, res) => {
  try {
    const org = await Organization.findById(req.params.id);
    if (!org) return res.status(404).json({ error: 'Organization not found' });
    const manager = org.members.some(item => String(item.user) === req.user.id && item.role === 'manager' && item.status === 'approved');
    if (!manager && !isAdmin(req)) return res.status(403).json({ error: 'Organization manager access required.' });
    const member = org.members.id(req.params.membershipId);
    if (!member) return res.status(404).json({ error: 'Membership request not found' });
    const status = req.body.status;
    if (!['approved', 'rejected'].includes(status)) return res.status(400).json({ error: 'Status must be approved or rejected.' });
    member.status = status; member.reviewedAt = new Date(); member.reviewedBy = req.user.id;
    if (status === 'approved') {
      await User.findByIdAndUpdate(member.user, { organizationId: org._id, organizationName: org.name });
    } else {
      await User.updateOne({ _id: member.user, organizationId: org._id }, { $unset: { organizationId: 1 }, $set: { organizationName: '' } });
    }
    await org.save();
    res.json({ message: `Membership request ${status}.` });
  } catch (err) { res.status(500).json({ error: 'Could not update membership request' }); }
});

// Only administrators can verify an organization.
router.patch('/:id/verification', requireUser, async (req, res) => {
  try {
    if (!isAdmin(req)) return res.status(403).json({ error: 'Administrator access required.' });
    const status = req.body.status;
    if (!['verified', 'rejected', 'pending'].includes(status)) return res.status(400).json({ error: 'Invalid verification status.' });
    const org = await Organization.findByIdAndUpdate(req.params.id, { verificationStatus: status }, { new: true });
    if (!org) return res.status(404).json({ error: 'Organization not found' });
    res.json({ organization: publicOrganization(org, req.user.id) });
  } catch (err) { res.status(500).json({ error: 'Could not update organization verification' }); }
});

module.exports = router;
