
const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const Case = require('../models/Case');
const User = require('../models/User');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const AdmZip = require('adm-zip');
const moment = require('moment');
const logger = require('../utils/logger');
const { authenticateToken } = require('../middleware/auth');
const { notifyCaseTeam } = require('../utils/notifications');
const { addWorkingDays, finalizeDeletionRequest } = require('../utils/evidence-deletion');
const { syncCaseChatParticipants } = require('../utils/case-chat');

// Apply authentication middleware to all routes
router.use(authenticateToken);

// Multer setup for closure document uploads
const closureUploadDir = path.join(__dirname, '..', 'uploads');
// Render deployments may not contain empty upload directories from Git.
// Create the directory before Multer attempts to write closure documents.
fs.mkdirSync(closureUploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, closureUploadDir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + '-' + file.originalname);
  }
});
const upload = multer({ storage });

const evidenceUploadDir = path.join(__dirname, '..', 'private_uploads', 'evidence');
fs.mkdirSync(evidenceUploadDir, { recursive: true });
const evidenceStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, evidenceUploadDir),
  filename: (_req, file, cb) => cb(null, `${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase()}`)
});
const evidenceUpload = multer({
  storage: evidenceStorage,
  limits: { fileSize: 100 * 1024 * 1024 }
});

function calculateSha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function getUploadedEvidencePath(filename) {
  if (!filename || path.basename(filename) !== filename) return null;
  const privatePath = path.join(evidenceUploadDir, filename);
  if (fs.existsSync(privatePath)) return privatePath;
  const legacyPath = path.join(__dirname, '../uploads', filename);
  return fs.existsSync(legacyPath) ? legacyPath : null;
}

function sanitizeResearcherCase(caseItem) {
  const result = caseItem.toObject();
  const restrictedFiles = new Set(result.evidence.filter(evidence => evidence.visibleToResearchers !== true).map(evidence => evidence.filename));
  result.evidence = result.evidence.filter(evidence => !evidence.deleted).map(evidence => evidence.visibleToResearchers === true
    ? {
        _id: evidence._id,
        name: evidence.name,
        description: evidence.description,
        type: evidence.type,
        format: evidence.format,
        uploadedAt: evidence.uploadedAt,
        availableToResearchers: true,
        hash: evidence.hash
      }
    : { _id: evidence._id, availableToResearchers: false });
  result.auditLog = result.auditLog.filter(log => !log.filename || !restrictedFiles.has(log.filename));
  result.closureDocs = result.closureDocs.map(({ filename, originalname, uploadedAt }) => ({ filename, originalname, uploadedAt }));
  return result;
}

async function requireInvestigatorCaseAccess(req, res, next) {
  if (!req.user?.id) return res.status(401).json({ error: 'Authentication required' });
  if (req.user.role !== 'investigator') {
    return res.status(403).json({ error: 'Only assigned investigators can modify a case' });
  }

  try {
    const caseId = req.params.id || req.params.caseId;
    const caseItem = await Case.findById(caseId);
    if (!caseItem) return res.status(404).json({ error: 'Case not found' });
    const isAssigned = caseItem.team.some(member => member.id?.toString() === req.user.id);
    if (!isAssigned) return res.status(403).json({ error: 'You are not assigned to this case' });
    req.caseItem = caseItem;
    next();
  } catch (err) {
    logger.error('Failed to authorize case access:', err.message);
    res.status(500).json({ error: 'Failed to verify case access' });
  }
}

// GET /api/cases - fetch cases (filtered by user role and team membership)
router.get('/', authenticateToken, async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    let cases;
    const userId = new mongoose.Types.ObjectId(req.user.id);
    const userRole = req.user.role;

    if (userRole === 'investigator') {
      // Investigators see only cases where they are in the team
      cases = await Case.find({
        'team.id': userId
      });
    } else if (userRole === 'researcher') {
      // Researchers see only closed cases (for research purposes)
      cases = await Case.find({
        status: 'closed'
      });
    } else {
      // Default: no cases
      cases = [];
    }

    res.json(userRole === 'researcher' ? cases.map(sanitizeResearcherCase) : cases);
  } catch (err) {
    logger.error('Error fetching cases:', err.message);
    res.status(500).json({ error: 'Failed to fetch cases' });
  }
});

// GET /api/cases/:id - fetch case by id (with access verification)
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const caseItem = await Case.findById(req.params.id);
    if (!caseItem) return res.status(404).json({ error: 'Case not found' });
    
    // Check access permissions
    if (req.user.role === 'investigator') {
      // Investigators can see case only if in team
      const userId = new mongoose.Types.ObjectId(req.user.id);
      console.log(`Checking access for user ${userId} to case ${caseItem.caseId || caseItem._id}`);
      console.log(`Case team members:`, caseItem.team.map(m => ({ id: m.id?.toString(), name: m.name })));
      
      const isInTeam = caseItem.team.some(member => {
        if (!member.id) {
          console.log(`Team member has no id:`, member);
          return false;
        }
        const matches = member.id.equals(userId);
        console.log(`Comparing ${member.id.toString()} === ${userId.toString()} => ${matches}`);
        return matches;
      });
      
      if (!isInTeam) {
        console.log(`Access DENIED: User ${userId} not in team for case ${caseItem.caseId || caseItem._id}`);
        return res.status(403).json({ error: 'Access denied. You are not part of this case team.' });
      }
      console.log(`Access GRANTED: User ${userId} is in team`);
    } else if (req.user.role === 'researcher') {
      // Researchers can see only closed cases
      if (caseItem.status !== 'closed') {
        return res.status(403).json({ error: 'Access denied. Only closed cases are visible to researchers.' });
      }
      const researcherCase = caseItem.toObject();
      researcherCase.evidence = researcherCase.evidence.filter(item => !item.deleted).map(item => ({
        _id: item._id,
        name: item.name,
        description: item.description,
        type: item.type,
        format: item.format,
        uploadedAt: item.uploadedAt,
        availableToResearchers: item.visibleToResearchers === true,
        ...(item.visibleToResearchers ? { hash: item.hash } : {})
      }));
      return res.json(researcherCase);
    } else {
      // Other roles cannot access cases
      return res.status(403).json({ error: 'Access denied. You do not have permission to view this case.' });
    }
    
    res.json(caseItem);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch case' });
  }
});

