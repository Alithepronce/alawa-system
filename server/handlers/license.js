'use strict';
const license = require('../license');
const { HttpError } = require('../helpers');
function getStatus() { return { data: license.status() }; }
async function activate(ctx) { try { return { data: await license.activate(ctx.body) }; } catch (e) { throw new HttpError(400, e.message); } }
async function refresh() { try { return { data: await license.refresh() }; } catch (e) { throw new HttpError(503, e.message); } }
module.exports = { getStatus, activate, refresh };
