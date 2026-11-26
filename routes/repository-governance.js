const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();

const { authenticateToken } = require('../middleware/auth');
const Case = require('../models/Case');
const User = require('../models/User');
const Notification = require('../models/Notification');
const RepositoryDiscussion = require('../models/RepositoryDiscussion');
const RepositoryAccessRequest = require('../models/RepositoryAccessRequest');
const RepositoryModerationReport = require('../models/RepositoryModerationReport');

router.use(authenticateToken);

const reportCategories = [
  'inaccurate_information', 'privacy_concern', 'sensitive_information',
  'inappropriate_content', 'copyright_concern', 'other'
];

function isAdmin(req) { return req.user?.role === 'admin'; }
function isResearcher(req) { return req.user?.role === 'researcher'; }
function isInvestigator(req) { return req.user?.role === 'investigator'; }
function isRepositoryCaseVisible(caseItem) {
  return Boolean(caseItem && caseItem.status === 'closed' &&
    !['under_review', 'hidden'].includes(caseItem.repositoryStatus || 'visible'));
}
function hasResearcherEvidenceAccess(evidence, userId) {
  return evidence.visibleToResearchers === true ||
    (evidence.researcherAccessIds || []).some(id => String(id?._id || id) === String(userId));
}
function isAssigned(caseItem, userId) {
  return caseItem.team.some(member => String(member.id?._id || member.id) === String(userId));
}
function objectId(value) { return mongoose.isValidObjectId(value); }

async function notifyUser(recipientId, actorId, actorName, kind, title, body, caseItem) {
  if (!recipientId) return;
  try {
    await Notification.create({
      recipientId, actorId, actorName, kind, title, body,
      caseId: caseItem?._id, caseNumber: caseItem?.caseId,
      link: kind === 'REPOSITORY_ACCESS_REQUEST' ? '/repository-access-requests' : '/researcher'
    });
  } catch (error) {
    // Notification failures must not roll back a permission or moderation decision.
    console.error('Repository governance notification failed:', error.message);
  }
}

function appendCaseAudit(caseItem, actor, action, description, details = {}) {
  caseItem.auditLog.push({
    action,
    type: 'repository_governance',
    description,
    performedBy: { userId: actor._id, name: actor.name, email: actor.email },
    details
  });
}

// A researcher requests access to additional material without seeing restricted item names.
// The assigned investigator selects the exact evidence items that may be released to that researcher.
router.post('/access-requests/:caseId', async (req, res) => {
  try {
    if (!isResearcher(req)) return res.status(403).json({ error: 'Only researchers can request repository evidence access.' });
    if (!objectId(req.params.caseId)) return res.status(400).json({ error: 'Invalid case reference.' });
    const purpose = typeof req.body?.purpose === 'string' ? req.body.purpose.trim() : '';
    if (purpose.length < 20 || purpose.length > 2000) {
      return res.status(400).json({ error: 'Explain your research purpose in 20 to 2,000 characters.' });
    }

    const [caseItem, requester] = await Promise.all([
      Case.findById(req.params.caseId),
      User.findById(req.user.id).select('name role userType organizationName active')
    ]);
    if (!isRepositoryCaseVisible(caseItem)) return res.status(404).json({ error: 'Repository case not found.' });
    if (!requester || requester.active === false || requester.role !== 'researcher') {
      return res.status(403).json({ error: 'An active researcher account is required.' });
    }

    const restrictedItems = caseItem.evidence.filter(item =>
      !item.deleted && !hasResearcherEvidenceAccess(item, requester._id) &&
      item.deletionRequest?.status !== 'pending'
    );
    if (!restrictedItems.length) return res.status(409).json({ error: 'There is no additional evidence available to request for this case.' });

    const existing = await RepositoryAccessRequest.findOne({
      caseId: caseItem._id, requesterId: requester._id, status: 'pending'
    });
    if (existing) return res.status(409).json({ error: 'You already have a pending request for this case.', request: existing });

    const accessRequest = await RepositoryAccessRequest.create({
      caseId: caseItem._id,
      caseNumber: caseItem.caseId,
      caseTitle: caseItem.name,
      requesterId: requester._id,
      requesterName: requester.name,
      requesterUserType: requester.userType || null,
      requesterOrganization: requester.organizationName || '',
      purpose
    });

    const investigatorIds = [...new Set(caseItem.team.map(member => String(member.id)).filter(Boolean))];
    await Promise.allSettled(investigatorIds.map(id => notifyUser(
      id, requester._id, requester.name, 'REPOSITORY_ACCESS_REQUEST',
      'Research evidence access requested',
      `${requester.name} requested additional evidence access for ${caseItem.caseId}.`,
      caseItem
    )));

    res.status(201).json({ request: accessRequest, message: 'Your request was sent to the assigned case team.' });
  } catch (error) {
    console.error('Repository evidence access request failed:', error.message);
    res.status(500).json({ error: 'Could not submit the evidence access request.' });
  }
});

