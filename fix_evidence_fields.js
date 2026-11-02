// Script to fix evidence entries missing required fields in all cases
// Usage: node fix_evidence_fields.js

const mongoose = require('mongoose');
const Case = require('./models/Case');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/dess';

async function fixEvidence() {
  await mongoose.connect(MONGODB_URI);
  const cases = await Case.find();
  let fixedCount = 0;
  for (const caseItem of cases) {
    let changed = false;
    for (const ev of caseItem.evidence) {
      if (!ev.name) { ev.name = ev.filename || 'Unknown'; changed = true; }
      if (!ev.description) { ev.description = 'No description'; changed = true; }
      if (!ev.hash) { ev.hash = 'N/A'; changed = true; }
      if (!ev.format) { ev.format = ev.type || 'Unknown'; changed = true; }
    }
    if (changed) {
      await caseItem.save();
      fixedCount++;
    }
  }
  console.log(`Fixed evidence in ${fixedCount} case(s).`);
  await mongoose.disconnect();
}

fixEvidence().catch(err => {
  console.error('Error fixing evidence:', err);
  process.exit(1);
});