// POST /api/cases - create new case (auto-add creator to team, auto-generate case number)
router.post('/', authenticateToken, async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    if (req.user.role !== 'investigator') {
      return res.status(403).json({ error: 'Only investigators can create cases' });
    }
    const { name, description, keywords, status, team, caseType, docketNumber } = req.body;
    
    // Validate required fields
    if (!name || !description) {
      return res.status(400).json({ error: 'Name and description are required' });
    }
    if (!caseType || !['civil', 'criminal'].includes(caseType)) {
      return res.status(400).json({ error: 'Invalid case type. Must be civil or criminal.' });
    }
    
    // Auto-generate case number: find the highest existing number and add 1
    const highestCase = await Case.findOne().sort({ number: -1 }).limit(1);
    const nextNumber = highestCase ? highestCase.number + 1 : 1001;
    
    // Generate caseId in format: YYYY-NUMBER (or use docketNumber if provided)
    const year = new Date().getFullYear();
    let caseId;
    if (docketNumber) {
      // If docketNumber is provided, use it as the caseId
      caseId = docketNumber;
    } else {
      // Otherwise generate from year and number
      caseId = `${year}-${nextNumber}`;
    }
    
    // Check if caseId already exists
    const existingCase = await Case.findOne({ caseId });
    if (existingCase) {
      return res.status(409).json({ error: 'This case ID already exists. Please use a different docket number.' });
    }
    
    // Get creator's info from database
    const creator = await User.findById(req.user.id);
    if (!creator) {
      return res.status(400).json({ error: 'Creator user not found' });
    }
    
    // Add creator to team if not already present
    const requestedTeamIds = (Array.isArray(team) ? team : [])
      .filter(member => member && (member.id || member._id))
      .map(member => member.id || member._id)
      .filter(id => mongoose.isValidObjectId(id));
    const verifiedTeam = await User.find({ _id: { $in: requestedTeamIds }, role: 'investigator' }).select('name email role');
    const teamArray = verifiedTeam.map(member => ({ id: member._id, name: member.name, email: member.email }));
    
    // Check if creator is already in team
    const creatorId = req.user.id.toString();
    const creatorAlreadyInTeam = teamArray.some(member => {
      const memberId = member.id ? member.id.toString() : null;
      return memberId === creatorId;
    });
    if (!creatorAlreadyInTeam) {
      console.log(`Adding creator ${creatorId} (${creator.name}) to case team`);
      teamArray.unshift({
        id: new mongoose.Types.ObjectId(req.user.id),
        name: creator.name,
        email: creator.email
      });
    }
    
    console.log(`Creating case ${caseId} with team:`, teamArray.map(m => ({ id: m.id?.toString(), name: m.name })));
    
    const newCase = new Case({ 
      number: nextNumber,
      caseId,
      caseType,
      name, 
      description,
      keywords: keywords || '',
      docketNumber: docketNumber || '',
      status: status || 'open',  // Default to 'open' if not provided
      escalationStatus: 'police',  // Default to police, will change when escalated
      createdBy: {
        id: new mongoose.Types.ObjectId(req.user.id),
        name: creator.name,
        email: creator.email,
        role: creator.role
      },
      team: teamArray 
    });
    await newCase.save();
    await syncCaseChatParticipants(newCase, creator._id);
    await notifyCaseTeam(newCase, {
      actorId: creator._id,
      actorName: creator.name,
      kind: 'CASE_UPDATE',
      title: 'Case created',
      body: `${creator.name} created ${newCase.caseId}.`
    }, creator._id);
    console.log(`Case ${caseId} created successfully with team:`, newCase.team.map(m => ({ id: m.id?.toString(), name: m.name })));
    res.status(201).json(newCase);
  } catch (err) {
    console.error('Error creating case:', err.message);
    console.error('Full error:', err);
    res.status(500).json({ error: 'Failed to create case', details: err.message });
  }
});

// PATCH /api/cases/:id - update case (status, team, etc)
router.patch('/:id', requireInvestigatorCaseAccess, async (req, res) => {
  try {
    const updates = req.body;
    const caseItem = req.caseItem;
    // Prevent reopening closed cases
    if (caseItem.status === 'closed' && updates.status === 'open') {
      return res.status(400).json({ error: 'Closed cases cannot be reopened' });
    }
    // Closure requires documents and must use the dedicated close endpoint.
    if (caseItem.status === 'open' && updates.status === 'closed') {
      return res.status(400).json({ error: 'Upload closure documents using the close endpoint' });
    }
    // Allow other updates if not status change
    Object.assign(caseItem, updates);
    await caseItem.save();
    const actor = await User.findById(req.user.id).select('name');
    await notifyCaseTeam(caseItem, {
      actorId: req.user.id,
      actorName: actor?.name,
      kind: 'CASE_UPDATE',
      title: 'Case updated',
      body: `${actor?.name || 'An investigator'} updated ${caseItem.caseId}.`
    }, req.user.id);
    res.json(caseItem);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update case' });
  }
});