router.get('/access-requests/mine', async (req, res) => {
  try {
    if (!isResearcher(req)) return res.status(403).json({ error: 'Only researchers can view their access requests.' });
    const requests = await RepositoryAccessRequest.find({ requesterId: req.user.id })
      .sort({ createdAt: -1 }).limit(100).lean();
    res.json({ requests });
  } catch (error) {
    res.status(500).json({ error: 'Could not load your evidence access requests.' });
  }
});

router.patch('/access-requests/:requestId/cancel', async (req, res) => {
  try {
    if (!isResearcher(req)) return res.status(403).json({ error: 'Only researchers can cancel their access requests.' });
    if (!objectId(req.params.requestId)) return res.status(404).json({ error: 'Access request not found.' });
    const request = await RepositoryAccessRequest.findOne({
      _id: req.params.requestId, requesterId: req.user.id, status: 'pending'
    });
    if (!request) return res.status(404).json({ error: 'Pending access request not found.' });
    request.status = 'cancelled';
    request.cancelledAt = new Date();
    await request.save();
    res.json({ request });
  } catch (error) {
    res.status(500).json({ error: 'Could not cancel the access request.' });
  }
});

// Investigator inbox is limited to closed cases to which the current investigator is assigned.
router.get('/access-requests/inbox', async (req, res) => {
  try {
    if (!isInvestigator(req)) return res.status(403).json({ error: 'Investigator access required.' });
    const assignedCases = await Case.find({ 'team.id': req.user.id, status: 'closed' })
      .select('_id caseId name status repositoryStatus evidence');
    const caseById = new Map(assignedCases.map(item => [String(item._id), item]));
    const requests = await RepositoryAccessRequest.find({
      caseId: { $in: assignedCases.filter(isRepositoryCaseVisible).map(item => item._id) },
      status: 'pending'
    }).sort({ createdAt: 1 }).limit(200).lean();

    res.json({
      requests: requests.map(request => {
        const caseItem = caseById.get(String(request.caseId));
        const restrictedEvidence = (caseItem?.evidence || []).filter(item =>
          !item.deleted && item.visibleToResearchers !== true &&
          !(item.researcherAccessIds || []).some(id => String(id) === String(request.requesterId)) &&
          item.deletionRequest?.status !== 'pending'
        ).map(item => ({
          _id: item._id, name: item.name, description: item.description,
          type: item.type, format: item.format, fileSize: item.fileSize, uploadedAt: item.uploadedAt
        }));
        return { ...request, restrictedEvidence };
      })
    });
  } catch (error) {
    res.status(500).json({ error: 'Could not load pending evidence access requests.' });
  }
});

