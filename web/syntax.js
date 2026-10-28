'use strict';

(function () {
  const { escapeHtml } = window.GhArc;
  const aliases = { js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript', ts: 'typescript', tsx: 'typescript', py: 'python', pyw: 'python', rb: 'ruby', sh: 'bash', zsh: 'bash', yml: 'yaml', htm: 'xml', html: 'xml', svg: 'xml', cs: 'csharp', h: 'c', cc: 'cpp', hpp: 'cpp', md: 'markdown', dockerfile: 'dockerfile' };

  // Split token markup into balanced lines, retaining multiline strings and comments within a hunk.
  function lines(texts, path) {
    const name = path.split('/').pop().toLowerCase();
    const extension = name.includes('.') ? name.split('.').pop() : name;
    const language = aliases[extension] || extension;
    const raw = texts.join('\n');
    if (!hljs.getLanguage(language) || texts.length > 2000 || raw.length > 100000) return texts.map(escapeHtml);
    const template = document.createElement('template');
    template.innerHTML = hljs.highlight(raw, { language, ignoreIllegals: true }).value;
    const result = [''];
    const tags = [];
    function walk(node) {
      if (node.nodeType === Node.TEXT_NODE) {
        node.textContent.split('\n').forEach((part, index) => {
          if (index) {
            result[result.length - 1] += '</span>'.repeat(tags.length);
            result.push(tags.join(''));
          }
          result[result.length - 1] += escapeHtml(part);
        });
      } else {
        const tag = `<span class="${escapeHtml(node.className)}">`;
        result[result.length - 1] += tag;
        tags.push(tag);
        node.childNodes.forEach(walk);
        tags.pop();
        result[result.length - 1] += '</span>';
      }
    }
    template.content.childNodes.forEach(walk);
    return result;
  }

  function markRange(html, start, end) {
    if (start === end) return html;
    const template = document.createElement('template');
    template.innerHTML = html;
    const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    let offset = 0;
    for (const node of nodes) {
      const text = node.textContent;
      const from = Math.max(0, start - offset);
      const to = Math.min(text.length, end - offset);
      offset += text.length;
      if (from >= to) continue;
      const mark = document.createElement('span');
      mark.className = 'mark';
      mark.textContent = text.slice(from, to);
      node.replaceWith(document.createTextNode(text.slice(0, from)), mark, document.createTextNode(text.slice(to)));
    }
    return template.innerHTML;
  }

  function rows(rows, path) {
    for (const side of ['old', 'new']) {
      const selected = rows.filter((row) => ['context', side === 'old' ? 'del' : 'add'].includes(row.type));
      const html = lines(selected.map((row) => row.text), path);
      selected.forEach((row, index) => { row[side === 'old' ? 'syntaxOld' : 'syntaxNew'] = html[index]; });
      for (const row of rows.filter((row) => row.type === 'context-pair' && row[side])) {
        row[side].syntax = lines([row[side].text], path)[0];
      }
    }
  }
  window.PhabricadeSyntax = { lines, markRange, rows };
})();