// POST /api/cases/:id/close - upload closure documents and close case
router.post('/:id/close', requireInvestigatorCaseAccess, upload.array('documents'), async (req, res) => {
  try {
    const caseItem = req.caseItem;
    if (caseItem.status === 'closed') return res.status(400).json({ error: 'Case is already closed' });
    if (!req.files || !req.files.length) return res.status(400).json({ error: 'At least one document is required' });
    const closer = await User.findById(req.user.id).select('name email');
    if (!closer) return res.status(401).json({ error: 'Authenticated user not found' });
    
    // Store file info in case
    caseItem.closureDocs = req.files.map(f => ({ 
      filename: f.filename, 
      originalname: f.originalname, 
      path: f.path 
    }));
    caseItem.status = 'closed';

    // Add audit log entry for case closure
    caseItem.auditLog.push({
      action: 'CASE_CLOSE',
      type: 'status_change',
      description: `Case closed with ${req.files.length} closure document(s)`,
      performedBy: {
        userId: closer._id,
        name: closer.name,
        email: closer.email
      },
      details: {
        previousStatus: 'open',
        newStatus: 'closed',
        closureDocuments: req.files.map(f => ({
          filename: f.filename,
          originalname: f.originalname
        }))
      }
    });

    // Add individual audit entries for each closure document
    for (const file of req.files) {
      caseItem.auditLog.push({
        action: 'CLOSURE_DOC_UPLOAD',
        type: 'document',
        filename: file.filename,
        description: `Closure document "${file.originalname}" uploaded`,
        performedBy: {
          userId: closer._id,
          name: closer.name,
          email: closer.email
        },
        details: {
          originalName: file.originalname,
          size: file.size,
          mimeType: file.mimetype
        }
      });
    }

    await caseItem.save();

    // Notifications are secondary to the closure transaction. Do not report
    // a failed closure after the case has already been saved successfully.
    try {
      await notifyCaseTeam(caseItem, {
        actorId: closer._id,
        actorName: closer.name,
        kind: 'CASE_CLOSED',
        title: 'Case closed',
        body: `${closer.name} closed ${caseItem.caseId} and uploaded closure documents.`
      }, closer._id);
    } catch (notificationError) {
      logger.error('Case closed, but team notification failed:', notificationError.stack || notificationError.message);
    }

    res.json({ success: true, closureDocs: caseItem.closureDocs });
  } catch (err) {
    logger.error('Failed to close case:', err.stack || err.message);
    res.status(500).json({ error: 'Failed to close case', details: err.message });
  }
});

// POST /api/cases/:id/add-member - add a team member to an existing case
router.post('/:id/add-member', requireInvestigatorCaseAccess, async (req, res) => {
  try {
    const { userId } = req.body;
    
    if (!mongoose.isValidObjectId(userId)) {
      return res.status(400).json({ error: 'A valid investigator user ID is required' });
    }

    const caseItem = req.caseItem;
    const invitedUser = await User.findOne({ _id: userId, role: 'investigator' }).select('name email role');
    if (!invitedUser) return res.status(404).json({ error: 'Investigator not found' });

    // Check if user is already in the team
    const userObjectId = new mongoose.Types.ObjectId(userId);
    const isAlreadyMember = caseItem.team.some(member => member.id?.equals(userObjectId));
    
    if (isAlreadyMember) {
      return res.status(400).json({ error: 'User is already a member of this case' });
    }

    // Add user to the team
    caseItem.team.push({
      id: userObjectId,
      name: invitedUser.name,
      email: invitedUser.email
    });

    // Get performer info if authenticated
    let performedBy = {
      userId: req.user?.id || 'unknown',
      name: 'System',
      email: 'system@app.local'
    };
    
    if (req.user?.id) {
      const performer = await User.findById(req.user.id);
      if (performer) {
        performedBy = {
          userId: performer._id,
          name: performer.name,
          email: performer.email
        };
      }
    }

    // Add audit log for team member addition
    caseItem.auditLog.push({
      action: 'TEAM_MEMBER_ADDED',
      type: 'team_update',
      description: `Team member "${invitedUser.name}" (${invitedUser.email}) added to case`,
      performedBy: performedBy,
      details: {
        addedUserId: userId,
        addedUserName: invitedUser.name,
        addedUserEmail: invitedUser.email
      }
    });

    await caseItem.save();
    await syncCaseChatParticipants(caseItem, req.user.id);
    await notifyCaseTeam(caseItem, {
      actorId: req.user.id,
      actorName: performedBy.name,
      kind: 'CASE_UPDATE',
      title: 'Investigator joined the case',
      body: `${invitedUser.name} was added to ${caseItem.caseId}.`
    }, invitedUser._id);
    res.json({ success: true, message: 'Team member added successfully', case: caseItem });
  } catch (err) {
    logger.error('Error adding team member:', err.message);
    res.status(500).json({ error: 'Failed to add team member to case' });
  }
});


