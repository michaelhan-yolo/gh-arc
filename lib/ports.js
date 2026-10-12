'use strict';

// gh-arc answers on DEFAULT_PORT. The pf rule gh arc setup installs forwards port 80 to
// FORWARD_PORT instead: pf breaks direct connections to a port it forwards to, so the forward
// gets a port of its own that nothing connects to directly.
module.exports = {
  DEFAULT_PORT: 7799,
  FORWARD_PORT: 7798,
};