// The investigator chooses exact items; approval creates a requester-specific grant.
// It never makes the selected material globally visible to all researchers.
router.patch('/access-requests/:requestId/review', async (req, res) => {
  try {
    if (!isInvestigator(req)) return res.status(403).json({ error: 'Investigator access required.' });
    if (!objectId(req.params.requestId)) return res.status(404).json({ error: 'Access request not found.' });
    const decision = req.body?.decision;
    if (!['approved', 'declined'].includes(decision)) return res.status(400).json({ error: 'Choose approved or declined.' });
    const decisionNote = typeof req.body?.decisionNote === 'string' ? req.body.decisionNote.trim().slice(0, 1200) : '';
    const evidenceIds = Array.isArray(req.body?.evidenceIds) ? req.body.evidenceIds : [];
    if (decision === 'approved' && (!evidenceIds.length || evidenceIds.length > 100)) {
      return res.status(400).json({ error: 'Select at least one evidence item to approve.' });
    }
    if (decision === 'declined' && decisionNote.length < 5) {
      return res.status(400).json({ error: 'Add a short reason when declining an access request.' });
    }
    if (evidenceIds.some(id => !objectId(id)) || new Set(evidenceIds.map(String)).size !== evidenceIds.length) {
      return res.status(400).json({ error: 'The evidence selection contains an invalid or duplicate item.' });
    }

    const accessRequest = await RepositoryAccessRequest.findOne({ _id: req.params.requestId, status: 'pending' });
    if (!accessRequest) return res.status(404).json({ error: 'Pending access request not found.' });
    const [caseItem, actor] = await Promise.all([
      Case.findById(accessRequest.caseId),
      User.findById(req.user.id).select('name email role active')
    ]);
    if (!caseItem || !isAssigned(caseItem, req.user.id)) return res.status(403).json({ error: 'You are not assigned to this case.' });
    if (!isRepositoryCaseVisible(caseItem)) return res.status(409).json({ error: 'The case is no longer available in the research archive.' });
    if (!actor || actor.active === false) return res.status(403).json({ error: 'An active investigator account is required.' });

    const approvedNames = [];
    if (decision === 'approved') {
      for (const evidenceId of evidenceIds) {
        const evidence = caseItem.evidence.id(evidenceId);
        if (!evidence || evidence.deleted || evidence.visibleToResearchers === true ||
            evidence.deletionRequest?.status === 'pending') {
          return res.status(400).json({ error: 'One or more selected items are no longer eligible for individual research access.' });
        }
      }
      for (const evidenceId of evidenceIds) {
        const evidence = caseItem.evidence.id(evidenceId);
        const alreadyGranted = (evidence.researcherAccessIds || []).some(id => String(id) === String(accessRequest.requesterId));
        if (!alreadyGranted) evidence.researcherAccessIds.push(accessRequest.requesterId);
        approvedNames.push(evidence.name);
        caseItem.auditLog.push({
          action: 'REPOSITORY_ACCESS_APPROVED',
          type: 'access_control',
          filename: evidence.filename,
          description: `Individual research access approved for ${accessRequest.requesterName} to evidence "${evidence.name}"`,
          performedBy: { userId: actor._id, name: actor.name, email: actor.email },
          details: { researcherId: String(accessRequest.requesterId), accessRequestId: String(accessRequest._id) }
        });
      }
    }

    accessRequest.status = decision;
    accessRequest.decisionNote = decisionNote;
    accessRequest.approvedEvidenceIds = decision === 'approved' ? evidenceIds : [];
    accessRequest.reviewedBy = actor._id;
    accessRequest.reviewedByName = actor.name;
    accessRequest.reviewedAt = new Date();
    appendCaseAudit(caseItem, actor, 'REPOSITORY_ACCESS_REQUEST_REVIEWED',
      `Evidence access request from ${accessRequest.requesterName} was ${decision}`,
      { requestId: String(accessRequest._id), decision, evidenceCount: approvedNames.length, decisionNote });
    await Promise.all([caseItem.save(), accessRequest.save()]);

    await notifyUser(
      accessRequest.requesterId, actor._id, actor.name, 'REPOSITORY_ACCESS_RESPONSE',
      `Research evidence access request ${decision}`,
      decision === 'approved'
        ? `Your request for ${accessRequest.caseNumber} was approved for ${approvedNames.length} selected evidence item(s).`
        : `Your request for ${accessRequest.caseNumber} was declined. ${decisionNote}`,
      caseItem
    );
    res.json({ request: accessRequest, approvedEvidenceCount: approvedNames.length });
  } catch (error) {
    console.error('Repository access review failed:', error.message);
    res.status(500).json({ error: 'Could not review the evidence access request.' });
  }
});

