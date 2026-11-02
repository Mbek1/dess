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

// GET /api/researcher/cases - fetch cases (closed + info about open ones if found)
router.get('/cases', authenticateToken, async (req, res) => {
  try {
    if (!req.user || req.user.role !== 'researcher') {
      return res.status(403).json({ error: 'Access denied. Only researchers can access this endpoint.' });
    }

    const { search, status, sortBy = 'createdAt', order = 'desc' } = req.query;

    let closedQuery = { status: 'closed' };
    let searchQuery = {};

    if (search) {
      searchQuery.$or = [
        { name: { $regex: search, $options: 'i' } },
        { caseId: { $regex: search, $options: 'i' } },
        { description: { $regex: search, $options: 'i' } }
      ];
    }

    // Build full query for both closed and open cases (for search purposes)
    const fullSearchQuery = { ...closedQuery, ...searchQuery };
    
    // But only return closed cases
    const closedCaseQuery = { ...closedQuery, ...searchQuery };

    const sortOptions = {};
    sortOptions[sortBy] = order === 'asc' ? 1 : -1;

    // Get closed cases
    const closedCases = await Case.find(closedCaseQuery)
      .sort(sortOptions)
      .limit(100);

    // If search was performed, also check for open cases to return info
    let openCaseFound = null;
    if (search) {
      const openCaseQuery = { status: 'open', ...searchQuery };
      const openCases = await Case.find(openCaseQuery).limit(1);
      if (openCases.length > 0) {
        openCaseFound = openCases[0];
      }
    }

    res.json({ 
      closedCases: closedCases.map(sanitizeResearcherCase),
      openCaseFound: openCaseFound ? {
        caseId: openCaseFound.caseId,
        name: openCaseFound.name,
        createdBy: openCaseFound.createdBy
      } : null
    });
  } catch (err) {
    console.error('Error fetching cases:', err);
    res.status(500).json({ error: 'Failed to fetch cases' });
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
