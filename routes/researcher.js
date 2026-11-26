const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const Case = require('../models/Case');
const User = require('../models/User');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const AdmZip = require('adm-zip');
const moment = require('moment');
const logger = require('../utils/logger');
const { authenticateToken } = require('../middleware/auth');

// Apply authentication middleware to all routes
router.use(authenticateToken);

function sanitizeResearcherCase(caseItem) {
  const result = caseItem.toObject();
  const restrictedFiles = new Set(result.evidence.filter(item => item.visibleToResearchers !== true).map(item => item.filename));
  result.evidence = result.evidence.filter(item => !item.deleted).map(item => item.visibleToResearchers === true
    ? {
        _id: item._id,
        name: item.name,
        description: item.description,
        type: item.type,
        format: item.format,
        uploadedAt: item.uploadedAt,
        availableToResearchers: true,
        hash: item.hash
      }
    : { _id: item._id, availableToResearchers: false });
  result.auditLog = result.auditLog.filter(log => !log.filename || !restrictedFiles.has(log.filename));
  result.closureDocs = result.closureDocs.map(({ filename, originalname, uploadedAt }) => ({ filename, originalname, uploadedAt }));
  return result;
}

// Escape user-provided text before using it in a MongoDB regular expression.
function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// GET /api/researcher/cases - searchable, filterable closed-case repository.
router.get('/cases', authenticateToken, async (req, res) => {
  try {
    if (!req.user || req.user.role !== 'researcher') {
      return res.status(403).json({ error: 'Access denied. Only researchers can access this endpoint.' });
    }

    const search = String(req.query.search || '').trim().slice(0, 120);
    const caseType = String(req.query.caseType || '').trim().toLowerCase();
    const evidenceType = String(req.query.evidenceType || '').trim();
    const organization = String(req.query.organization || '').trim().slice(0, 120);
    const allowedSorts = ['createdAt', 'updatedAt', 'name', 'caseId', 'caseType'];
    const sortBy = allowedSorts.includes(String(req.query.sortBy)) ? String(req.query.sortBy) : 'createdAt';
    const order = req.query.order === 'asc' ? 1 : -1;

    const query = { status: 'closed' };
    if (search) {
      const expression = new RegExp(escapeRegex(search), 'i');
      query.$or = [
        { name: expression },
        { caseId: expression },
        { description: expression },
        { keywords: expression },
        {
          evidence: {
            $elemMatch: {
              deleted: { $ne: true },
              visibleToResearchers: true,
              $or: [
                { name: expression },
                { description: expression },
                { type: expression },
                { format: expression }
              ]
            }
          }
        }
      ];
    }
    if (['civil', 'criminal'].includes(caseType)) query.caseType = caseType;
    if (evidenceType) query.evidence = {
      $elemMatch: {
        deleted: { $ne: true },
        visibleToResearchers: true,
        type: new RegExp('^' + escapeRegex(evidenceType) + '$', 'i')
      }
    };
    if (organization) {
      const matchingUsers = await User.find({
        role: 'investigator',
        organizationName: { $regex: '^' + escapeRegex(organization) + '$', $options: 'i' }
      }).select('_id').lean();
      const userIds = matchingUsers.map(user => user._id);
      query['createdBy.id'] = { $in: userIds };
    }

    const sortOptions = { [sortBy]: order, _id: -1 };
    const closedCases = await Case.find(query).sort(sortOptions).limit(250);
    let openCaseFound = null;
    if (search) {
      const expression = new RegExp(escapeRegex(search), 'i');
      const openCase = await Case.findOne({
        status: 'open',
        $or: [
          { name: expression },
          { caseId: expression },
          { description: expression },
          { keywords: expression }
        ]
      }).select('caseId name createdBy');
      if (openCase) openCaseFound = {
        caseId: openCase.caseId,
        name: openCase.name,
        createdBy: openCase.createdBy
      };
    }

    const cases = closedCases.map(sanitizeResearcherCase);
    const evidenceTypes = (await Case.distinct('evidence.type', {
      status: 'closed',
      'evidence.deleted': { $ne: true },
      'evidence.visibleToResearchers': true
    })).filter(Boolean).sort((a, b) => a.localeCompare(b));
    const organizations = [...new Set(await User.distinct('organizationName', {
      role: 'investigator',
      organizationName: { $exists: true, $ne: '' }
    }))].filter(Boolean).sort((a, b) => a.localeCompare(b));

    res.json({
      closedCases: cases,
      total: cases.length,
      filters: { evidenceTypes, organizations },
      openCaseFound
    });
  } catch (err) {
    logger.error('Error fetching researcher cases:', err);
    res.status(500).json({ error: 'Failed to fetch cases' });
  }
});