// Researchers can report a case or a discussion contribution.
router.post('/reports', async (req, res) => {
  try {
    if (!isResearcher(req)) return res.status(403).json({ error: 'Only researchers can submit repository reports.' });
    const targetType = req.body?.targetType;
    const targetId = String(req.body?.targetId || '');
    const category = req.body?.category;
    const description = typeof req.body?.description === 'string' ? req.body.description.trim() : '';
    if (!['case', 'discussion'].includes(targetType) || !objectId(targetId)) {
      return res.status(400).json({ error: 'Choose a valid case or contribution to report.' });
    }
    if (!reportCategories.includes(category)) return res.status(400).json({ error: 'Choose a valid report category.' });
    if (description.length < 10 || description.length > 2000) {
      return res.status(400).json({ error: 'Describe the concern in 10 to 2,000 characters.' });
    }

    let caseItem, target;
    if (targetType === 'case') {
      caseItem = await Case.findById(targetId);
      if (!isRepositoryCaseVisible(caseItem)) return res.status(404).json({ error: 'Repository case not found.' });
      target = caseItem;
    } else {
      target = await RepositoryDiscussion.findById(targetId);
      if (!target || target.isDeleted || target.moderationStatus === 'hidden') return res.status(404).json({ error: 'Contribution not found.' });
      caseItem = await Case.findById(target.caseId);
      if (!isRepositoryCaseVisible(caseItem)) return res.status(404).json({ error: 'Repository case not found.' });
      if (String(target.authorId) === String(req.user.id)) return res.status(400).json({ error: 'You cannot report your own contribution.' });
    }

    const existing = await RepositoryModerationReport.findOne({
      targetType, targetId, reporterId: req.user.id,
      status: { $in: ['pending', 'in_review'] }
    });
    if (existing) return res.status(409).json({ error: 'You already have an open report for this item.' });

    const reporter = await User.findById(req.user.id).select('name active role');
    if (!reporter || reporter.active === false) return res.status(403).json({ error: 'An active researcher account is required.' });
    const report = await RepositoryModerationReport.create({
      targetType, targetId, caseId: caseItem._id,
      caseNumber: caseItem.caseId, caseTitle: caseItem.name,
      reporterId: reporter._id, reporterName: reporter.name,
      category, description
    });
    res.status(201).json({ report, message: 'Your report has been sent to the moderation team.' });
  } catch (error) {
    console.error('Repository report submission failed:', error.message);
    res.status(500).json({ error: 'Could not submit the repository report.' });
  }
});

// Administrative repository governance endpoints.
router.get('/admin/summary', async (req, res) => {
  try {
    if (!isAdmin(req)) return res.status(403).json({ error: 'Administrator access required.' });
    const [pendingReports, pendingAccessRequests, underReviewCases, hiddenCases, hiddenContributions] = await Promise.all([
      RepositoryModerationReport.countDocuments({ status: { $in: ['pending', 'in_review'] } }),
      RepositoryAccessRequest.countDocuments({ status: 'pending' }),
      Case.countDocuments({ status: 'closed', repositoryStatus: 'under_review' }),
      Case.countDocuments({ status: 'closed', repositoryStatus: 'hidden' }),
      RepositoryDiscussion.countDocuments({ moderationStatus: 'hidden', isDeleted: false })
    ]);
    res.json({ pendingReports, pendingAccessRequests, underReviewCases, hiddenCases, hiddenContributions });
  } catch (error) {
    res.status(500).json({ error: 'Could not load repository governance summary.' });
  }
});

