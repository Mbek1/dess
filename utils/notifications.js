const Notification = require('../models/Notification');

async function notifyCaseTeam(caseItem, event, excludeUserId) {
  const excludedId = excludeUserId ? excludeUserId.toString() : '';
  const recipients = [...new Set(caseItem.team
    .map(member => member.id?.toString())
    .filter(userId => userId && userId !== excludedId))];
  if (!recipients.length) return [];

  const records = recipients.map(recipientId => ({
    recipientId,
    actorId: event.actorId,
    actorName: event.actorName,
    kind: event.kind,
    title: event.title,
    body: event.body,
    caseId: caseItem._id,
    caseNumber: caseItem.caseId || String(caseItem.number),
    evidenceId: event.evidenceId,
    link: `/cases/${caseItem._id}`
  }));
  return Notification.insertMany(records);
}

module.exports = { notifyCaseTeam };