// GET /api/researcher/cases/:id/related - recommend similar closed cases using
// case classification, keywords, descriptions and researcher-visible evidence types.
router.get('/cases/:id/related', authenticateToken, async (req, res) => {
  try {
    if (!req.user || req.user.role !== 'researcher') {
      return res.status(403).json({ error: 'Access denied. Only researchers can access related cases.' });
    }
    const current = await Case.findById(req.params.id);
    if (!current || current.status !== 'closed') {
      return res.status(404).json({ error: 'Closed case not found' });
    }

    const currentEvidenceTypes = new Set(current.evidence
      .filter(item => !item.deleted && item.visibleToResearchers === true)
      .map(item => String(item.type || '').toLowerCase()).filter(Boolean));
    const sourceText = [current.name, current.description, current.keywords, current.caseId]
      .filter(Boolean).join(' ').toLowerCase();
    const terms = [...new Set(sourceText.match(/[a-z0-9]{4,}/g) || [])]
      .filter(term => !/^\\d+$/.test(term) && !['case', 'evidence', 'with', 'from', 'that', 'this', 'have', 'were', 'into'].includes(term))
      .slice(0, 12);

    const candidateQuery = {
      _id: { $ne: current._id },
      status: 'closed'
    };
    const or = [{ caseType: current.caseType }];
    if (terms.length) {
      const expression = new RegExp(terms.map(escapeRegex).join('|'), 'i');
      or.push({ name: expression }, { description: expression }, { keywords: expression });
    }
    if (currentEvidenceTypes.size) {
      or.push({ evidence: { $elemMatch: {
        deleted: { $ne: true },
        visibleToResearchers: true,
        type: { $in: [...currentEvidenceTypes] }
      } } });
    }
    candidateQuery.$or = or;

    const candidates = await Case.find(candidateQuery).sort({ updatedAt: -1 }).limit(60);
    const ranked = candidates.map(candidate => {
      const candidateText = [candidate.name, candidate.description, candidate.keywords, candidate.caseId]
        .filter(Boolean).join(' ').toLowerCase();
      const sharedTerms = terms.filter(term => candidateText.includes(term));
      const candidateTypes = new Set(candidate.evidence
        .filter(item => !item.deleted && item.visibleToResearchers === true)
        .map(item => String(item.type || '').toLowerCase()).filter(Boolean));
      const sharedTypes = [...currentEvidenceTypes].filter(type => candidateTypes.has(type));
      const sameCategory = candidate.caseType === current.caseType;
      const score = (sameCategory ? 2 : 0) + sharedTerms.length + sharedTypes.length * 2;
      return { candidate, score, sharedTerms, sharedTypes, reasons: [
        ...(sameCategory ? ['Same case classification'] : []),
        ...(sharedTypes.length ? ['Shared evidence type: ' + sharedTypes.join(', ')] : []),
        ...(sharedTerms.length ? ['Related terms: ' + sharedTerms.slice(0, 4).join(', ')] : [])
      ] };
    }).filter(item => item.sharedTerms?.length || item.sharedTypes?.length)
      .sort((a, b) => b.score - a.score || new Date(b.candidate.updatedAt) - new Date(a.candidate.updatedAt))
      .slice(0, 5);

    res.json({ relatedCases: ranked.map(({ candidate, score, reasons }) => ({
      ...sanitizeResearcherCase(candidate),
      relevanceScore: score,
      relevanceReasons: reasons
    })) });
  } catch (err) {
    logger.error('Error finding related researcher cases:', err);
    res.status(500).json({ error: 'Failed to find related cases' });
  }
});

// GET /api/researcher/cases/:id - fetch closed case by id
router.get('/cases/:id', authenticateToken, async (req, res) => {
  try {
    if (!req.user || req.user.role !== 'researcher') {
      return res.status(403).json({ error: 'Access denied. Only researchers can access this endpoint.' });
    }

    const caseItem = await Case.findById(req.params.id);
    if (!caseItem) {
      return res.status(404).json({ error: 'Case not found' });
    }

    // Researchers can only see closed cases
    if (caseItem.status !== 'closed') {
      return res.status(403).json({ error: 'Access denied. Only closed cases are visible to researchers.' });
    }

    res.json(sanitizeResearcherCase(caseItem));
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch case' });
  }
});

