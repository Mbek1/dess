const Case = require('../models/Case');
const { notifyCaseTeam } = require('./notifications');

function addWorkingDays(startDate, numberOfDays) {
  const result = new Date(startDate);
  let addedDays = 0;
  while (addedDays < numberOfDays) {
    result.setUTCDate(result.getUTCDate() + 1);
    const weekday = result.getUTCDay();
    if (weekday !== 0 && weekday !== 6) addedDays += 1;
  }
  return result;
}

function finalizeDeletionRequest(caseItem, evidence, now = new Date()) {
  const request = evidence.deletionRequest;
  if (!request || request.status !== 'pending') return null;

  const eligibleIds = (request.eligibleVoterIds || []).map(id => id.toString());
  const votesByUser = new Map(request.votes.map(vote => [vote.userId.toString(), vote]));
  const hasAllVotes = eligibleIds.length > 0 && eligibleIds.every(id => votesByUser.has(id));
  const expired = request.expiresAt && now >= request.expiresAt;
  if (!hasAllVotes && !expired) return null;

  if (expired) {
    request.status = 'kept';
    request.resolution = 'timeout_keep';
  } else {
    const deleteVotes = eligibleIds.filter(id => votesByUser.get(id)?.decision === 'delete').length;
    const keepVotes = eligibleIds.filter(id => votesByUser.get(id)?.decision === 'keep').length;
    if (deleteVotes === keepVotes) {
      request.status = 'kept';
      request.resolution = 'tie_keep';
    } else if (deleteVotes > eligibleIds.length / 2) {
      request.status = 'deleted';
      request.resolution = 'majority_delete';
      evidence.deleted = true;
      evidence.deletedReason = request.reason;
      evidence.deletedAt = now;
    } else {
      request.status = 'kept';
      request.resolution = 'majority_keep';
    }
  }

  request.resolvedAt = now;
  caseItem.auditLog.push({
    action: request.status === 'deleted' ? 'EVIDENCE_DELETE' : 'EVIDENCE_DELETE_VOTE_RESOLVED',
    type: 'deletion_vote',
    filename: evidence.filename,
    description: request.status === 'deleted'
      ? `Evidence "${evidence.name}" deleted by team majority`
      : `Evidence "${evidence.name}" retained (${request.resolution.replace(/_/g, ' ')})`,
    performedBy: {
      userId: request.requestedBy,
      name: caseItem.team.find(member => member.id?.equals(request.requestedBy))?.name || 'Case team',
      email: caseItem.team.find(member => member.id?.equals(request.requestedBy))?.email || 'system@app.local'
    },
    details: {
      reason: request.reason,
      resolution: request.resolution,
      deleteVotes: request.votes.filter(vote => vote.decision === 'delete').length,
      keepVotes: request.votes.filter(vote => vote.decision === 'keep').length,
      eligibleVoters: eligibleIds.length,
      expiresAt: request.expiresAt
    }
  });
  return request.resolution;
}

async function settleExpiredEvidenceDeletionRequests(now = new Date()) {
  const cases = await Case.find({ 'evidence.deletionRequest.status': 'pending' });
  let changed = 0;
  for (const loadedCase of cases) {
    let caseItem = loadedCase;
    let caseChanged = false;
    let expiredEvidence = [];

    const resolveForCase = candidate => {
      const expired = [];
      let changedCase = false;
      for (const evidence of candidate.evidence) {
        const resolution = finalizeDeletionRequest(candidate, evidence, now);
        if (resolution) {
          changedCase = true;
          if (resolution === 'timeout_keep') expired.push(evidence);
        }
      }
      return { changedCase, expired };
    };

    ({ changedCase: caseChanged, expired: expiredEvidence } = resolveForCase(caseItem));
    if (!caseChanged) continue;

    try {
      await caseItem.save();
    } catch (err) {
      if (err.name !== 'VersionError') throw err;
      caseItem = await Case.findById(loadedCase._id);
      if (!caseItem) continue;
      ({ changedCase: caseChanged, expired: expiredEvidence } = resolveForCase(caseItem));
      if (!caseChanged) continue;
      try {
        await caseItem.save();
      } catch (retryError) {
        if (retryError.name === 'VersionError') continue;
        throw retryError;
      }
    }

    for (const evidence of expiredEvidence) {
        const requester = caseItem.team.find(member => member.id?.equals(evidence.deletionRequest.requestedBy));
        await notifyCaseTeam(caseItem, {
          actorId: evidence.deletionRequest.requestedBy,
          actorName: requester?.name || 'System',
          kind: 'EVIDENCE_DELETION_RESOLVED',
          title: 'Evidence retained after vote deadline',
          body: `The deletion vote for "${evidence.name}" expired without a team decision. The evidence was kept.`,
          evidenceId: evidence._id
        });
    }
    changed += 1;
  }
  return changed;
}

module.exports = { addWorkingDays, finalizeDeletionRequest, settleExpiredEvidenceDeletionRequests };
