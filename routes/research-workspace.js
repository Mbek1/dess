const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();
const Case = require('../models/Case');
const ResearchWorkspace = require('../models/ResearchWorkspace');
const { authenticateToken } = require('../middleware/auth');

router.use(authenticateToken);

function requireResearcher(req, res, next) {
  if (!req.user || req.user.role !== 'researcher') {
    return res.status(403).json({ error: 'Only researcher accounts can use the research workspace.' });
  }
  next();
}

router.use(requireResearcher);

async function getWorkspace(userId) {
  return ResearchWorkspace.findOneAndUpdate(
    { user: userId },
    { $setOnInsert: { user: userId } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
}

async function getResearchableCase(caseId, evidenceId, userId) {
  if (!mongoose.isValidObjectId(caseId)) return { error: 'Invalid case reference', status: 400 };
  const caseItem = await Case.findById(caseId);
  if (!caseItem || caseItem.status !== 'closed' || ['under_review', 'hidden'].includes(caseItem.repositoryStatus || 'visible')) return { error: 'Repository case not found', status: 404 };
  let evidence = null;
  if (evidenceId) {
    if (!mongoose.isValidObjectId(evidenceId)) return { error: 'Invalid evidence reference', status: 400 };
    evidence = caseItem.evidence.id(evidenceId);
    if (!evidence || evidence.deleted || !(evidence.visibleToResearchers === true || (evidence.researcherAccessIds || []).some(id => String(id) === String(userId)))) {
      return { error: 'This evidence item is not available to researchers', status: 403 };
    }
  }
  return { caseItem, evidence };
}

router.get('/', async (req, res) => {
  try {
    const workspace = await getWorkspace(req.user.id);
    const result = workspace.toObject();
    const caseIds = [...new Set(result.bookmarks.map(item => String(item.caseId)))];
    const cases = caseIds.length ? await Case.find({ _id: { $in: caseIds } })
      .select('_id caseId name status repositoryStatus evidence').lean() : [];
    const caseMap = new Map(cases.map(item => [String(item._id), item]));
    result.bookmarks = result.bookmarks.filter(bookmark => {
      const caseItem = caseMap.get(String(bookmark.caseId));
      if (!caseItem || caseItem.status !== 'closed' || ['under_review', 'hidden'].includes(caseItem.repositoryStatus || 'visible')) return false;
      if (!bookmark.evidenceId) return true;
      const evidence = (caseItem.evidence || []).find(item => String(item._id) === String(bookmark.evidenceId));
      return Boolean(evidence && !evidence.deleted && (
        evidence.visibleToResearchers === true ||
        (evidence.researcherAccessIds || []).some(id => String(id?._id || id) === String(req.user.id))
      ));
    }).map(bookmark => {
      const caseItem = caseMap.get(String(bookmark.caseId));
      if (caseItem) {
        bookmark.caseReference = caseItem.caseId;
        bookmark.caseTitle = caseItem.name;
        if (bookmark.evidenceId) {
          const evidence = (caseItem.evidence || []).find(item => String(item._id) === String(bookmark.evidenceId));
          bookmark.evidenceName = evidence?.name || '';
        }
      }
      return bookmark;
    });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: 'Could not load research workspace' });
  }
});

router.post('/bookmarks', async (req, res) => {
  try {
    const { caseId, evidenceId } = req.body || {};
    const access = await getResearchableCase(caseId, evidenceId, req.user.id);
    if (access.error) return res.status(access.status).json({ error: access.error });
    const workspace = await getWorkspace(req.user.id);
    const duplicate = workspace.bookmarks.some(item =>
      String(item.caseId) === String(caseId) &&
      String(item.evidenceId || '') === String(evidenceId || '')
    );
    if (duplicate) return res.status(409).json({ error: 'This item is already bookmarked' });
    workspace.bookmarks.push({
      caseId: access.caseItem._id,
      evidenceId: access.evidence?._id || null,
      caseReference: access.caseItem.caseId,
      caseTitle: access.caseItem.name,
      evidenceName: access.evidence?.name || ''
    });
    await workspace.save();
    res.status(201).json(workspace);
  } catch (error) {
    res.status(500).json({ error: 'Could not save bookmark' });
  }
});

