// 마크다운 렌더링 (marked + DOMPurify + highlight.js)
import { esc, icon } from './ui.js';

let hooked = false;

function plain(text) {
  return `<p>${esc(text).replace(/\n/g, '<br>')}</p>`;
}

function codeBlock(code, lang, fast) {
  const l = String(lang || '').trim().split(/\s+/)[0].toLowerCase();
  let html = esc(code);
  const hl = window.hljs;
  try {
    if (hl && l && hl.getLanguage(l)) html = hl.highlight(code, { language: l, ignoreIllegals: true }).value;
    else if (hl && !fast && code.length < 15000) html = hl.highlightAuto(code).value;
  } catch { /* 하이라이트 실패 시 원문 */ }
  return `<div class="code"><div class="code-head"><span>${esc(l || 'code')}</span>` +
    `<button class="icon-btn code-copy" type="button" aria-label="코드 복사" title="복사">${icon('copy')}</button></div>` +
    `<pre><code class="hljs">${html}</code></pre></div>`;
}

/** fast=true: 스트리밍 중(언어 자동 감지 생략) */
export function renderMarkdown(text, fast = false) {
  const src = String(text || '');
  if (!window.marked || !window.DOMPurify) return plain(src);
  if (!hooked) {
    hooked = true;
    window.DOMPurify.addHook('afterSanitizeAttributes', (node) => {
      if (node.tagName === 'A') {
        node.setAttribute('target', '_blank');
        node.setAttribute('rel', 'noopener noreferrer');
      }
      if (node.tagName === 'IMG') node.setAttribute('loading', 'lazy');
    });
  }
  const renderer = new window.marked.Renderer();
  renderer.code = (tok) => codeBlock(tok.text ?? '', tok.lang, fast);
  try {
    const raw = window.marked.parse(src, { renderer, gfm: true, breaks: true, async: false });
    return window.DOMPurify.sanitize(raw, { ADD_ATTR: ['target'], FORBID_TAGS: ['style', 'form', 'input', 'iframe'] });
  } catch {
    return plain(src);
  }
}

/** TTS 용: 마크다운 기호 제거 */
export function markdownToSpeech(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' 코드 블록은 화면에서 확인해 주세요. ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*#{1,6}\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/\|/g, ' ')
    .replace(/^[\s:-]+$/gm, '')
    .replace(/[*_~#]/g, '')
    .replace(/https?:\/\/\S+/g, '링크')
    .replace(/\n{2,}/g, '\n')
    .trim();
}
