'use strict';

function intEnv(name, fallback) {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}

module.exports = {
  PORT: intEnv('PORT', 3000),
  BOT_COUNT: intEnv('BOT_COUNT', 40),
  MAX_PLAYERS: intEnv('MAX_PLAYERS', 1000),
  MAX_CONNECTIONS: intEnv('MAX_CONNECTIONS', 1500),

  // Anti-flood / anti-cheat limits
  MAX_MSG_BYTES: 512,          // hard cap on any client message
  MAX_MSGS_PER_SEC: 60,        // messages beyond this are ignored...
  KICK_MSGS_PER_SEC: 300,      // ...and beyond this the socket is closed
  INPUT_BURST: 20,             // token bucket size for input steps
  INPUT_QUEUE_MAX: 30,         // never buffer more than this many steps per player
  SEND_BACKPRESSURE_BYTES: 256 * 1024, // skip snapshots for clients that can't keep up
};
