require('dotenv').config();

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { after, test } = require('node:test');
const express = require('express');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const sharp = require('sharp');
const AdmZip = require('adm-zip');
const Case = require('../models/Case');
const CaseChat = require('../models/CaseChat');
const CaseChatMessage = require('../models/CaseChatMessage');
const Message = require('../models/Message');
const Notification = require('../models/Notification');
const User = require('../models/User');
const { settleExpiredEvidenceDeletionRequests } = require('../utils/evidence-deletion');

const JWT_SECRET = process.env.JWT_SECRET || 'supersecretkey';
const configuredMongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/dess';
const testMongoUri = process.env.TEST_MONGODB_URI || (() => {
  const uri = new URL(configuredMongoUri);
  uri.pathname = `/dess_test_${process.pid}`;
  return uri.toString();
})();

test('case access, search, messaging, and evidence integrity', async t => {
  await mongoose.connect(testMongoUri, { serverSelectionTimeoutMS: 10000 });

  const runId = crypto.randomUUID();
  const uniqueTag = `integration-${runId}`;
  const searchTag = `discovery-${runId}`;
  const messageContent = `integration message ${runId}`;
  const testUserIds = [];
  const testCaseIds = [];
  const uploadedFiles = [];
  let server;

  try {
    const [investigator, researcher, otherInvestigator, teamVoter] = await User.create([
      {
        name: `Test Investigator ${runId}`,
        email: `investigator-${runId}@example.test`,
        password: 'not-used-by-this-test',
        role: 'investigator'
      },
      {
        name: `Test Researcher ${runId}`,
        email: `researcher-${runId}@example.test`,
        password: 'not-used-by-this-test',
        role: 'researcher'
      },
      {
        name: `Other Investigator ${runId}`,
        email: `other-${runId}@example.test`,
        password: 'not-used-by-this-test',
        role: 'investigator'
      },
      {
        name: `Team Voter ${runId}`,
        email: `team-voter-${runId}@example.test`,
        password: 'not-used-by-this-test',
        role: 'investigator'
      }
    ]);
    testUserIds.push(investigator._id, researcher._id, otherInvestigator._id, teamVoter._id);

    const caseNumber = Date.now() * 10 + crypto.randomInt(0, 10);
    const caseSuffix = runId.replace(/-/g, '').slice(0, 12).toUpperCase();
    const [closedCase, openCase, caseToClose, tieCase, majorityCase] = await Case.create([
      {
        number: caseNumber,
        caseId: `2026-TST-${caseSuffix}-C`,
        caseType: 'criminal',
        name: `Closed ${searchTag}`,
        description: `Closed-case search fixture ${searchTag}`,
        status: 'closed',
        createdBy: { id: investigator._id, name: investigator.name, email: investigator.email, role: investigator.role },
        team: [{ id: investigator._id, name: investigator.name, email: investigator.email }]
      },
      {
        number: caseNumber + 1,
        caseId: `2026-TST-${caseSuffix}-O`,
        caseType: 'criminal',
        name: `Open ${searchTag}`,
        description: `Open-case search fixture ${searchTag}`,
        status: 'open',
        createdBy: { id: investigator._id, name: investigator.name, email: investigator.email, role: investigator.role },
        team: [{ id: investigator._id, name: investigator.name, email: investigator.email }]
      },
      {
        number: caseNumber + 2,
        caseId: `2026-TST-${caseSuffix}-X`,
        caseType: 'criminal',
        name: `Closure ${uniqueTag}`,
        description: `Closure test fixture ${uniqueTag}`,
        status: 'open',
        createdBy: { id: investigator._id, name: investigator.name, email: investigator.email, role: investigator.role },
        team: [{ id: investigator._id, name: investigator.name, email: investigator.email }]
      },
      {
        number: caseNumber + 3,
        caseId: `2026-TST-${caseSuffix}-T`,
        caseType: 'criminal',
        name: `Tie vote ${uniqueTag}`,
        description: `Deletion tie fixture ${uniqueTag}`,
        status: 'open',
        createdBy: { id: investigator._id, name: investigator.name, email: investigator.email, role: investigator.role },
        team: [
          { id: investigator._id, name: investigator.name, email: investigator.email },
          { id: otherInvestigator._id, name: otherInvestigator.name, email: otherInvestigator.email }
        ]
      },
      {
        number: caseNumber + 4,
        caseId: `2026-TST-${caseSuffix}-M`,
        caseType: 'criminal',
        name: `Majority vote ${uniqueTag}`,
        description: `Deletion majority fixture ${uniqueTag}`,
        status: 'open',
        createdBy: { id: investigator._id, name: investigator.name, email: investigator.email, role: investigator.role },
        team: [
          { id: investigator._id, name: investigator.name, email: investigator.email },
          { id: otherInvestigator._id, name: otherInvestigator.name, email: otherInvestigator.email },
          { id: teamVoter._id, name: teamVoter.name, email: teamVoter.email }
        ]
      }
    ]);
    testCaseIds.push(closedCase._id, openCase._id, caseToClose._id, tieCase._id, majorityCase._id);

    const app = express();
    app.use(express.json());
    app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads')));
    app.use('/api/cases', require('../routes/cases'));
    app.use('/api/messages', require('../routes/messages'));
    app.use('/api/users', require('../routes/users'));
    app.use('/api/notifications', require('../routes/notifications'));
    app.use('/api/researcher', require('../routes/researcher'));
    server = app.listen(0);
    await new Promise((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });

    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const tokenFor = user => jwt.sign({ id: user._id.toString(), role: user.role }, JWT_SECRET);
    const investigatorToken = tokenFor(investigator);
    const researcherToken = tokenFor(researcher);
    const outsiderToken = tokenFor(otherInvestigator);
    const teamVoterToken = tokenFor(teamVoter);

    async function request(url, { token, ...options } = {}) {
      const headers = new Headers(options.headers || {});
      if (token) headers.set('Authorization', `Bearer ${token}`);
      return fetch(`${baseUrl}${url}`, { ...options, headers });
    }

    await t.test('authentication and case-level permissions', async () => {
      const unauthenticated = await request(`/api/cases/${closedCase._id}`);
      assert.equal(unauthenticated.status, 401);

      const assignedInvestigator = await request(`/api/cases/${openCase._id}`, { token: investigatorToken });
      assert.equal(assignedInvestigator.status, 200);

      const unassignedInvestigator = await request(`/api/cases/${openCase._id}`, { token: outsiderToken });
      assert.equal(unassignedInvestigator.status, 403);

      const anonymousUpdate = await request(`/api/cases/${openCase._id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: 'unauthorized update' })
      });
      assert.equal(anonymousUpdate.status, 401);

      const unassignedUpdate = await request(`/api/cases/${openCase._id}`, {
        token: outsiderToken,
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: 'unauthorized update' })
      });
      assert.equal(unassignedUpdate.status, 403);

      const assignedUpdate = await request(`/api/cases/${openCase._id}`, {
        token: investigatorToken,
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: `Updated ${uniqueTag}` })
      });
      assert.equal(assignedUpdate.status, 200);
      assert.equal((await assignedUpdate.json()).description, `Updated ${uniqueTag}`);

      const researcherClosed = await request(`/api/cases/${closedCase._id}`, { token: researcherToken });
      assert.equal(researcherClosed.status, 200);

      const researcherOpen = await request(`/api/cases/${openCase._id}`, { token: researcherToken });
      assert.equal(researcherOpen.status, 403);
    });

    await t.test('case creation is available to investigators only', async () => {
      const payload = {
        name: `Created ${uniqueTag}`,
        description: `Created case fixture ${uniqueTag}`,
        caseType: 'civil',
        docketNumber: `TEST-${runId}`,
        team: [{ id: otherInvestigator.id, name: otherInvestigator.name, email: otherInvestigator.email }]
      };
      const createdResponse = await request('/api/cases', {
        token: investigatorToken,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      assert.equal(createdResponse.status, 201);
      const created = await createdResponse.json();
      testCaseIds.push(created._id);
      assert.equal(created.createdBy.id, investigator.id);
      assert.ok(created.team.some(member => member.id === investigator.id));
      assert.ok(created.team.some(member => member.id === otherInvestigator.id));

      let caseChat = await CaseChat.findOne({ caseId: created._id });
      assert.ok(caseChat);
      assert.equal(caseChat.participants.length, 2);
      assert.ok(caseChat.participants.some(member => member.userId.equals(investigator._id)));
      assert.ok(caseChat.participants.some(member => member.userId.equals(otherInvestigator._id)));

      const inviteResponse = await request(`/api/cases/${created._id}/add-member`, {
        token: investigatorToken,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: teamVoter.id })
      });
      assert.equal(inviteResponse.status, 200);
      testCaseIds.push(created._id);
      caseChat = await CaseChat.findOne({ caseId: created._id });
      assert.equal(caseChat.participants.length, 3);
      assert.ok(caseChat.participants.some(member => member.userId.equals(teamVoter._id)));

      const roomList = await request('/api/messages/case-chats', { token: investigatorToken });
      assert.equal(roomList.status, 200);
      assert.ok((await roomList.json()).some(room => room.caseId === created._id));
      const researcherRoomList = await request('/api/messages/case-chats', { token: researcherToken });
      assert.equal(researcherRoomList.status, 403);

      const groupPost = await request(`/api/messages/case-chats/${created._id}/messages`, {
        token: teamVoterToken,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: `Case-room update ${runId}` })
      });
      assert.equal(groupPost.status, 201);
      const postedGroupMessage = await groupPost.json();
      assert.equal(postedGroupMessage.senderId, teamVoter.id);

      const unreadBeforeOpening = await request('/api/messages/unread-count', { token: investigatorToken });
      const unreadBefore = await unreadBeforeOpening.json();
      assert.equal(unreadBefore.caseChatUnreadCount, 1);

      const groupHistory = await request(`/api/messages/case-chats/${created._id}/messages`, { token: investigatorToken });
      assert.equal(groupHistory.status, 200);
      assert.ok((await groupHistory.json()).messages.some(message => message.content === `Case-room update ${runId}`));
      const unreadAfterOpening = await request('/api/messages/unread-count', { token: investigatorToken });
      assert.equal((await unreadAfterOpening.json()).caseChatUnreadCount, 0);

      const outsiderGroupPost = await request(`/api/messages/case-chats/${created._id}/messages`, {
        token: researcherToken,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'Unauthorized case-room message' })
      });
      assert.equal(outsiderGroupPost.status, 403);

      const forbiddenResponse = await request('/api/cases', {
        token: researcherToken,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, docketNumber: `RESEARCHER-${runId}` })
      });
      assert.equal(forbiddenResponse.status, 403);
    });

    await t.test('researcher search returns a matching closed and open case', async () => {
      const response = await request(`/api/researcher/cases?search=${encodeURIComponent(searchTag)}`, {
        token: researcherToken
      });
      assert.equal(response.status, 200);
      const results = await response.json();
      assert.ok(results.closedCases.some(item => item._id === closedCase.id));
      assert.equal(results.openCaseFound?.caseId, openCase.caseId);

      const forbidden = await request(`/api/researcher/cases?search=${encodeURIComponent(searchTag)}`, {
        token: investigatorToken
      });
      assert.equal(forbidden.status, 403);
    });

    await t.test('case closure requires documents and uses authenticated audit identity', async () => {
      const directClose = await request(`/api/cases/${caseToClose._id}`, {
        token: investigatorToken,
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'closed' })
      });
      assert.equal(directClose.status, 400);

      const missingDocuments = await request(`/api/cases/${caseToClose._id}/close`, {
        token: investigatorToken,
        method: 'POST'
      });
      assert.equal(missingDocuments.status, 400);

      const form = new FormData();
      form.append('documents', new Blob([`chain of custody ${runId}`]), 'chain-of-custody.txt');
      form.append('userId', otherInvestigator.id);
      form.append('userName', 'Forged Closer');
      form.append('userEmail', 'forged@example.test');
      const closeResponse = await request(`/api/cases/${caseToClose._id}/close`, {
        token: investigatorToken,
        method: 'POST',
        body: form
      });
      assert.equal(closeResponse.status, 200);
      const closure = await closeResponse.json();
      assert.equal(closure.success, true);
      assert.equal(closure.closureDocs.length, 1);
      uploadedFiles.push(...closure.closureDocs.map(document => document.path));

      const closedCaseRecord = await Case.findById(caseToClose._id);
      assert.equal(closedCaseRecord.status, 'closed');
      const closeAudit = closedCaseRecord.auditLog.find(item => item.action === 'CASE_CLOSE');
      assert.equal(closeAudit.performedBy.userId.toString(), investigator.id);
      assert.equal(closeAudit.performedBy.name, investigator.name);

      const reopenResponse = await request(`/api/cases/${caseToClose._id}`, {
        token: investigatorToken,
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'open' })
      });
      assert.equal(reopenResponse.status, 400);
    });

    await t.test('evidence deletion requires strict majority; ties and expired votes keep evidence', async () => {
      const makeEvidence = (caseItem, suffix) => caseItem.evidence.create({
        filename: `vote-${runId}-${suffix}.txt`,
        originalName: `${suffix}.txt`,
        mimeType: 'text/plain',
        type: 'document',
        name: `${suffix} ${runId}`,
        description: 'Deletion vote test item',
        hash: crypto.createHash('sha256').update(suffix).digest('hex'),
        format: 'TXT'
      });
      const tieEvidence = makeEvidence(tieCase, 'tie');
      const timeoutEvidence = makeEvidence(tieCase, 'timeout');
      tieCase.evidence.push(tieEvidence, timeoutEvidence);
      await tieCase.save();

      const tieRequest = await request(`/api/cases/${tieCase._id}/evidence/${tieEvidence._id}/deletion-request`, {
        token: investigatorToken,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'Duplicate evidence file' })
      });
      assert.equal(tieRequest.status, 202);
      const tieVote = await request(`/api/cases/${tieCase._id}/evidence/${tieEvidence._id}/deletion-vote`, {
        token: outsiderToken,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision: 'keep' })
      });
      assert.equal(tieVote.status, 200);
      const tieResolvedCase = await Case.findById(tieCase._id);
      const tieResolvedEvidence = tieResolvedCase.evidence.id(tieEvidence._id);
      assert.equal(tieResolvedEvidence.deleted, false);
      assert.equal(tieResolvedEvidence.deletionRequest.resolution, 'tie_keep');

      const timeoutRequest = await request(`/api/cases/${tieCase._id}/evidence/${timeoutEvidence._id}/deletion-request`, {
        token: investigatorToken,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'Unconfirmed duplication' })
      });
      assert.equal(timeoutRequest.status, 202);
      const timeoutCase = await Case.findById(tieCase._id);
      timeoutCase.evidence.id(timeoutEvidence._id).deletionRequest.expiresAt = new Date(Date.now() - 86400000);
      await timeoutCase.save();
      await settleExpiredEvidenceDeletionRequests();
      const timeoutResolvedCase = await Case.findById(tieCase._id);
      const timeoutResolvedEvidence = timeoutResolvedCase.evidence.id(timeoutEvidence._id);
      assert.equal(timeoutResolvedEvidence.deleted, false);
      assert.equal(timeoutResolvedEvidence.deletionRequest.resolution, 'timeout_keep');

      const majorityEvidence = makeEvidence(majorityCase, 'majority');
      majorityCase.evidence.push(majorityEvidence);
      await majorityCase.save();
      const majorityRequest = await request(`/api/cases/${majorityCase._id}/evidence/${majorityEvidence._id}/deletion-request`, {
        token: investigatorToken,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'Evidence was uploaded in error' })
      });
      assert.equal(majorityRequest.status, 202);

      for (const voter of [otherInvestigator, teamVoter]) {
        const voteResponse = await request(`/api/cases/${majorityCase._id}/evidence/${majorityEvidence._id}/deletion-vote`, {
          token: tokenFor(voter),
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ decision: 'delete' })
        });
        assert.equal(voteResponse.status, 200);
      }
      const majorityResolved = await Case.findById(majorityCase._id);
      const deletedEvidence = majorityResolved.evidence.id(majorityEvidence._id);
      assert.equal(deletedEvidence.deleted, true);
      assert.equal(deletedEvidence.deletionRequest.resolution, 'majority_delete');

      const voterNotifications = await request('/api/notifications', { token: tokenFor(teamVoter) });
      assert.equal(voterNotifications.status, 200);
      const notifications = await voterNotifications.json();
      assert.ok(notifications.notifications.some(item => item.kind === 'EVIDENCE_DELETION_VOTE'));
      assert.ok(notifications.notifications.every(item => item.recipientId === teamVoter.id));
    });

    await t.test('authenticated users can send and receive a message', async () => {
      const publicDirectory = await request('/api/users?search=Researcher');
      assert.equal(publicDirectory.status, 401);
      const recipientDirectory = await request(`/api/users?userId=${researcher.id}`, { token: investigatorToken });
      assert.equal(recipientDirectory.status, 200);
      assert.equal((await recipientDirectory.json())[0]._id, researcher.id);

      const sentResponse = await request('/api/messages', {
        token: investigatorToken,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recipientId: researcher.id,
          subject: `Test ${runId}`,
          content: messageContent,
          type: 'case-related',
          caseId: closedCase.id,
          caseNumber: closedCase.caseId
        })
      });
      assert.equal(sentResponse.status, 201);
      const sentMessage = await sentResponse.json();
      assert.equal(sentMessage.senderId, investigator.id);
      assert.equal(sentMessage.status, 'delivered');

      const privateMessage = await request(`/api/messages/${sentMessage._id}`, { token: outsiderToken });
      assert.equal(privateMessage.status, 404);

      const senderReadAttempt = await request(`/api/messages/${sentMessage._id}/read`, {
        token: investigatorToken,
        method: 'PATCH'
      });
      assert.equal(senderReadAttempt.status, 403);

      const recipientRead = await request(`/api/messages/${sentMessage._id}/read`, {
        token: researcherToken,
        method: 'PATCH'
      });
      assert.equal(recipientRead.status, 200);

      const inboxResponse = await request('/api/messages', { token: researcherToken });
      assert.equal(inboxResponse.status, 200);
      const inbox = await inboxResponse.json();
      assert.ok(inbox.some(message => message.content === messageContent));

      const caseContact = await request('/api/messages', {
        token: researcherToken,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recipientId: investigator.id,
          subject: `Question about ${openCase.caseId}`,
          content: `Case reference ${openCase.caseId}`,
          caseNumber: openCase.caseId,
          type: 'case-related'
        })
      });
      assert.equal(caseContact.status, 201);
      const caseContactMessage = await caseContact.json();
      assert.equal(caseContactMessage.caseId, openCase.id);
      assert.equal(caseContactMessage.caseNumber, openCase.caseId);

      const investigatorReply = await request('/api/messages', {
        token: investigatorToken,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recipientId: researcher.id,
          subject: caseContactMessage.subject,
          content: `Reply regarding ${openCase.caseId}`,
          parentMessageId: caseContactMessage._id
        })
      });
      assert.equal(investigatorReply.status, 201);
      assert.equal((await investigatorReply.json()).caseId, openCase.id);

      const unauthorizedCaseContact = await request('/api/messages', {
        token: researcherToken,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recipientId: otherInvestigator.id,
          subject: `Question about ${openCase.caseId}`,
          content: `Case reference ${openCase.caseId}`,
          caseNumber: openCase.caseId,
          type: 'case-related'
        })
      });
      assert.equal(unauthorizedCaseContact.status, 403);

      const archiveResponse = await request(`/api/messages/conversation/${investigator.id}/archive`, {
        token: researcherToken,
        method: 'PATCH'
      });
      assert.equal(archiveResponse.status, 200);
      const archivedMessages = await (await request('/api/messages?view=archived', { token: researcherToken })).json();
      assert.ok(archivedMessages.some(message => message._id === sentMessage._id));
      const senderInbox = await (await request('/api/messages?view=sent', { token: investigatorToken })).json();
      assert.ok(senderInbox.some(message => message._id === sentMessage._id));

      const deleteResponse = await request(`/api/messages/conversation/${investigator.id}`, {
        token: researcherToken,
        method: 'DELETE'
      });
      assert.equal(deleteResponse.status, 200);
      const researcherArchiveAfterDelete = await (await request('/api/messages?view=archived', { token: researcherToken })).json();
      assert.ok(!researcherArchiveAfterDelete.some(message => message._id === sentMessage._id));
      const senderCopyAfterDelete = await (await request('/api/messages?view=sent', { token: investigatorToken })).json();
      assert.ok(senderCopyAfterDelete.some(message => message._id === sentMessage._id));
    });

    await t.test('verification documents remain private and pending until reviewed', async () => {
      const statusResponse = await request(`/api/users/${investigator.id}/verification`, {
        token: investigatorToken
      });
      assert.equal(statusResponse.status, 200);
      const initialStatus = await statusResponse.json();
      assert.equal(initialStatus.emailVerified, false);
      assert.equal(initialStatus.selfieStatus, 'not_configured');
      assert.equal(initialStatus.livenessStatus, 'not_configured');

      const form = new FormData();
      form.append('document', new Blob([`private identity document ${runId}`], { type: 'application/pdf' }), 'identity.pdf');
      const uploadResponse = await request(`/api/users/${investigator.id}/verification-documents/identity`, {
        token: investigatorToken,
        method: 'POST',
        body: form
      });
      assert.equal(uploadResponse.status, 201);
      const uploadResult = await uploadResponse.json();
      assert.equal(uploadResult.document.status, 'pending');
      assert.equal(uploadResult.document.originalName, 'identity.pdf');
      assert.equal(Object.hasOwn(uploadResult.document, 'path'), false);

      const savedUser = await User.findById(investigator.id);
      const storedDocumentPath = savedUser.verificationDocuments.identity.path;
      assert.ok(storedDocumentPath.startsWith(path.join(__dirname, '..', 'private_uploads')));
      assert.equal(storedDocumentPath.startsWith(path.join(__dirname, '..', 'uploads')), false);

      const downloadResponse = await request(`/api/users/${investigator.id}/verification-documents/identity`, {
        token: investigatorToken
      });
      assert.equal(downloadResponse.status, 200);
      assert.match(downloadResponse.headers.get('cache-control'), /private, no-store/);
      assert.equal(await downloadResponse.text(), `private identity document ${runId}`);

      const unauthorizedDownload = await request(`/api/users/${investigator.id}/verification-documents/identity`, {
        token: researcherToken
      });
      assert.equal(unauthorizedDownload.status, 403);

      const updatedStatusResponse = await request(`/api/users/${investigator.id}/verification`, {
        token: investigatorToken
      });
      const updatedStatus = await updatedStatusResponse.json();
      assert.equal(updatedStatus.identity.status, 'pending');

      investigator.emailVerified = true;
      await investigator.save();
      const emailChangeResponse = await request(`/api/users/${investigator.id}`, {
        token: investigatorToken,
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: `changed-${runId}@example.test` })
      });
      assert.equal(emailChangeResponse.status, 200);
      const verificationAfterEmailChange = await request(`/api/users/${investigator.id}/verification`, {
        token: investigatorToken
      });
      assert.equal((await verificationAfterEmailChange.json()).emailVerified, false);
    });

    await t.test('researchers see only shared evidence details and downloads omit restricted files', async () => {
      const publicFilename = `shared-${runId}.txt`;
      const restrictedFilename = `restricted-${runId}.txt`;
      const publicPath = path.join(__dirname, '..', 'private_uploads', 'evidence', publicFilename);
      const restrictedPath = path.join(__dirname, '..', 'private_uploads', 'evidence', restrictedFilename);
      await fs.writeFile(publicPath, `shared bytes ${runId}`);
      await fs.writeFile(restrictedPath, `restricted bytes ${runId}`);
      uploadedFiles.push(publicPath, restrictedPath);

      closedCase.evidence.push(
        closedCase.evidence.create({
          filename: publicFilename,
          originalName: 'shared-report.txt',
          mimeType: 'text/plain',
          type: 'document',
          name: 'Shared report',
          description: 'Approved for research review',
          hash: 'public-hash-value',
          format: 'TXT',
          visibleToResearchers: false
        }),
        closedCase.evidence.create({
          filename: restrictedFilename,
          originalName: 'restricted-report.txt',
          mimeType: 'text/plain',
          type: 'document',
          name: 'Restricted report title',
          description: 'Investigative detail not disclosed',
          hash: 'private-hash-value',
          format: 'TXT',
          visibleToResearchers: false
        })
      );
      await closedCase.save();

      const makePublicResponse = await request(`/api/cases/${closedCase._id}/evidence/${closedCase.evidence[0]._id}/visibility`, {
        token: investigatorToken,
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ visibleToResearchers: true })
      });
      assert.equal(makePublicResponse.status, 200);
      const forbiddenVisibilityChange = await request(`/api/cases/${closedCase._id}/evidence/${closedCase.evidence[1]._id}/visibility`, {
        token: outsiderToken,
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ visibleToResearchers: true })
      });
      assert.equal(forbiddenVisibilityChange.status, 403);

      const detailsResponse = await request(`/api/researcher/cases/${closedCase._id}`, { token: researcherToken });
      assert.equal(detailsResponse.status, 200);
      const researcherCase = await detailsResponse.json();
      const publicItem = researcherCase.evidence.find(item => item.availableToResearchers);
      const restrictedItem = researcherCase.evidence.find(item => !item.availableToResearchers);
      assert.equal(publicItem.name, 'Shared report');
      assert.equal(publicItem.hash, 'public-hash-value');
      assert.equal(Object.hasOwn(restrictedItem, 'name'), false);
      assert.equal(Object.hasOwn(restrictedItem, 'hash'), false);
      assert.equal(Object.hasOwn(restrictedItem, 'filename'), false);

      const downloadResponse = await request(`/api/researcher/cases/${closedCase._id}/download`, { token: researcherToken });
      assert.equal(downloadResponse.status, 200);
      const archive = new AdmZip(Buffer.from(await downloadResponse.arrayBuffer()));
      assert.ok(archive.getEntry(`evidence/${publicFilename}`));
      assert.equal(archive.getEntry(`evidence/${restrictedFilename}`), null);
      const report = archive.readAsText('case_details.txt');
      assert.match(report, /1 additional evidence item/);
      assert.equal(report.includes(restrictedFilename), false);
      assert.equal(report.includes('Restricted report title'), false);
    });

    await t.test('avatar upload updates the profile and serves the processed image', async () => {
      const avatarBytes = await sharp({
        create: { width: 8, height: 8, channels: 3, background: { r: 24, g: 130, b: 220 } }
      }).png().toBuffer();
      const form = new FormData();
      form.append('avatar', new Blob([avatarBytes], { type: 'image/png' }), 'profile.png');
      const uploadResponse = await request(`/api/users/${investigator.id}/avatar`, {
        token: investigatorToken,
        method: 'POST',
        body: form
      });
      assert.equal(uploadResponse.status, 200);
      const upload = await uploadResponse.json();
      assert.match(upload.profilePicture, /^\/uploads\/avatars\/.+\.jpg$/);

      const savedUser = await User.findById(investigator.id);
      assert.equal(savedUser.profilePicture, upload.profilePicture);
      const avatarPath = path.join(__dirname, '..', 'uploads', upload.profilePicture.replace(/^\/uploads\//, ''));
      uploadedFiles.push(avatarPath);

      const imageResponse = await fetch(`${baseUrl}${upload.profilePicture}`);
      assert.equal(imageResponse.status, 200);
      assert.match(imageResponse.headers.get('content-type'), /image\/jpeg/);
      const processedImage = Buffer.from(await imageResponse.arrayBuffer());
      const metadata = await sharp(processedImage).metadata();
      assert.equal(metadata.width, 300);
      assert.equal(metadata.height, 300);
    });

    await t.test('server hash persists, matches unchanged bytes, detects modification, and audits checks', async () => {
      const originalBytes = Buffer.from(`evidence fixture ${runId}`);
      const expectedHash = crypto.createHash('sha256').update(originalBytes).digest('hex');

      const forbiddenForm = new FormData();
      forbiddenForm.append('evidence', new Blob([originalBytes]), `forbidden-${runId}.txt`);
      const forbiddenUpload = await request(`/api/cases/${openCase._id}/upload-evidence`, {
        token: outsiderToken,
        method: 'POST',
        body: forbiddenForm
      });
      assert.equal(forbiddenUpload.status, 403);

      const form = new FormData();
      form.append('evidence', new Blob([originalBytes]), `fixture-${runId}.txt`);

      const uploadResponse = await request(`/api/cases/${openCase._id}/upload-evidence`, {
        token: investigatorToken,
        method: 'POST',
        body: form
      });
      assert.equal(uploadResponse.status, 200);
      const upload = await uploadResponse.json();
      assert.equal(upload.hash, expectedHash);

      const uploadedPath = path.join(__dirname, '..', 'private_uploads', 'evidence', upload.filename);
      uploadedFiles.push(uploadedPath);

      const metadataResponse = await request(`/api/cases/${openCase._id}/evidence`, {
        token: investigatorToken,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filename: upload.filename,
          originalName: `fixture-${runId}.txt`,
          mimeType: 'text/plain',
          type: 'document',
          name: 'Integration evidence',
          description: uniqueTag,
          format: 'TXT',
          hash: 'untrusted-client-hash',
          userId: otherInvestigator.id,
          userName: 'Forged Uploader',
          userEmail: 'forged@example.test'
        })
      });
      assert.equal(metadataResponse.status, 201);
      const metadata = await metadataResponse.json();
      assert.equal(metadata.hash, expectedHash);

      const savedCase = await Case.findById(openCase._id);
      const savedEvidence = savedCase.evidence.find(item => item.filename === upload.filename);
      assert.ok(savedEvidence);
      assert.equal(savedEvidence.hash, expectedHash);
      const uploadAudit = savedCase.auditLog.find(item => item.action === 'EVIDENCE_UPLOAD' && item.filename === upload.filename);
      assert.equal(uploadAudit.performedBy.userId.toString(), investigator.id);
      assert.equal(uploadAudit.performedBy.name, investigator.name);

      const investigatorFile = await request(`/api/cases/${openCase._id}/evidence/${savedEvidence.id}/file`, { token: investigatorToken });
      assert.equal(investigatorFile.status, 200);
      assert.equal(await investigatorFile.text(), originalBytes.toString());
      const forbiddenFile = await request(`/api/cases/${openCase._id}/evidence/${savedEvidence.id}/file`, { token: outsiderToken });
      assert.equal(forbiddenFile.status, 403);

      const verifyUrl = `/api/cases/${openCase._id}/evidence/${savedEvidence.id}/verify`;
      const forbiddenVerification = await request(verifyUrl, { token: outsiderToken, method: 'POST' });
      assert.equal(forbiddenVerification.status, 403);

      const matchingResponse = await request(verifyUrl, { token: investigatorToken, method: 'POST' });
      assert.equal(matchingResponse.status, 200);
      assert.equal((await matchingResponse.json()).matches, true);

      await fs.writeFile(uploadedPath, Buffer.from(`modified evidence ${runId}`));
      const mismatchResponse = await request(verifyUrl, { token: investigatorToken, method: 'POST' });
      assert.equal(mismatchResponse.status, 200);
      assert.equal((await mismatchResponse.json()).matches, false);

      const auditedCase = await Case.findById(openCase._id);
      const verificationEvents = auditedCase.auditLog.filter(item => item.action === 'HASH_VERIFY');
      assert.equal(verificationEvents.length, 2);
      assert.deepEqual(verificationEvents.map(item => item.details.matches), [true, false]);
      assert.ok(verificationEvents.every(item => item.performedBy.userId.toString() === investigator.id));
    });
  } finally {
    if (server) {
      await new Promise(resolve => server.close(resolve));
    }
    await Promise.all(uploadedFiles.map(file => fs.rm(file, { force: true })));
    const remainingUsers = await User.find({ _id: { $in: testUserIds } }, 'verificationDocuments');
    const privateFiles = remainingUsers.flatMap(user => [
      user.verificationDocuments?.identity?.path,
      user.verificationDocuments?.organization?.path
    ]).filter(Boolean);
    await Promise.all(privateFiles.map(file => fs.rm(file, { force: true })));
    await Message.deleteMany({ content: messageContent });
    await Case.deleteMany({ _id: { $in: testCaseIds } });
    await User.deleteMany({ _id: { $in: testUserIds } });
    await mongoose.disconnect();
  }
});

after(async () => {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
});