// POST /api/cases/:id/evidence - add evidence to a case (with optional file upload)
router.post('/:id/evidence', requireInvestigatorCaseAccess, async (req, res) => {
  try {
    if (!req.user?.id) return res.status(401).json({ error: 'Authentication required' });
    const { filename, originalName, mimeType, type, name, description, format } = req.body;
    if (!filename || !type || !name || !description || !format) {
      return res.status(400).json({ error: 'Missing required evidence fields' });
    }
    const filePath = getUploadedEvidencePath(filename);
    if (!filePath || !fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Uploaded evidence file not found' });
    }
    const caseItem = req.caseItem;
    const uploader = await User.findById(req.user.id).select('name email');
    if (!uploader) return res.status(401).json({ error: 'Authenticated user not found' });
    const hash = await calculateSha256(filePath);

    // Add evidence
    const evidence = caseItem.evidence.create({
      filename,
      originalName: originalName || filename,
      mimeType: mimeType || 'application/octet-stream',
      type,
      name,
      description,
      hash,
      format,
      visibleToResearchers: false
    });
    caseItem.evidence.push(evidence);
    
    // Add audit log entry
    caseItem.auditLog.push({
      action: 'EVIDENCE_UPLOAD',
      type: type,
      filename: filename,
      description: `Evidence "${name}" uploaded to case`,
      performedBy: {
        userId: uploader._id,
        name: uploader.name,
        email: uploader.email
      },
      details: {
        evidenceType: type,
        format: format,
        hash: hash
      }
    });
    
    await caseItem.save();
    await notifyCaseTeam(caseItem, {
      actorId: uploader._id,
      actorName: uploader.name,
      kind: 'EVIDENCE_UPLOAD',
      title: 'Evidence added to case',
      body: `${uploader.name} added "${name}" to ${caseItem.caseId || caseItem.name}.`,
      evidenceId: evidence._id
    }, uploader._id);
    res.status(201).json({ case: caseItem, evidence, hash });
  } catch (err) {
    logger.error('Failed to add evidence metadata:', err.message);
    res.status(500).json({ error: 'Failed to add evidence' });
  }
});

// POST /api/cases/:id/upload-evidence - upload evidence file
router.post('/:id/upload-evidence', requireInvestigatorCaseAccess, evidenceUpload.single('evidence'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    const hash = await calculateSha256(req.file.path);
    res.json({ filename: req.file.filename, hash, originalName: req.file.originalname, mimeType: req.file.mimetype });
  } catch (err) {
    logger.error('Failed to upload evidence file:', err.message);
    res.status(500).json({ error: 'Failed to upload evidence file' });
  }
});

// POST /api/cases/:id/evidence/:evidenceId/verify - verify evidence file integrity
router.post('/:id/evidence/:evidenceId/verify', requireInvestigatorCaseAccess, async (req, res) => {
  try {
    const caseItem = req.caseItem;
    const evidence = caseItem.evidence.id(req.params.evidenceId);
    if (!evidence) return res.status(404).json({ error: 'Evidence not found' });
    const filePath = getUploadedEvidencePath(evidence.filename);
    if (!filePath || !fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Evidence file not found' });
    }
    const calculatedHash = await calculateSha256(filePath);
    const matches = calculatedHash === evidence.hash;
    const verifier = await User.findById(req.user.id).select('name email');
    if (!verifier) return res.status(401).json({ error: 'Authenticated user not found' });

    caseItem.auditLog.push({
      action: 'HASH_VERIFY',
      type: 'integrity_check',
      filename: evidence.filename,
      description: `SHA-256 verification ${matches ? 'passed' : 'failed'} for evidence "${evidence.name}"`,
      performedBy: { userId: verifier._id, name: verifier.name, email: verifier.email },
      details: { storedHash: evidence.hash, calculatedHash, matches }
    });
    await caseItem.save();

    res.json({ matches, storedHash: evidence.hash, calculatedHash });
  } catch (err) {
    logger.error('Failed to verify evidence hash:', err.message);
    res.status(500).json({ error: 'Failed to verify evidence integrity' });
  }
});

// GET /api/cases/:id/evidence/:evidenceId/file - authenticated investigator evidence viewer
router.get('/:id/evidence/:evidenceId/file', requireInvestigatorCaseAccess, async (req, res) => {
  try {
    const caseItem = req.caseItem;
    const evidence = caseItem.evidence.id(req.params.evidenceId);
    if (!evidence || evidence.deleted) return res.status(404).json({ error: 'Evidence not found' });
    const filePath = getUploadedEvidencePath(evidence.filename);
    if (!filePath) return res.status(404).json({ error: 'Evidence file not found' });

    const viewer = await User.findById(req.user.id).select('name email');
    caseItem.auditLog.push({
      action: 'EVIDENCE_VIEW',
      type: 'evidence_access',
      filename: evidence.filename,
      description: `Evidence "${evidence.name}" viewed`,
      performedBy: { userId: viewer._id, name: viewer.name, email: viewer.email },
      details: { evidenceId: evidence._id }
    });
    await caseItem.save();

    const mimeType = /^[\w.+-]+\/[\w.+-]+$/.test(evidence.mimeType || '') ? evidence.mimeType : 'application/octet-stream';
    const safeInline = mimeType.startsWith('image/') || mimeType.startsWith('audio/') || mimeType.startsWith('video/') || mimeType === 'application/pdf' || mimeType === 'text/plain';
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Disposition', `${safeInline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(evidence.originalName || evidence.name)}`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.sendFile(filePath, err => {
      if (err && !res.headersSent) res.status(500).json({ error: 'Failed to stream evidence file' });
    });
  } catch (err) {
    logger.error('Failed to view evidence:', err.message);
    res.status(500).json({ error: 'Failed to view evidence' });
  }
});

