'use strict';

const SITE_NAME = process.env.SITE_NAME || 'Professional Pool Players Union';

function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function slugify(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'section';
}

function inline(text) {
  let out = esc(text);
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" rel="noopener noreferrer" target="_blank">$1</a>');
  return out;
}

function renderMarkdown(md) {
  const lines = String(md || '').split(/\r?\n/);
  const html = [];
  const sections = [];
  let listType = null;
  let para = [];

  function flushPara() {
    if (para.length) {
      html.push('<p>' + inline(para.join(' ')) + '</p>');
      para = [];
    }
  }
  function flushList() {
    if (listType) {
      html.push(listType === 'ul' ? '</ul>' : '</ol>');
      listType = null;
    }
  }

  for (const raw of lines) {
    const line = String(raw).replace(/\s+$/, '');
    if (!line.trim()) { flushPara(); flushList(); continue; }

    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      flushPara(); flushList();
      const level = heading[1].length;
      const title = heading[2].trim();
      const id = slugify(title);
      sections.push({ id: id, title: title, level: level });
      html.push('<h' + level + ' id="' + esc(id) + '" class="doc-h">' +
        inline(title) +
        ' <a class="anchor" href="#' + esc(id) + '" title="Link to this section">#</a></h' + level + '>');
      continue;
    }

    if (/^(-{3,}|_{3,})$/.test(line.trim())) { flushPara(); flushList(); html.push('<hr />'); continue; }

    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) { flushPara(); flushList(); html.push('<blockquote>' + inline(quote[1]) + '</blockquote>'); continue; }

    const ul = /^[-*]\s+(.*)$/.exec(line);
    if (ul) {
      flushPara();
      if (listType !== 'ul') { flushList(); html.push('<ul>'); listType = 'ul'; }
      html.push('<li>' + inline(ul[1]) + '</li>');
      continue;
    }

    const ol = /^\d+\.\s+(.*)$/.exec(line);
    if (ol) {
      flushPara();
      if (listType !== 'ol') { flushList(); html.push('<ol>'); listType = 'ol'; }
      html.push('<li>' + inline(ol[1]) + '</li>');
      continue;
    }

    if (listType && html.length && html[html.length - 1].slice(-5) === '</li>') {
      html[html.length - 1] = html[html.length - 1].slice(0, -5) + ' ' + inline(line.trim()) + '</li>';
      continue;
    }

    para.push(line.trim());
  }

  flushPara();
  flushList();
  return { html: html.join('\n'), sections: sections };
}

function documentSections(body) {
  return renderMarkdown(body).sections.filter(function (s) { return s.level === 2; });
}