router.delete('/bookmarks/:bookmarkId', async (req, res) => {
  try {
    const workspace = await getWorkspace(req.user.id);
    const item = workspace.bookmarks.id(req.params.bookmarkId);
    if (!item) return res.status(404).json({ error: 'Bookmark not found' });
    item.deleteOne();
    await workspace.save();
    res.json(workspace);
  } catch (error) {
    res.status(500).json({ error: 'Could not remove bookmark' });
  }
});

router.post('/notes', async (req, res) => {
  try {
    const { caseId, evidenceId, title, content } = req.body || {};
    if (!String(title || '').trim() || !String(content || '').trim()) {
      return res.status(400).json({ error: 'A note title and content are required' });
    }
    const access = await getResearchableCase(caseId, evidenceId, req.user.id);
    if (access.error) return res.status(access.status).json({ error: access.error });
    const workspace = await getWorkspace(req.user.id);
    workspace.notes.push({
      caseId: access.caseItem._id,
      evidenceId: access.evidence?._id || null,
      caseReference: access.caseItem.caseId,
      caseTitle: access.caseItem.name,
      evidenceName: access.evidence?.name || '',
      title: String(title).trim(),
      content: String(content).trim()
    });
    await workspace.save();
    res.status(201).json(workspace);
  } catch (error) {
    res.status(500).json({ error: 'Could not save research note' });
  }
});

router.patch('/notes/:noteId', async (req, res) => {
  try {
    const workspace = await getWorkspace(req.user.id);
    const note = workspace.notes.id(req.params.noteId);
    if (!note) return res.status(404).json({ error: 'Research note not found' });
    const title = req.body?.title;
    const content = req.body?.content;
    if (title !== undefined) {
      if (!String(title).trim()) return res.status(400).json({ error: 'Note title cannot be empty' });
      note.title = String(title).trim().slice(0, 160);
    }
    if (content !== undefined) {
      if (!String(content).trim()) return res.status(400).json({ error: 'Note content cannot be empty' });
      note.content = String(content).trim().slice(0, 12000);
    }
    note.updatedAt = new Date();
    await workspace.save();
    res.json(workspace);
  } catch (error) {
    res.status(500).json({ error: 'Could not update research note' });
  }
});

router.delete('/notes/:noteId', async (req, res) => {
  try {
    const workspace = await getWorkspace(req.user.id);
    const note = workspace.notes.id(req.params.noteId);
    if (!note) return res.status(404).json({ error: 'Research note not found' });
    note.deleteOne();
    await workspace.save();
    res.json(workspace);
  } catch (error) {
    res.status(500).json({ error: 'Could not delete research note' });
  }
});

router.post('/collections', async (req, res) => {
  try {
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Collection name is required' });
    const caseIds = Array.isArray(req.body?.caseIds) ? [...new Set(req.body.caseIds.map(String))] : [];
    if (caseIds.some(id => !mongoose.isValidObjectId(id))) return res.status(400).json({ error: 'One or more case references are invalid' });
    if (caseIds.length) {
      const count = await Case.countDocuments({ _id: { $in: caseIds }, status: 'closed' });
      if (count !== caseIds.length) return res.status(403).json({ error: 'Collections can contain only closed repository cases' });
    }
    const workspace = await getWorkspace(req.user.id);
    if (workspace.collections.some(item => item.name.toLowerCase() === name.toLowerCase())) {
      return res.status(409).json({ error: 'A collection with this name already exists' });
    }
    workspace.collections.push({ name, description: String(req.body?.description || '').trim(), caseIds });
    await workspace.save();
    res.status(201).json(workspace);
  } catch (error) {
    res.status(500).json({ error: 'Could not create research collection' });
  }
});

