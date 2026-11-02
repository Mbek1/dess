const fs = require('fs');
const path = require('path');

// Ensure logs directory exists
const logsDir = path.join(__dirname, '../logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

const logFile = path.join(logsDir, 'server.log');

// Format timestamp
function getTimestamp() {
  return new Date().toISOString();
}

// Write to log file
function writeLog(level, message, data = '') {
  const timestamp = getTimestamp();
  const logEntry = `[${timestamp}] [${level}] ${message}${data ? ' - ' + data : ''}\n`;
  
  // Write to file
  fs.appendFileSync(logFile, logEntry, 'utf8');
  
  // Also output to console
  if (level === 'ERROR') {
    console.error(`[${level}] ${message}`, data);
  } else {
    console.log(`[${level}] ${message}`, data);
  }
}

module.exports = {
  info: (message, data) => writeLog('INFO', message, data),
  error: (message, data) => writeLog('ERROR', message, data),
  warn: (message, data) => writeLog('WARN', message, data),
  debug: (message, data) => writeLog('DEBUG', message, data),
};