// PATCH /api/cases/:id/evidence/:evidenceId/visibility - set researcher download access
router.patch('/:id/evidence/:evidenceId/visibility', requireInvestigatorCaseAccess, async (req, res) => {
  try {
    if (typeof req.body.visibleToResearchers !== 'boolean') {
      return res.status(400).json({ error: 'visibleToResearchers must be true or false' });
    }
    const caseItem = req.caseItem;
    const evidence = caseItem.evidence.id(req.params.evidenceId);
    if (!evidence || evidence.deleted) return res.status(404).json({ error: 'Evidence not found' });
    if (evidence.deletionRequest?.status === 'pending') {
      return res.status(409).json({ error: 'Researcher access cannot change while a deletion vote is pending' });
    }

    const actor = await User.findById(req.user.id).select('name email');
    evidence.visibleToResearchers = req.body.visibleToResearchers;
    caseItem.auditLog.push({
      action: 'EVIDENCE_VISIBILITY',
      type: 'access_control',
      filename: evidence.filename,
      description: `Researcher access ${evidence.visibleToResearchers ? 'enabled' : 'disabled'} for evidence "${evidence.name}"`,
      performedBy: { userId: actor._id, name: actor.name, email: actor.email },
      details: { visibleToResearchers: evidence.visibleToResearchers }
    });
    await caseItem.save();
    await notifyCaseTeam(caseItem, {
      actorId: actor._id,
      actorName: actor.name,
      kind: 'EVIDENCE_VISIBILITY',
      title: evidence.visibleToResearchers ? 'Evidence shared with researchers' : 'Researcher access removed',
      body: `Researcher access to "${evidence.name}" is ${evidence.visibleToResearchers ? 'enabled' : 'disabled'}.`,
      evidenceId: evidence._id
    }, actor._id);
    res.json({ success: true, visibleToResearchers: evidence.visibleToResearchers });
  } catch (err) {
    logger.error('Failed to update evidence visibility:', err.message);
    res.status(500).json({ error: 'Failed to update evidence visibility' });
  }
});

// POST /api/cases/:id/evidence/:evidenceId/deletion-request - begin the investigator vote window
router.post('/:id/evidence/:evidenceId/deletion-request', requireInvestigatorCaseAccess, async (req, res) => {
  try {
    const reason = typeof req.body.reason === 'string' ? req.body.reason.trim() : '';
    if (!reason) return res.status(400).json({ error: 'A reason for the deletion request is required' });
    if (reason.length > 1000) return res.status(400).json({ error: 'Reason must be 1,000 characters or fewer' });

    const caseItem = req.caseItem;
    const evidence = caseItem.evidence.id(req.params.evidenceId);
    if (!evidence || evidence.deleted) return res.status(404).json({ error: 'Evidence not found' });
    if (evidence.deletionRequest?.status === 'pending') return res.status(409).json({ error: 'A deletion vote is already in progress' });

    const teamIds = caseItem.team.map(member => member.id).filter(Boolean);
    const eligibleVoterIds = await User.find({ _id: { $in: teamIds }, role: 'investigator' }).distinct('_id');
    const userId = req.user.id.toString();
    if (!eligibleVoterIds.some(id => id.toString() === userId)) {
      return res.status(403).json({ error: 'Only assigned investigators can request evidence deletion' });
    }

    const actor = await User.findById(req.user.id).select('name email');
    const now = new Date();
    evidence.deletionRequest = {
      requestedBy: actor._id,
      reason,
      requestedAt: now,
      expiresAt: addWorkingDays(now, 3),
      eligibleVoterIds,
      votes: [{ userId: actor._id, decision: 'delete', votedAt: now }],
      status: 'pending'
    };
    caseItem.auditLog.push({
      action: 'EVIDENCE_DELETE_REQUEST',
      type: 'deletion_vote',
      filename: evidence.filename,
      description: `Deletion vote opened for evidence "${evidence.name}"`,
      performedBy: { userId: actor._id, name: actor.name, email: actor.email },
      details: { reason, expiresAt: evidence.deletionRequest.expiresAt, eligibleVoters: eligibleVoterIds.length }
    });
    const resolution = finalizeDeletionRequest(caseItem, evidence, now);
    await caseItem.save();
    await notifyCaseTeam(caseItem, {
      actorId: actor._id,
      actorName: actor.name,
      kind: resolution ? 'EVIDENCE_DELETION_RESOLVED' : 'EVIDENCE_DELETION_VOTE',
      title: resolution ? 'Evidence deletion vote resolved' : 'Evidence deletion vote requested',
      body: resolution
        ? `Evidence "${evidence.name}" was ${resolution === 'majority_delete' ? 'deleted' : 'kept'}.`
        : `Vote on deleting "${evidence.name}" before ${evidence.deletionRequest.expiresAt.toLocaleDateString()}.`,
      evidenceId: evidence._id
    }, actor._id);
    res.status(202).json({ success: true, deletionRequest: evidence.deletionRequest, deleted: evidence.deleted });
  } catch (err) {
    logger.error('Failed to create evidence deletion request:', err.message);
    res.status(500).json({ error: 'Failed to create evidence deletion request' });
  }
});

