require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const User = require('../models/User');

async function diagnoseLogin() {
  try {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/dess', {
      serverSelectionTimeoutMS: 5000
    });
    console.log('✅ Connected to MongoDB\n');

    // Check if admin user exists
    const admin = await User.findOne({ email: 'admin@example.com' });
    
    if (!admin) {
      console.log('❌ Admin user NOT found in database');
      process.exit(1);
    }

    console.log('✅ Admin user found:');
    console.log(`   Email: ${admin.email}`);
    console.log(`   Name: ${admin.name}`);
    console.log(`   Role: ${admin.role}`);
    console.log(`   Password Hash: ${admin.password.substring(0, 20)}...`);
    console.log(`   Hash Length: ${admin.password.length}\n`);

    // Test password comparison
    const testPassword = 'admin123';
    const matches = await bcrypt.compare(testPassword, admin.password);
    
    console.log(`🔐 Password Test:`);
    console.log(`   Input: "${testPassword}"`);
    console.log(`   Match Result: ${matches ? '✅ PASS' : '❌ FAIL'}`);

    if (!matches) {
      console.log('\n⚠️  Password mismatch detected!');
      console.log('   This may indicate:');
      console.log('   1. Wrong password stored');
      console.log('   2. Hash algorithm incompatibility');
      console.log('   3. Data corruption');
    }

    // Try the actual login query
    console.log(`\n🔍 Login Query Test:`);
    const query = { email: 'admin@example.com', role: 'admin' };
    const foundUser = await User.findOne(query);
    console.log(`   Query: ${JSON.stringify(query)}`);
    console.log(`   Found: ${foundUser ? '✅ YES' : '❌ NO'}`);

    process.exit(0);
  } catch (err) {
    console.error('❌ Error:', err.message);
    process.exit(1);
  }
}

diagnoseLogin();
