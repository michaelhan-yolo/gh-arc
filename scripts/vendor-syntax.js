'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const source = path.dirname(require.resolve('@highlightjs/cdn-assets/package.json'));
fs.mkdirSync(path.join(root, 'web/vendor'), { recursive: true });
for (const [from, to] of [['highlight.min.js', 'highlight.min.js'], ['LICENSE', 'highlight.LICENSE']]) {
  fs.copyFileSync(path.join(source, from), path.join(root, 'web/vendor', to));
}