// POST /api/cases/:id/evidence/:evidenceId/deletion-vote - cast an investigator vote
router.post('/:id/evidence/:evidenceId/deletion-vote', requireInvestigatorCaseAccess, async (req, res) => {
  try {
    const decision = req.body.decision;
    if (!['delete', 'keep'].includes(decision)) return res.status(400).json({ error: 'Decision must be delete or keep' });
    const caseItem = req.caseItem;
    const evidence = caseItem.evidence.id(req.params.evidenceId);
    const request = evidence?.deletionRequest;
    if (!evidence || !request || request.status !== 'pending') return res.status(404).json({ error: 'Pending deletion vote not found' });
    if (request.expiresAt && new Date() >= request.expiresAt) {
      finalizeDeletionRequest(caseItem, evidence);
      await caseItem.save();
      await notifyCaseTeam(caseItem, {
        actorId: request.requestedBy,
        actorName: caseItem.team.find(member => member.id?.equals(request.requestedBy))?.name || 'System',
        kind: 'EVIDENCE_DELETION_RESOLVED',
        title: 'Evidence retained after vote deadline',
        body: `The deletion vote for "${evidence.name}" expired. The evidence was kept.`,
        evidenceId: evidence._id
      });
      return res.status(410).json({ error: 'The vote deadline passed and the evidence was retained' });
    }
    const userId = req.user.id.toString();
    if (!request.eligibleVoterIds.some(id => id.toString() === userId)) return res.status(403).json({ error: 'You are not eligible to vote on this request' });
    if (request.votes.some(vote => vote.userId.toString() === userId)) return res.status(409).json({ error: 'You have already voted on this request' });

    const actor = await User.findById(userId).select('name email');
    request.votes.push({ userId: actor._id, decision, votedAt: new Date() });
    caseItem.auditLog.push({
      action: 'EVIDENCE_DELETE_VOTE',
      type: 'deletion_vote',
      filename: evidence.filename,
      description: `${actor.name} voted to ${decision} evidence deletion`,
      performedBy: { userId: actor._id, name: actor.name, email: actor.email },
      details: { reason: request.reason, decision, expiresAt: request.expiresAt }
    });
    const resolution = finalizeDeletionRequest(caseItem, evidence);
    await caseItem.save();
    if (resolution) {
      await notifyCaseTeam(caseItem, {
        actorId: actor._id,
        actorName: actor.name,
        kind: 'EVIDENCE_DELETION_RESOLVED',
        title: 'Evidence deletion vote resolved',
        body: `Evidence "${evidence.name}" was ${resolution === 'majority_delete' ? 'deleted' : 'kept'}.`,
        evidenceId: evidence._id
      });
    }
    res.json({ success: true, deletionRequest: request, deleted: evidence.deleted });
  } catch (err) {
    logger.error('Failed to record evidence deletion vote:', err.message);
    res.status(500).json({ error: 'Failed to record evidence deletion vote' });
  }
});

// Direct evidence deletion is disabled; the delete route now starts the majority-vote workflow.
router.delete('/:caseId/evidence/:evidenceId', requireInvestigatorCaseAccess, async (req, res) => {
  try {
    const reason = typeof req.body.reason === 'string' ? req.body.reason.trim() : '';
    if (!reason) return res.status(400).json({ error: 'A reason for the deletion request is required' });
    const evidence = req.caseItem.evidence.id(req.params.evidenceId);
    if (!evidence || evidence.deleted) return res.status(404).json({ error: 'Evidence not found' });
    if (evidence.deletionRequest?.status === 'pending') {
      return res.status(409).json({ error: 'A deletion vote is already in progress' });
    }
    return res.status(409).json({ error: 'Use the evidence deletion-request endpoint to start a team vote' });
  } catch (err) {
    logger.error('Failed to validate evidence deletion request:', err.message);
    return res.status(500).json({ error: 'Failed to start evidence deletion vote' });
  }
});