router.get('/admin/reports', async (req, res) => {
  try {
    if (!isAdmin(req)) return res.status(403).json({ error: 'Administrator access required.' });
    const status = String(req.query.status || '').trim();
    const query = {};
    if (['pending', 'in_review', 'actioned', 'dismissed'].includes(status)) query.status = status;
    const reports = await RepositoryModerationReport.find(query).sort({ createdAt: -1 }).limit(300).lean();
    const discussionIds = reports.filter(item => item.targetType === 'discussion').map(item => item.targetId);
    const caseIds = [...new Set(reports.map(item => String(item.caseId)))];
    const [discussions, cases] = await Promise.all([
      discussionIds.length ? RepositoryDiscussion.find({ _id: { $in: discussionIds } }).select('_id content authorName moderationStatus').lean() : [],
      caseIds.length ? Case.find({ _id: { $in: caseIds } }).select('_id description').lean() : []
    ]);
    const discussionMap = new Map(discussions.map(item => [String(item._id), item]));
    const caseMap = new Map(cases.map(item => [String(item._id), item]));
    res.json({ reports: reports.map(report => ({
      ...report,
      targetSummary: report.targetType === 'discussion'
        ? (discussionMap.get(String(report.targetId))?.content || 'The reported contribution is no longer available.')
        : (caseMap.get(String(report.caseId))?.description || 'No case description available.'),
      targetAuthor: discussionMap.get(String(report.targetId))?.authorName || ''
    })) });
  } catch (error) {
    res.status(500).json({ error: 'Could not load repository moderation reports.' });
  }
});

router.patch('/admin/reports/:reportId', async (req, res) => {
  try {
    if (!isAdmin(req)) return res.status(403).json({ error: 'Administrator access required.' });
    if (!objectId(req.params.reportId)) return res.status(404).json({ error: 'Report not found.' });
    const status = req.body?.status;
    const reviewNote = typeof req.body?.reviewNote === 'string' ? req.body.reviewNote.trim().slice(0, 2000) : '';
    if (!['in_review', 'actioned', 'dismissed'].includes(status)) return res.status(400).json({ error: 'Choose in review, actioned or dismissed.' });
    const report = await RepositoryModerationReport.findById(req.params.reportId);
    if (!report) return res.status(404).json({ error: 'Report not found.' });
    const [actor, caseItem] = await Promise.all([
      User.findById(req.user.id).select('name email'),
      Case.findById(report.caseId)
    ]);
    report.status = status;
    report.reviewNote = reviewNote;
    report.reviewedBy = actor?._id || req.user.id;
    report.reviewedAt = new Date();
    await report.save();
    if (caseItem && actor) {
      appendCaseAudit(caseItem, actor, 'REPOSITORY_REPORT_REVIEWED',
        `A repository ${report.targetType} report was marked ${status}`,
        { reportId: String(report._id), targetType: report.targetType, targetId: String(report.targetId), status, reviewNote });
      await caseItem.save();
    }
    await notifyUser(
      report.reporterId, actor?._id || req.user.id, actor?.name || 'DESS Administrator',
      'REPOSITORY_MODERATION',
      `Your repository report was ${status.replace('_', ' ')}`,
      reviewNote ? `Case ${report.caseNumber}: ${reviewNote}` : `Your report for ${report.caseNumber} was marked ${status.replace('_', ' ')}.`,
      caseItem
    );
    res.json({ report });
  } catch (error) {
    res.status(500).json({ error: 'Could not update the moderation report.' });
  }
});

