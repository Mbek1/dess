#!/usr/bin/env node

/**
 * Migration script to fix old cases without caseId
 * Run this once to populate caseId for all existing cases
 */

const mongoose = require('mongoose');
const Case = require('./models/Case');
require('dotenv').config();

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/DESS';

async function migrateCases() {
  try {
    console.log('Connecting to MongoDB...');
    await mongoose.connect(MONGODB_URI);
    console.log('Connected to MongoDB');

    // Find all cases without caseId
    const casesWithoutCaseId = await Case.find({ caseId: { $exists: false } });
    
    if (casesWithoutCaseId.length === 0) {
      console.log('✅ No cases needing migration found');
      await mongoose.connection.close();
      return;
    }

    console.log(`Found ${casesWithoutCaseId.length} cases without caseId`);

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
        console.log(`✅ Migrated case ${caseItem.number} with generated caseId: ${tempCaseId}`);
      } catch (error) {
        console.error(`❌ Failed to migrate case ${caseItem._id}:`, error.message);
      }
    }

    console.log(`\n✅ Migration complete: ${migratedCount}/${casesWithoutCaseId.length} cases migrated`);
    await mongoose.connection.close();
  } catch (err) {
    console.error('Migration error:', err);
    process.exit(1);
  }
}

migrateCases();
