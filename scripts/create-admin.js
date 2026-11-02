require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const User = require('../models/User');

async function createAdmin() {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/dess');
    console.log('Connected to MongoDB');

    const adminEmail = 'admin@example.com';
    const adminPassword = 'admin123';
    const adminName = 'Administrator';

    // Check if admin already exists
    const existing = await User.findOne({ email: adminEmail });
    if (existing) {
      console.log('Admin user already exists:', adminEmail);
      process.exit(0);
    }

    // Create admin user
    const hashedPassword = await bcrypt.hash(adminPassword, 10);
    const admin = await User.create({
      name: adminName,
      email: adminEmail,
      password: hashedPassword,
      role: 'admin',
      organizationName: 'System Administration',
      organizationRole: 'Administrator'
    });

    console.log('Admin user created successfully!');
    console.log('Email:', adminEmail);
    console.log('Password:', adminPassword);
    console.log('User ID:', admin._id);

    process.exit(0);
  } catch (err) {
    console.error('Error creating admin user:', err.message);
    process.exit(1);
  }
}

createAdmin();
