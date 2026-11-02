const CaseChat = require('../models/CaseChat');
const User = require('../models/User');

async function syncCaseChatParticipants(caseItem, createdById) {
  const teamIds = [...new Set(caseItem.team.map(member => member.id?.toString()).filter(Boolean))];
  const investigators = await User.find({ _id: { $in: teamIds }, role: 'investigator' }).select('name email role');
  const participants = investigators.map(user => ({
    userId: user._id,
    name: user.name,
    email: user.email,
    role: user.role
  }));

  return CaseChat.findOneAndUpdate(
    { caseId: caseItem._id },
    {
      $set: {
        caseNumber: caseItem.caseId || String(caseItem.number),
        title: `${caseItem.caseId || `Case ${caseItem.number}`} · ${caseItem.name}`,
        participants
      },
      $setOnInsert: { createdBy: createdById }
    },
    { new: true, upsert: true, setDefaultsOnInsert: true, runValidators: true }
  );
}

module.exports = { syncCaseChatParticipants };