function diffRows(oldText, newText) {
  const a = String(oldText == null ? '' : oldText).split(/\r?\n/);
  const b = String(newText == null ? '' : newText).split(/\r?\n/);
  const m = a.length;
  const n = b.length;
  if (m * n > 2000000) return null;
  const dp = [];
  for (let i = 0; i <= m; i++) dp.push(new Uint32Array(n + 1));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const rows = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) { rows.push({ t: 'same', v: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { rows.push({ t: 'del', v: a[i] }); i++; }
    else { rows.push({ t: 'add', v: b[j] }); j++; }
  }
  while (i < m) { rows.push({ t: 'del', v: a[i] }); i++; }
  while (j < n) { rows.push({ t: 'add', v: b[j] }); j++; }
  return rows;
}

function renderDiff(oldText, newText) {
  const rows = diffRows(oldText, newText);
  if (!rows) return '<p class="muted">These versions are too large to compare automatically.</p>';
  const changed = rows.some(function (r) { return r.t !== 'same'; });
  if (!changed) return '<p class="muted">No textual differences between these versions.</p>';

  const keep = new Array(rows.length).fill(false);
  for (let k = 0; k < rows.length; k++) {
    if (rows[k].t !== 'same') {
      for (let d = Math.max(0, k - 2); d <= Math.min(rows.length - 1, k + 2); d++) keep[d] = true;
    }
  }
  const out = ['<div class="diff">'];
  let skipping = false;
  for (let k = 0; k < rows.length; k++) {
    if (!keep[k]) {
      if (!skipping) { out.push('<div class="diff-skip">. . .</div>'); skipping = true; }
      continue;
    }
    skipping = false;
    const r = rows[k];
    const mark = r.t === 'add' ? '+' : (r.t === 'del' ? '-' : ' ');
    out.push('<div class="diff-line diff-' + r.t + '"><span class="diff-mark">' + mark + '</span>' + esc(r.v || ' ') + '</div>');
  }
  out.push('</div>');
  return out.join('');
}

function formatDate(value) {
  if (!value) return '';
  const d = value instanceof Date ? value : new Date(value);
  if (isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
}

function csrfField(token) {
  return '<input type="hidden" name="_csrf" value="' + esc(token) + '" />';
}

const STYLES = [
  ':root{--bg:#0e1512;--panel:#152420;--panel2:#1b2f28;--line:#2b453c;--ink:#e8f1ec;--muted:#93a89f;--accent:#4cc38a;--accent2:#d7b56d;--danger:#e07a6a;}',
  '*{box-sizing:border-box}',
  'body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}',
  'a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}',
  'header.site{border-bottom:1px solid var(--line);background:#0b110f;position:sticky;top:0;z-index:5}',
  '.bar{max-width:1060px;margin:0 auto;padding:14px 20px;display:flex;align-items:center;gap:18px;flex-wrap:wrap}',
  '.brand{font-weight:700;letter-spacing:.2px;color:var(--ink);display:flex;align-items:center;gap:10px}',
  '.brand .dot{width:14px;height:14px;border-radius:50%;background:var(--accent2);box-shadow:0 0 0 3px #0b110f,0 0 0 4px var(--line);display:inline-block}',
  'nav.main{display:flex;gap:16px;flex-wrap:wrap;margin-left:auto;align-items:center}',
  'nav.main a{color:var(--muted);font-size:14px}nav.main a.on{color:var(--ink);border-bottom:2px solid var(--accent)}',
  'main{max-width:1060px;margin:0 auto;padding:28px 20px 80px}',
  '.narrow{max-width:640px;margin:0 auto}',
  '.card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:22px;margin-bottom:20px}',
  '.card.tight{padding:16px}',
  'h1{font-size:28px;line-height:1.25;margin:0 0 10px}h2{font-size:21px;margin:26px 0 8px}h3{font-size:17px;margin:20px 0 6px}h4{font-size:15px;margin:16px 0 6px}',
  '.muted{color:var(--muted)}.small{font-size:13px}',
  '.pill{display:inline-block;padding:2px 9px;border-radius:999px;border:1px solid var(--line);font-size:12px;color:var(--muted);background:var(--panel2)}',
  '.pill.on{color:#0b110f;background:var(--accent);border-color:var(--accent);font-weight:600}',
  '.pill.warn{color:#0b110f;background:var(--accent2);border-color:var(--accent2);font-weight:600}',
  '.pill.bad{color:#0b110f;background:var(--danger);border-color:var(--danger);font-weight:600}',
  'label{display:block;font-size:13px;color:var(--muted);margin:14px 0 5px;letter-spacing:.2px}',
  'input[type=text],input[type=email],input[type=password],input[type=tel],textarea,select{width:100%;padding:11px 12px;background:#0c1310;border:1px solid var(--line);border-radius:8px;color:var(--ink);font:inherit}',
  'textarea{min-height:120px;resize:vertical}',
  'input:focus,textarea:focus,select:focus{outline:2px solid var(--accent);outline-offset:1px}',
  '.btn{display:inline-block;padding:10px 16px;border-radius:8px;border:1px solid var(--accent);background:var(--accent);color:#08120d;font-weight:650;cursor:pointer;font-size:14px}',
  '.btn:hover{filter:brightness(1.08);text-decoration:none}',
  '.btn.ghost{background:transparent;color:var(--ink);border-color:var(--line)}',
  '.btn.danger{background:var(--danger);border-color:var(--danger);color:#1a0b08}',
  '.btn.tiny{padding:5px 10px;font-size:12px}',
  '.row{display:flex;gap:14px;flex-wrap:wrap}.row>*{flex:1 1 220px}',
  '.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:16px}',
  '.flash{border-radius:10px;padding:12px 14px;margin-bottom:18px;border:1px solid var(--line);background:var(--panel2)}',
  '.flash.ok{border-color:var(--accent);color:#d8ffe9}',
  '.flash.err{border-color:var(--danger);color:#ffdcd4}',
  '.doc{max-width:78ch}',
  '.doc p{margin:0 0 14px}.doc li{margin:0 0 6px}',
  '.doc blockquote{border-left:3px solid var(--accent2);margin:0 0 14px;padding:2px 0 2px 14px;color:var(--muted)}',
  '.doc hr{border:0;border-top:1px solid var(--line);margin:26px 0}',
  '.anchor{opacity:0;color:var(--muted);font-weight:400;font-size:.7em}',
  '.doc-h:hover .anchor{opacity:1}',
  '.comment{border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin-bottom:12px;background:var(--panel2)}',
  '.comment.reply{margin-left:26px;border-left:2px solid var(--accent)}',
  '.comment .meta{font-size:12px;color:var(--muted);display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:8px}',
  '.comment .alias{color:var(--accent2);font-weight:650}',
  '.comment .body{white-space:pre-wrap;word-wrap:break-word}',
  '.comment.removed .body{color:var(--muted);font-style:italic}',
  'table{width:100%;border-collapse:collapse;font-size:14px}',
  'th,td{text-align:left;padding:9px 10px;border-bottom:1px solid var(--line);vertical-align:top}',
  'th{color:var(--muted);font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.4px}',
  '.diff{font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;border:1px solid var(--line);border-radius:8px;overflow:hidden}',
  '.diff-line{padding:2px 10px;white-space:pre-wrap;word-break:break-word}',
  '.diff-mark{display:inline-block;width:14px;color:var(--muted)}',
  '.diff-add{background:rgba(76,195,138,.14)}.diff-del{background:rgba(224,122,106,.14)}',
  '.diff-skip{padding:4px 10px;color:var(--muted);background:#0c1310}',
  '.code{font:14px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:#0c1310;border:1px solid var(--line);border-radius:8px;padding:10px 12px;word-break:break-all}',
  '.codes{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px}',
  '.codes div{font:15px ui-monospace,Menlo,Consolas,monospace;background:#0c1310;border:1px solid var(--line);border-radius:6px;padding:8px 10px;text-align:center;letter-spacing:1px}',
  'footer.site{border-top:1px solid var(--line);color:var(--muted);font-size:13px;padding:22px 20px;text-align:center}',
  '.toc a{display:block;font-size:13px;color:var(--muted);padding:3px 0}',
  '@media(max-width:760px){nav.main{margin-left:0;width:100%}}'
].join('\n');

function navLinks(user, active) {
  const links = [];
  if (user) {
    links.push(['/proposal', 'The Charter', 'proposal']);
    links.push(['/documents', 'Documents', 'documents']);
    links.push(['/account', 'Account', 'account']);
    if (user.role === 'admin') links.push(['/admin', 'Admin', 'admin']);
  }
  const out = links.map(function (l) {
    return '<a href="' + l[0] + '"' + (active === l[2] ? ' class="on"' : '') + '>' + esc(l[1]) + '</a>';
  });
  if (user) {
    out.push('<form method="post" action="/logout" style="margin:0">' +
      csrfField(user.csrf || '') +
      '<button class="btn ghost tiny" type="submit">Sign out</button></form>');
  }
  return out.join('');
}

function layout(opts) {
  const o = opts || {};
  const title = o.title ? o.title + ' - ' + SITE_NAME : SITE_NAME;
  const parts = [];
  parts.push('<!doctype html><html lang="en"><head><meta charset="utf-8" />');
  parts.push('<meta name="viewport" content="width=device-width,initial-scale=1" />');
  parts.push('<meta name="robots" content="noindex,nofollow" />');
  parts.push('<title>' + esc(title) + '</title>');
  parts.push('<style>' + STYLES + '</style></head><body>');
  parts.push('<header class="site"><div class="bar">');
  parts.push('<a class="brand" href="' + (o.user ? '/proposal' : '/') + '"><span class="dot"></span>' + esc(SITE_NAME) + '</a>');
  parts.push('<nav class="main">' + navLinks(o.user, o.active) + '</nav>');
  parts.push('</div></header><main' + (o.narrow ? ' class="narrow"' : '') + '>');
  if (o.error) parts.push('<div class="flash err">' + esc(o.error) + '</div>');
  if (o.notice) parts.push('<div class="flash ok">' + esc(o.notice) + '</div>');
  parts.push(o.body || '');
  parts.push('</main><footer class="site">');
  parts.push(esc(SITE_NAME) + ' - private working portal. Invitation only. Comments are pseudonymous.');
  parts.push('</footer></body></html>');
  return parts.join('');
}

module.exports = {
  SITE_NAME,
  esc,
  slugify,
  renderMarkdown,
  documentSections,
  renderDiff,
  formatDate,
  csrfField,
  layout
};
