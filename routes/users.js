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

// Multer setup for avatar uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, path.join(__dirname, '..', 'uploads', 'avatars'));
  },
  filename: function (req, file, cb) {
    const ext = path.extname(file.originalname);
    cb(null, `${req.params.id}-${Date.now()}${ext}`);
  }
});
const upload = multer({ storage: storage, limits: { fileSize: 5 * 1024 * 1024 } }); // 5MB

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
router.post('/:id/avatar', authenticateToken, upload.single('avatar'), async (req, res) => {
  try {
    // Ensure authenticated
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });

    // Only allow uploading to own profile unless admin
    if (req.user.id !== req.params.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Not authorized to upload avatar for this user' });
    }

    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    // Validate file is an image
    if (!req.file.mimetype || !req.file.mimetype.startsWith('image/')) {
      // remove uploaded file
      try { require('fs').unlinkSync(req.file.path); } catch (e) {}
      return res.status(400).json({ error: 'Uploaded file must be an image' });
    }

    // Resize and convert to JPG for consistency
    const outFilename = `${req.params.id}-${Date.now()}.jpg`;
    const outPath = path.join(__dirname, '..', 'uploads', 'avatars', outFilename);
    try {
      await sharp(req.file.path)
        .resize(300, 300, { fit: 'cover' })
        .jpeg({ quality: 80 })
        .toFile(outPath);
      // remove original uploaded file
      try { require('fs').unlinkSync(req.file.path); } catch (e) {}
    } catch (procErr) {
      logger.error('Image processing failed:', procErr.message);
      try { require('fs').unlinkSync(req.file.path); } catch (e) {}
      return res.status(500).json({ error: 'Failed to process image' });
    }

    const avatarUrl = `/uploads/avatars/${outFilename}`;
    user.profilePicture = avatarUrl;
    await user.save();
    res.json({ profilePicture: avatarUrl });
  } catch (err) {
    logger.error('Error uploading avatar:', err.message);
    res.status(500).json({ error: 'Failed to upload avatar' });
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

    const users = await User.find(query, 'name email role organizationName organizationRole _id').limit(20);
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
    const { name, email, password, organizationName, organizationRole, organizationIdNumber } = req.body;
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