router.patch('/collections/:collectionId', async (req, res) => {
  try {
    const workspace = await getWorkspace(req.user.id);
    const collection = workspace.collections.id(req.params.collectionId);
    if (!collection) return res.status(404).json({ error: 'Collection not found' });
    if (req.body?.name !== undefined) {
      const name = String(req.body.name).trim();
      if (!name) return res.status(400).json({ error: 'Collection name cannot be empty' });
      if (workspace.collections.some(item => String(item._id) !== String(collection._id) && item.name.toLowerCase() === name.toLowerCase())) {
        return res.status(409).json({ error: 'A collection with this name already exists' });
      }
      collection.name = name.slice(0, 100);
    }
    if (req.body?.description !== undefined) collection.description = String(req.body.description).trim().slice(0, 500);
    if (req.body?.caseIds !== undefined) {
      if (!Array.isArray(req.body.caseIds) || req.body.caseIds.some(id => !mongoose.isValidObjectId(id))) {
        return res.status(400).json({ error: 'Invalid collection case list' });
      }
      const ids = [...new Set(req.body.caseIds.map(String))];
      const count = ids.length ? await Case.countDocuments({ _id: { $in: ids }, status: 'closed' }) : 0;
      if (count !== ids.length) return res.status(403).json({ error: 'Collections can contain only closed repository cases' });
      collection.caseIds = ids;
    }
    collection.updatedAt = new Date();
    await workspace.save();
    res.json(workspace);
  } catch (error) {
    res.status(500).json({ error: 'Could not update collection' });
  }
});

router.delete('/collections/:collectionId', async (req, res) => {
  try {
    const workspace = await getWorkspace(req.user.id);
    const collection = workspace.collections.id(req.params.collectionId);
    if (!collection) return res.status(404).json({ error: 'Collection not found' });
    collection.deleteOne();
    await workspace.save();
    res.json(workspace);
  } catch (error) {
    res.status(500).json({ error: 'Could not delete collection' });
  }
});

router.get('/export', async (req, res) => {
  try {
    const workspace = await getWorkspace(req.user.id);
    const escapeHtml = value => String(value || '').replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]));
    const sections = [
      '<h1>DESS Research Workspace</h1>',
      '<p>Personal research export. This document contains your bookmarks, notes and collection details; it does not include original evidence files.</p>',
      '<h2>Bookmarks</h2><ul>' + workspace.bookmarks.map(item => '<li><strong>' + escapeHtml(item.caseReference) + ' — ' + escapeHtml(item.caseTitle) + '</strong>' + (item.evidenceName ? ' / ' + escapeHtml(item.evidenceName) : '') + '</li>').join('') + '</ul>',
      '<h2>Research Notes</h2>' + workspace.notes.map(note => '<section><h3>' + escapeHtml(note.title) + '</h3><p><strong>' + escapeHtml(note.caseReference) + ' — ' + escapeHtml(note.caseTitle) + (note.evidenceName ? ' / ' + escapeHtml(note.evidenceName) : '') + '</strong></p><p>' + escapeHtml(note.content).replace(/\n/g, '<br>') + '</p></section>').join(''),
      '<h2>Collections</h2>' + workspace.collections.map(item => '<section><h3>' + escapeHtml(item.name) + '</h3><p>' + escapeHtml(item.description) + '</p><p>Cases saved: ' + item.caseIds.length + '</p></section>').join('')
    ];
    const document = '<!doctype html><html><head><meta charset="utf-8"><title>DESS Research Workspace</title><style>body{font-family:Arial,sans-serif;line-height:1.55;color:#18283c;margin:40px}h1,h2{color:#12365a}section{border-bottom:1px solid #ddd;padding:10px 0}</style></head><body>' + sections.join('') + '</body></html>';
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="DESS-Research-Workspace.html"');
    res.send(document);
  } catch (error) {
    res.status(500).json({ error: 'Could not export research workspace' });
  }
});

module.exports = router;