router.get('/admin/cases', async (req, res) => {
  try {
    if (!isAdmin(req)) return res.status(403).json({ error: 'Administrator access required.' });
    const search = String(req.query.search || '').trim().slice(0, 100);
    const query = { status: 'closed' };
    if (search) {
      const expression = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      query.$or = [{ caseId: expression }, { name: expression }, { description: expression }];
    }
    const cases = await Case.find(query).select('_id caseId name description caseType repositoryStatus repositoryModerationReason repositoryModeratedAt updatedAt createdBy team evidence').sort({ updatedAt: -1 }).limit(300).lean();
    const caseIds = cases.map(item => item._id);
    const reportCounts = await RepositoryModerationReport.aggregate([
      { $match: { targetType: 'case', targetId: { $in: caseIds }, status: { $in: ['pending', 'in_review'] } } },
      { $group: { _id: '$targetId', count: { $sum: 1 } } }
    ]);
    const counts = new Map(reportCounts.map(item => [String(item._id), item.count]));
    res.json({ cases: cases.map(item => ({
      ...item,
      repositoryStatus: item.repositoryStatus || 'visible',
      evidenceCount: item.evidence.filter(evidence => !evidence.deleted).length,
      sharedEvidenceCount: item.evidence.filter(evidence => !evidence.deleted && evidence.visibleToResearchers === true).length,
      reportCount: counts.get(String(item._id)) || 0,
      investigatorNames: item.team.map(member => member.name).filter(Boolean)
    })) });
  } catch (error) {
    res.status(500).json({ error: 'Could not load repository cases for moderation.' });
  }
});

router.patch('/admin/cases/:caseId/moderation', async (req, res) => {
  try {
    if (!isAdmin(req)) return res.status(403).json({ error: 'Administrator access required.' });
    if (!objectId(req.params.caseId)) return res.status(404).json({ error: 'Case not found.' });
    const status = req.body?.status;
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 1200) : '';
    if (!['visible', 'under_review', 'hidden'].includes(status)) return res.status(400).json({ error: 'Invalid repository moderation status.' });
    if (status !== 'visible' && reason.length < 5) return res.status(400).json({ error: 'Add a reason for placing a case under review or hiding it.' });
    const caseItem = await Case.findById(req.params.caseId);
    if (!caseItem || caseItem.status !== 'closed') return res.status(404).json({ error: 'Closed case not found.' });
    const actor = await User.findById(req.user.id).select('name email');
    const previousStatus = caseItem.repositoryStatus || 'visible';
    caseItem.repositoryStatus = status;
    caseItem.repositoryModerationReason = status === 'visible' ? '' : reason;
    caseItem.repositoryModeratedBy = actor?._id || req.user.id;
    caseItem.repositoryModeratedAt = new Date();
    appendCaseAudit(caseItem, actor, 'REPOSITORY_CASE_MODERATION',
      `Repository visibility changed from ${previousStatus} to ${status} by an administrator`,
      { previousStatus, status, reason });
    await caseItem.save();
    res.json({ case: { _id: caseItem._id, caseId: caseItem.caseId, repositoryStatus: caseItem.repositoryStatus, repositoryModerationReason: caseItem.repositoryModerationReason } });
  } catch (error) {
    res.status(500).json({ error: 'Could not update case repository visibility.' });
  }
});

