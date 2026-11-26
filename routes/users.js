// User management routes
const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const User = require('../models/User');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const logger = require('../utils/logger');
const sharp = require('sharp');
const { authenticateToken } = require('../middleware/auth');

// Avatar uploads are kept in MongoDB so they survive Render restarts and deploys.
const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'];
    if (!allowedTypes.includes(file.mimetype)) {
      return cb(new Error('Upload a JPEG, PNG, WEBP, GIF or AVIF image'));
    }
    return cb(null, true);
  }
});

function handleAvatarUpload(req, res, next) {
  avatarUpload.single('avatar')(req, res, err => {
    if (!err) return next();
    const isTooLarge = err.code === 'LIMIT_FILE_SIZE';
    return res.status(isTooLarge ? 413 : 400).json({
      error: isTooLarge ? 'Profile pictures must be 5 MB or smaller' : err.message || 'Invalid profile picture upload'
    });
  });
}

const verificationUploadDir = path.join(__dirname, '..', 'private_uploads', 'verification');
fs.mkdirSync(verificationUploadDir, { recursive: true });

const verificationStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, verificationUploadDir),
  filename: (req, file, cb) => {
    const extension = { 'application/pdf': '.pdf', 'image/jpeg': '.jpg', 'image/png': '.png' }[file.mimetype] || '.bin';
    cb(null, `${crypto.randomUUID()}${extension}`);
  }
});
const verificationUpload = multer({
  storage: verificationStorage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowedTypes = ['application/pdf', 'image/jpeg', 'image/png'];
    cb(allowedTypes.includes(file.mimetype) ? null : new Error('Use a PDF, JPEG, or PNG document'), allowedTypes.includes(file.mimetype));
  }
});

function authorizeProfileOwner(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Authentication required' });
  if (req.user.id !== req.params.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Not authorized to access this profile' });
  }
  next();
}

function publicDocumentDetails(document) {
  if (!document) return null;
  return {
    originalName: document.originalName,
    size: document.size,
    status: document.status,
    uploadedAt: document.uploadedAt
  };
}

// POST /api/users/:id/avatar - upload profile avatar
// GET /api/users/:id/avatar - return a stored profile picture.
router.get('/:id/avatar', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ error: 'Invalid user ID' });
    }

    const user = await User.findById(req.params.id).select('+avatarData +avatarContentType');
    if (!user || !user.avatarData || user.avatarData.length === 0) {
      return res.status(404).json({ error: 'Profile picture not found' });
    }

    res.setHeader('Content-Type', user.avatarContentType || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return res.send(user.avatarData);
  } catch (err) {
    logger.error('Error retrieving avatar:', err.message);
    return res.status(500).json({ error: 'Failed to retrieve profile picture' });
  }
});

// POST /api/users/:id/avatar - upload profile avatar.
router.post('/:id/avatar', authenticateToken, handleAvatarUpload, async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    if (req.user.id !== req.params.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Not authorized to upload avatar for this user' });
    }

    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    let optimizedAvatar;
    try {
      optimizedAvatar = await sharp(req.file.buffer)
        .rotate()
        .resize(300, 300, { fit: 'cover', withoutEnlargement: true })
        .jpeg({ quality: 82 })
        .toBuffer();
    } catch (procErr) {
      logger.warn('Avatar image processing failed:', procErr.message);
      return res.status(400).json({ error: 'The selected file could not be processed as an image' });
    }

    user.avatarData = optimizedAvatar;
    user.avatarContentType = 'image/jpeg';
    user.avatarUpdatedAt = new Date();
    user.profilePicture = `/api/users/${user._id}/avatar?v=${user.avatarUpdatedAt.getTime()}`;
    await user.save();

    return res.json({ profilePicture: user.profilePicture });
  } catch (err) {
    logger.error('Error uploading avatar:', err.message);
    return res.status(500).json({ error: 'Failed to upload avatar' });
  }
});

// GET /api/users - get all users or search for users
router.get('/', authenticateToken, async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    const { search, userId } = req.query;
    let query = {};

    if (userId) {
      if (!mongoose.isValidObjectId(userId)) return res.status(400).json({ error: 'Invalid user ID' });
      query._id = userId;
    } else if (search) {
      query.$or = [
        { name: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } }
      ];
    }

    const users = await User.find(query, 'name email role userType organizationName organizationRole profilePicture _id').limit(20);
    res.json(users);
  } catch (err) {
    logger.error('Error fetching users:', err.message);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// GET /api/users/:id - get user profile by id
router.get('/:id', async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json({ 
      _id: user._id, 
      id: user._id,
      name: user.name, 
      email: user.email, 
      role: user.role,
      userType: user.userType || '',
      organizationName: user.organizationName || '',
      organizationRole: user.organizationRole || '',
      organizationIdNumber: user.organizationIdNumber || '',
      profilePicture: user.profilePicture || '',
      emailVerified: user.emailVerified
    });
  } catch (err) {
    logger.error('Error fetching user profile:', err.message);
    res.status(500).json({ error: 'Failed to fetch user profile' });
  }
});

