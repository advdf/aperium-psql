const path = require('path');
const fs = require('fs');

const DATA_DIR = path.resolve(process.env.APERIUM_DATA_DIR || './data');

function userDataPath(userId, filename) {
  const dir = path.join(DATA_DIR, userId);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, filename);
}

module.exports = { userDataPath, DATA_DIR };