// GET /api/researcher/cases/:id/download - download closed case with evidence and audit trail
router.get('/cases/:id/download', authenticateToken, async (req, res) => {
  try {
    if (!req.user || req.user.role !== 'researcher') {
      return res.status(403).json({ error: 'Access denied. Only researchers can download cases.' });
    }

    const caseItem = await Case.findById(req.params.id);
    if (!caseItem) {
      return res.status(404).json({ error: 'Case not found' });
    }

    // Researchers can only download closed cases
    if (caseItem.status !== 'closed') {
      return res.status(403).json({ error: 'Access denied. Only closed cases can be downloaded.' });
    }

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
    const activeEvidence = caseItem.evidence.filter(evidence => !evidence.deleted);
    const downloadableEvidence = activeEvidence.filter(evidence => evidence.visibleToResearchers === true);
    const restrictedEvidence = activeEvidence.filter(evidence => evidence.visibleToResearchers !== true);
    const restrictedFilenames = new Set(restrictedEvidence.map(evidence => evidence.filename));
    const researcherAuditLog = caseItem.auditLog.filter(log => !log.filename || !restrictedFilenames.has(log.filename));

    // Create case details text file
    let caseDetails = `DIGITAL EVIDENCE STORAGE SYSTEM - CASE REPORT
Generated on: ${moment().format('MMMM D, YYYY [at] HH:mm:ss')}
Downloaded by: Researcher (${req.user.email})

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
Active Items: ${activeEvidence.length}
Deleted Items: ${caseItem.evidence.filter(ev => ev.deleted).length}
Available in this archive: ${downloadableEvidence.length}
Restricted to the investigative team: ${restrictedEvidence.length}

EVIDENCE DETAILS
--------------
${downloadableEvidence.map((ev, index) => `
Shared Evidence Item #${index + 1}
Name: ${ev.name}
Type: ${ev.type}
Format: ${ev.format}
Description: ${ev.description}
Hash Value: ${ev.hash}
Archive Location: evidence/${ev.filename}
`).join('\n---\n')}${restrictedEvidence.length ? `\n${restrictedEvidence.length} additional evidence item(s) are in this case but were not included in this researcher archive.` : ''}

CLOSURE DOCUMENTS
---------------
${caseItem.closureDocs ? caseItem.closureDocs.map(doc => `- ${doc.originalname} (Location: closure_docs/${doc.filename})`).join('\n') : 'No closure documents'}`;

    // Create audit trail log file
    let auditTrail = `DIGITAL EVIDENCE STORAGE SYSTEM - CASE AUDIT TRAIL
===============================================
Case ID: ${caseItem.caseId || caseItem.number}
Case #${caseItem.number}
Generated: ${moment().format('MMMM D, YYYY [at] HH:mm:ss')}
Downloaded by: Researcher (${req.user.email})

1. CASE ACTIVITY SUMMARY
------------------------
Total Actions: ${researcherAuditLog.length}
Evidence Actions: ${researcherAuditLog.filter(log => log.action.includes('EVIDENCE')).length}
Case Status Changes: ${researcherAuditLog.filter(log => log.action.includes('CASE')).length}
Document Uploads: ${researcherAuditLog.filter(log => log.action.includes('DOC')).length}

2. DETAILED ACTIVITY LOG (Most Recent First)
------------------------------------------
${researcherAuditLog
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
  const evidenceActions = researcherAuditLog
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
    const uploadsDir = path.join(__dirname, '../uploads');

    for (const ev of downloadableEvidence) {
      try {
        const privateEvidencePath = path.join(__dirname, '../private_uploads/evidence', path.basename(ev.filename));
        const legacyEvidencePath = path.join(uploadsDir, path.basename(ev.filename));
        const evidencePath = fs.existsSync(privateEvidencePath) ? privateEvidencePath : legacyEvidencePath;

        if (fs.existsSync(evidencePath)) {
          zip.addLocalFile(evidencePath, 'evidence/');
        } else {
          logger.warn('Shared evidence file missing from researcher archive:', ev.filename);
        }
      } catch (err) {
        logger.error('Failed to add shared evidence to researcher archive:', err.message);
      }
    }

    // Add closure documents
    if (caseItem.closureDocs) {
      for (const doc of caseItem.closureDocs) {
        try {
          if (require('fs').existsSync(doc.path)) {
            zip.addLocalFile(doc.path, 'closure_docs/');
            console.log('Successfully added closure doc: ' + doc.originalname);
          } else {
            console.log('Closure document not found: ' + doc.path);
          }
        } catch (err) {
          console.log('Error adding closure document to zip: ' + err);
        }
      }
    }

    // Send the zip file
    const zipBuffer = zip.toBuffer();
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename=${caseItem.caseId || `case_${caseItem.number}`}_researcher_${moment().format('YYYYMMDD')}.zip`);
    res.send(zipBuffer);
  } catch (err) {
    console.error('Error generating download:', err);
    res.status(500).json({ error: 'Failed to generate case download' });
  }
});

module.exports = router;