router.get('/admin/contributions', async (req, res) => {
  try {
    if (!isAdmin(req)) return res.status(403).json({ error: 'Administrator access required.' });
    const search = String(req.query.search || '').trim().slice(0, 100);
    const query = { isDeleted: false };
    if (req.query.status === 'hidden') query.moderationStatus = 'hidden';
    if (req.query.status === 'visible') query.$or = [{ moderationStatus: 'visible' }, { moderationStatus: { $exists: false } }];
    if (search) {
      const expression = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      query.$and = [...(query.$and || []), { $or: [{ content: expression }, { authorName: expression }, { caseId: expression }] }];
    }
    const items = await RepositoryDiscussion.find(query).sort({ createdAt: -1 }).limit(400).lean();
    const caseIds = [...new Set(items.map(item => String(item.caseId)))];
    const cases = caseIds.length ? await Case.find({ _id: { $in: caseIds } }).select('_id caseId name repositoryStatus').lean() : [];
    const caseMap = new Map(cases.map(item => [String(item._id), item]));
    const reports = await RepositoryModerationReport.aggregate([
      { $match: { targetType: 'discussion', targetId: { $in: items.map(item => item._id) }, status: { $in: ['pending', 'in_review'] } } },
      { $group: { _id: '$targetId', count: { $sum: 1 } } }
    ]);
    const reportCounts = new Map(reports.map(item => [String(item._id), item.count]));
    res.json({ contributions: items.map(item => ({
      ...item,
      moderationStatus: item.moderationStatus || 'visible',
      case: caseMap.get(String(item.caseId)) || null,
      reportCount: reportCounts.get(String(item._id)) || 0
    })) });
  } catch (error) {
    res.status(500).json({ error: 'Could not load repository contributions.' });
  }
});

router.patch('/admin/contributions/:contributionId/moderation', async (req, res) => {
  try {
    if (!isAdmin(req)) return res.status(403).json({ error: 'Administrator access required.' });
    if (!objectId(req.params.contributionId)) return res.status(404).json({ error: 'Contribution not found.' });
    const status = req.body?.status;
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 1200) : '';
    if (!['visible', 'hidden'].includes(status)) return res.status(400).json({ error: 'Choose visible or hidden.' });
    if (status === 'hidden' && reason.length < 5) return res.status(400).json({ error: 'Add a reason when hiding a contribution.' });
    const contribution = await RepositoryDiscussion.findById(req.params.contributionId);
    if (!contribution || contribution.isDeleted) return res.status(404).json({ error: 'Contribution not found or already removed by its author.' });
    const actor = await User.findById(req.user.id).select('name email');
    const caseItem = await Case.findById(contribution.caseId);
    const previousStatus = contribution.moderationStatus || 'visible';
    contribution.moderationStatus = status;
    contribution.moderationReason = status === 'hidden' ? reason : '';
    contribution.moderatedBy = actor?._id || req.user.id;
    contribution.moderatedAt = new Date();
    await contribution.save();
    if (caseItem && actor) {
      appendCaseAudit(caseItem, actor, 'REPOSITORY_CONTRIBUTION_MODERATION',
        `A repository contribution was changed from ${previousStatus} to ${status}`,
        { contributionId: String(contribution._id), authorId: String(contribution.authorId), status, reason });
      await caseItem.save();
    }
    await notifyUser(
      contribution.authorId, actor?._id || req.user.id, actor?.name || 'DESS Administrator',
      'REPOSITORY_MODERATION',
      status === 'hidden' ? 'A research contribution was hidden' : 'A research contribution was restored',
      status === 'hidden'
        ? `A contribution you posted on ${caseItem?.caseId || 'a repository case'} was hidden by an administrator. Reason: ${reason}`
        : `A contribution you posted on ${caseItem?.caseId || 'a repository case'} is visible again.`,
      caseItem
    );
    res.json({ contribution: { _id: contribution._id, moderationStatus: contribution.moderationStatus } });
  } catch (error) {
    res.status(500).json({ error: 'Could not moderate the research contribution.' });
  }
});

// Administrative read-only overview of access requests; investigators still make evidence-release decisions.
router.get('/admin/access-requests', async (req, res) => {
  try {
    if (!isAdmin(req)) return res.status(403).json({ error: 'Administrator access required.' });
    const requests = await RepositoryAccessRequest.find().sort({ createdAt: -1 }).limit(300).lean();
    res.json({ requests });
  } catch (error) {
    res.status(500).json({ error: 'Could not load evidence access request oversight.' });
  }
});

module.exports = router;