// GET /api/cases/:id/download - download case details, evidence, and audit trail
router.get('/:id/download', requireInvestigatorCaseAccess, async (req, res) => {
  try {
    const caseItem = req.caseItem;

    // Populate team member details including job titles
    const teamWithDetails = [];
    for (const member of caseItem.team) {
      try {
        const user = await User.findById(member.id);
        teamWithDetails.push({
          name: member.name,
          email: member.email,
          jobTitle: user?.jobTitle || '(Not specified)'
        });
      } catch (err) {
        teamWithDetails.push({
          name: member.name,
          email: member.email,
          jobTitle: '(Unknown)'
        });
      }
    }

    const zip = new AdmZip();
    
    // Create case details text file
    let caseDetails = `DIGITAL EVIDENCE STORAGE SYSTEM - CASE REPORT
Generated on: ${moment().format('MMMM D, YYYY [at] HH:mm:ss')}

CASE DETAILS
-----------
Case ID: ${caseItem.caseId || caseItem.number}
Case Number: ${caseItem.number}
Case Type: ${(caseItem.caseType || 'Unknown').charAt(0).toUpperCase() + (caseItem.caseType || 'Unknown').slice(1)}
Name: ${caseItem.name}
Status: ${caseItem.status.toUpperCase()}
Description: ${caseItem.description}

TEAM MEMBERS
-----------
${teamWithDetails.map(member => `- ${member.name} (${member.email})
  Job Title: ${member.jobTitle}`).join('\n')}

EVIDENCE SUMMARY
-------------
Total Evidence Items: ${caseItem.evidence.length}
Active Items: ${caseItem.evidence.filter(ev => !ev.deleted).length}
Deleted Items: ${caseItem.evidence.filter(ev => ev.deleted).length}

EVIDENCE DETAILS
--------------
${caseItem.evidence.map((ev, index) => `
Evidence Item #${index + 1}
Name: ${ev.name}
File: ${ev.filename}
Type: ${ev.type}
Format: ${ev.format}
Hash Value: ${ev.hash}
Description: ${ev.description}
Status: ${ev.deleted ? 'DELETED' : 'ACTIVE'}
${ev.deleted ? `Deletion Reason: ${ev.deletedReason}\nDeleted At: ${moment(ev.deletedAt).format('MMMM D, YYYY [at] HH:mm:ss')}` : ''}
Location: evidence/${ev.filename}
`).join('\n---\n')}

CLOSURE DOCUMENTS
---------------
${caseItem.closureDocs ? caseItem.closureDocs.map(doc => `- ${doc.originalname} (Location: closure_docs/${doc.filename})`).join('\n') : 'No closure documents'}`;

    // Create separate audit trail log file
    let auditTrail = `DIGITAL EVIDENCE STORAGE SYSTEM - CASE AUDIT TRAIL
===============================================
Case ID: ${caseItem.caseId || caseItem.number}
Case #${caseItem.number}
Generated: ${moment().format('MMMM D, YYYY [at] HH:mm:ss')}

1. CASE ACTIVITY SUMMARY
------------------------
Total Actions: ${caseItem.auditLog.length}
Evidence Actions: ${caseItem.auditLog.filter(log => log.action.includes('EVIDENCE')).length}
Case Status Changes: ${caseItem.auditLog.filter(log => log.action.includes('CASE')).length}
Document Uploads: ${caseItem.auditLog.filter(log => log.action.includes('DOC')).length}

2. DETAILED ACTIVITY LOG (Most Recent First)
------------------------------------------
${caseItem.auditLog
  .sort((a, b) => new Date(b.date) - new Date(a.date))
  .map(log => `
TIME: ${moment(log.date).format('YYYY-MM-DD HH:mm:ss')}
USER: ${log.performedBy.name}
ROLE: ${log.performedBy.email}
ACTION: ${log.action}
DETAILS: ${log.description}
${log.filename ? `FILE: ${log.filename}` : ''}${log.details ? `\nADDITIONAL INFORMATION:${
  Object.entries(log.details)
    .filter(([_, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `\n  - ${key}: ${typeof value === 'object' ? JSON.stringify(value) : value}`)
    .join('')
}` : ''}`).join('\n\n' + '='.repeat(50) + '\n')}

3. EVIDENCE CHAIN OF CUSTODY
---------------------------
${caseItem.evidence.map((ev, index) => {
  const evidenceActions = caseItem.auditLog
    .filter(log => log.filename === ev.filename)
    .sort((a, b) => new Date(a.date) - new Date(b.date));
  
  return `
EVIDENCE #${index + 1}: ${ev.name}
File: ${ev.filename}
Type: ${ev.type}
Format: ${ev.format}
Hash: ${ev.hash}
Current Status: ${ev.deleted ? 'DELETED' : 'ACTIVE'}

Timeline:
${evidenceActions.map(action => 
  `- ${moment(action.date).format('YYYY-MM-DD HH:mm:ss')} : ${action.description} by ${action.performedBy.name}`
).join('\n')}
${ev.deleted ? `\nDeletion Details:
- When: ${moment(ev.deletedAt).format('YYYY-MM-DD HH:mm:ss')}
- Why: ${ev.deletedReason}` : ''}`
}).join('\n' + '-'.repeat(40) + '\n')}

4. CASE CLOSURE STATUS
---------------------
Current Status: ${caseItem.status.toUpperCase()}
${caseItem.status === 'closed' ? `
Closure Documents:
${caseItem.closureDocs.map((doc, index) => 
  `${index + 1}. ${doc.originalname}
   - Internal ID: ${doc.filename}
   - Added: ${moment(doc.uploadedAt).format('YYYY-MM-DD HH:mm:ss')}`
).join('\n')
}

Closure Verification:
- Total Required Documents: ${caseItem.closureDocs.length}
- Case Officially Closed: Yes
- Close Date: ${moment(caseItem.auditLog.find(log => log.action === 'CASE_CLOSE')?.date).format('YYYY-MM-DD HH:mm:ss')}`
 : 'Case remains open and active'}`;

    // Add text files to zip
    zip.addFile('case_details.txt', Buffer.from(caseDetails));
    zip.addFile('audit_trail.txt', Buffer.from(auditTrail));

    // Create directories in the zip
    zip.addFile('evidence/', Buffer.from(''));
    zip.addFile('closure_docs/', Buffer.from(''));

    // Add all evidence files
    const fs = require('fs');
    const uploadsDir = path.join(__dirname, '../uploads');
    
    for (const ev of caseItem.evidence.filter(item => !item.deleted)) {
      try {
        const evidencePath = getUploadedEvidencePath(ev.filename);
        
        if (evidencePath && fs.existsSync(evidencePath)) {
          process.stdout.write('Found evidence file: ' + ev.filename + '\n');
          zip.addLocalFile(evidencePath, 'evidence/');
          process.stdout.write('Successfully added evidence file: ' + ev.name + ' (' + ev.filename + ')\n');
        } else {
          process.stdout.write('Evidence file not found: ' + ev.filename + '\n');
          // Try alternative search in case the file structure is different
          try {
            const files = fs.readdirSync(uploadsDir);
            const matchingFile = files.find(f => f.includes(ev.filename) || f.endsWith(ev.filename));
            if (matchingFile) {
              const altPath = path.join(uploadsDir, matchingFile);
              zip.addLocalFile(altPath, 'evidence/');
              process.stdout.write('Found evidence file via alternative search: ' + matchingFile + '\n');
            }
          } catch (altErr) {
            process.stdout.write('Alternative search failed: ' + altErr + '\n');
          }
        }
      } catch (err) {
        process.stdout.write('Error adding evidence file to zip: ' + err + '\n');
      }
    }

    // Add closure documents
    if (caseItem.closureDocs) {
      for (const doc of caseItem.closureDocs) {
        try {
          // Log the closure doc details for debugging
          process.stdout.write('Adding closure doc: ' + JSON.stringify({
            filename: doc.filename,
            originalname: doc.originalname,
            path: doc.path
          }) + '\n');
          
          if (require('fs').existsSync(doc.path)) {
            zip.addLocalFile(doc.path, 'closure_docs/');
            process.stdout.write('Successfully added closure doc: ' + doc.originalname + '\n');
          } else {
            process.stdout.write('Closure document not found: ' + doc.path + '\n');
          }
        } catch (err) {
          process.stdout.write('Error adding closure document to zip: ' + err + '\n');
        }
      }
    }

    // Make sure audit trail is included
    zip.addFile('audit_trail.txt', Buffer.from(auditTrail));

    // Send the zip file
    const zipBuffer = zip.toBuffer();
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename=${caseItem.caseId || `case_${caseItem.number}`}_${moment().format('YYYYMMDD')}.zip`);
    res.send(zipBuffer);
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate case download' });
  }
});

// POST /api/cases/migrate/fix-missing-caseids - Migrate old cases to add caseId if missing
router.post('/migrate/fix-missing-caseids', async (req, res) => {
  try {
    // Find all cases without caseId
    const casesWithoutCaseId = await Case.find({ caseId: { $exists: false } });
    
    if (casesWithoutCaseId.length === 0) {
      return res.json({ message: 'No cases needing migration found', migratedCount: 0 });
    }

    let migratedCount = 0;
    for (const caseItem of casesWithoutCaseId) {
      try {
        // Generate a temporary caseId based on the case number
        // Format: YYYY-AUTO-NUMBER (YYYY from creation year, AUTO for auto-generated)
        const year = caseItem.createdAt ? new Date(caseItem.createdAt).getFullYear() : new Date().getFullYear();
        const tempCaseId = `${year}-AUTO-${caseItem.number}`;
        
        caseItem.caseId = tempCaseId;
        // Also add caseType if missing (default to 'civil')
        if (!caseItem.caseType) {
          caseItem.caseType = 'civil';
        }
        
        await caseItem.save();
        migratedCount++;
        console.log(`Migrated case ${caseItem.number} with generated caseId: ${tempCaseId}`);
      } catch (error) {
        console.error(`Failed to migrate case ${caseItem._id}:`, error.message);
      }
    }

    res.json({ 
      message: `Successfully migrated ${migratedCount} cases`,
      migratedCount,
      totalFound: casesWithoutCaseId.length
    });
  } catch (err) {
    console.error('Migration error:', err);
    res.status(500).json({ error: 'Migration failed', details: err.message });
  }
});

// POST /api/cases/:id/escalate-to-court - Escalate case to court
router.post('/:id/escalate-to-court', authenticateToken, async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const { courtDocketNumber } = req.body;
    
    if (!courtDocketNumber) {
      return res.status(400).json({ error: 'Court docket number is required' });
    }

    const caseItem = await Case.findById(req.params.id);
    if (!caseItem) {
      return res.status(404).json({ error: 'Case not found' });
    }

    // Get user info
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(400).json({ error: 'User not found' });
    }

    // Update case escalation details
    caseItem.escalationStatus = 'court';
    caseItem.escalationDetails = {
      escalatedToCourtDate: new Date(),
      escalatedToCourtBy: {
        userId: user._id,
        name: user.name,
        email: user.email
      },
      courtDocketNumber: courtDocketNumber
    };

    // Add audit log
    caseItem.auditLog.push({
      action: 'CASE_ESCALATED',
      type: 'status_change',
      description: `Case escalated to court with docket number: ${courtDocketNumber}`,
      performedBy: {
        userId: user._id,
        name: user.name,
        email: user.email
      },
      details: {
        courtDocketNumber: courtDocketNumber,
        escalationDate: new Date()
      }
    });

    await caseItem.save();
    res.json({ success: true, message: 'Case escalated to court', case: caseItem });
  } catch (err) {
    logger.error('Error escalating case:', err.message);
    res.status(500).json({ error: 'Failed to escalate case to court' });
  }
});

// PUT /api/cases/:id/add-update - Add case update
router.put('/:id/add-update', authenticateToken, async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const { details } = req.body;
    
    if (!details || !details.trim()) {
      return res.status(400).json({ error: 'Update details are required' });
    }

    const caseItem = await Case.findById(req.params.id);
    if (!caseItem) {
      return res.status(404).json({ error: 'Case not found' });
    }

    // Get user info
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(400).json({ error: 'User not found' });
    }

    // Add case update
    caseItem.caseUpdates.push({
      date: new Date(),
      updatedBy: {
        userId: user._id,
        name: user.name,
        email: user.email
      },
      details: details
    });

    // Also add to audit log
    caseItem.auditLog.push({
      action: 'CASE_UPDATE',
      type: 'update',
      description: `Case update added: ${details.substring(0, 100)}...`,
      performedBy: {
        userId: user._id,
        name: user.name,
        email: user.email
      },
      details: {
        updateText: details
      }
    });

    await caseItem.save();
    res.json({ success: true, message: 'Case update added', case: caseItem });
  } catch (err) {
    logger.error('Error adding case update:', err.message);
    res.status(500).json({ error: 'Failed to add case update' });
  }
});

module.exports = router;