'use strict';

// During development data lives beside the source. Packaged Windows builds
// provide ALAWA_DATA_DIR so they never attempt to write into app.asar.
const path = require('node:path');

module.exports = process.env.ALAWA_DATA_DIR
  ? path.resolve(process.env.ALAWA_DATA_DIR)
  : path.join(__dirname, '..', 'data');