// GET /api/users/:id/verification - return verification state without exposing stored file paths
router.get('/:id/verification', authenticateToken, authorizeProfileOwner, async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({
      emailVerified: user.emailVerified,
      identity: publicDocumentDetails(user.verificationDocuments?.identity),
      organization: publicDocumentDetails(user.verificationDocuments?.organization),
      selfieStatus: 'not_configured',
      livenessStatus: 'not_configured'
    });
  } catch (err) {
    logger.error('Error fetching verification status:', err.message);
    res.status(500).json({ error: 'Failed to fetch verification status' });
  }
});

// POST /api/users/:id/verification-documents/:kind - upload a private verification document
router.post('/:id/verification-documents/:kind', authenticateToken, authorizeProfileOwner, verificationUpload.single('document'), async (req, res) => {
  try {
    const { kind } = req.params;
    if (!['identity', 'organization'].includes(kind)) {
      if (req.file) await fs.promises.unlink(req.file.path).catch(() => {});
      return res.status(400).json({ error: 'Document kind must be identity or organization' });
    }
    if (!req.file) return res.status(400).json({ error: 'A PDF, JPEG, or PNG document is required' });

    const user = await User.findById(req.params.id);
    if (!user) {
      await fs.promises.unlink(req.file.path).catch(() => {});
      return res.status(404).json({ error: 'User not found' });
    }

    const previousDocument = user.verificationDocuments?.[kind];
    user.set(`verificationDocuments.${kind}`, {
      filename: req.file.filename,
      originalName: req.file.originalname,
      path: req.file.path,
      mimeType: req.file.mimetype,
      size: req.file.size,
      status: 'pending',
      uploadedAt: new Date()
    });
    await user.save();

    if (previousDocument?.path) {
      await fs.promises.unlink(previousDocument.path).catch(err => logger.warn('Could not remove replaced verification document:', err.message));
    }

    res.status(201).json({ kind, document: publicDocumentDetails(user.verificationDocuments[kind]) });
  } catch (err) {
    if (req.file) await fs.promises.unlink(req.file.path).catch(() => {});
    logger.error('Error uploading verification document:', err.message);
    res.status(500).json({ error: 'Failed to upload verification document' });
  }
});

// GET /api/users/:id/verification-documents/:kind - download an owner's private verification document
router.get('/:id/verification-documents/:kind', authenticateToken, authorizeProfileOwner, async (req, res) => {
  try {
    const { kind } = req.params;
    if (!['identity', 'organization'].includes(kind)) {
      return res.status(400).json({ error: 'Document kind must be identity or organization' });
    }
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const document = user.verificationDocuments?.[kind];
    if (!document || !fs.existsSync(document.path)) {
      return res.status(404).json({ error: 'Verification document not found' });
    }

    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.download(document.path, document.originalName, err => {
      if (err && !res.headersSent) {
        logger.error('Error downloading verification document:', err.message);
        res.status(500).json({ error: 'Failed to download verification document' });
      }
    });
  } catch (err) {
    logger.error('Error downloading verification document:', err.message);
    res.status(500).json({ error: 'Failed to download verification document' });
  }
});

// PATCH /api/users/:id - update user profile
router.patch('/:id', authenticateToken, async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    // Only allow updating own profile or admin
    if (req.user.id !== req.params.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Not authorized to update this user' });
    }
    const { name, email, password, userType, organizationName, organizationRole, organizationIdNumber } = req.body;
    const user = await User.findById(req.params.id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    if (name) user.name = name;
    if (email) {
      // Check if email is already taken by another user
      const existingUser = await User.findOne({ email, _id: { $ne: req.params.id } });
      if (existingUser) {
        return res.status(409).json({ error: 'Email already in use' });
      }
      if (user.email !== email) {
        user.email = email;
        user.emailVerified = false;
      }
    }
    if (password) {
      user.password = await bcrypt.hash(password, 10);
    }
    if (userType !== undefined) {
      if (!['student', 'researcher'].includes(userType)) {
        return res.status(400).json({ error: 'User type must be student or researcher.' });
      }
      if (user.role !== 'researcher') {
        return res.status(400).json({ error: 'User type applies to Case Repository accounts only.' });
      }
      user.userType = userType;
    }
    if (organizationName !== undefined) user.organizationName = organizationName;
    if (organizationRole !== undefined) user.organizationRole = organizationRole;
    if (organizationIdNumber !== undefined) user.organizationIdNumber = organizationIdNumber;
    if (req.body.profilePicture !== undefined) user.profilePicture = req.body.profilePicture;
    
    await user.save();
    res.json({ 
      message: 'Profile updated', 
      _id: user._id,
      id: user._id,
      name: user.name, 
      email: user.email, 
      role: user.role,
      userType: user.userType || '',
      organizationName: user.organizationName,
      organizationRole: user.organizationRole,
      organizationIdNumber: user.organizationIdNumber,
      profilePicture: user.profilePicture || ''
    });
  } catch (err) {
    logger.error('Error updating user profile:', err.message);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

module.exports = router;
