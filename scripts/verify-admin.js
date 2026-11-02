require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/User');

async function verifyAdmin() {
  try {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/dess');
    console.log('Connected to MongoDB\n');

    // Find all admin users
    const admins = await User.find({ role: 'admin' });
    
    if (admins.length === 0) {
      console.log('❌ No admin users found in database!');
      console.log('Run: node scripts/create-admin.js');
    } else {
      console.log(`✅ Found ${admins.length} admin user(s):\n`);
      admins.forEach(admin => {
        console.log(`  Email: ${admin.email}`);
        console.log(`  Name: ${admin.name}`);
        console.log(`  Role: ${admin.role}`);
        console.log(`  Has Password Hash: ${admin.password ? 'Yes' : 'No'}`);
        console.log(`  Created: ${admin.createdAt}`);
        console.log('');
      });
    }

    // Also show all users
    const allUsers = await User.find();
    console.log(`\nTotal users in database: ${allUsers.length}`);
    allUsers.forEach(user => {
      console.log(`  - ${user.name} (${user.email}) - ${user.role}`);
    });

    process.exit(0);
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}

verifyAdmin();
