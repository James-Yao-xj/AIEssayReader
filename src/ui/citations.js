import { getState } from '../state/store.js';
import { resolveCitation } from '../ai/context.js';

/** Link only citation IDs that exist in the current paper, outside code and math. */
export function decorateCitations(element) {
  const paper = getState().paper;
  if (!paper) return;
  const walker = document.createTreeWalker(element, window.NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (!node.parentElement.closest('code, pre, .katex, button, a') && /\[p\d+-c\d+\]/.test(node.textContent)) nodes.push(node);
  }
  for (const node of nodes) {
    const parts = node.textContent.split(/(\[p\d+-c\d+\])/g);
    const fragment = document.createDocumentFragment();
    for (const part of parts) {
      const match = /^\[(p\d+-c\d+)\]$/.exec(part);
      const evidence = match && resolveCitation(paper, match[1]);
      if (!evidence) { fragment.append(document.createTextNode(part)); continue; }
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'paper-citation';
      button.textContent = part;
      button.title = `查看第 ${evidence.pageNum} 页原文`;
      button.addEventListener('click', () => {
        // Resolve again in case the document changed after the button was built.
        const current = getState().paper === paper && resolveCitation(paper, evidence.id);
        if (current) window.dispatchEvent(new window.CustomEvent('paper-citation', { detail: current }));
      });
      fragment.append(button);
    }
    node.replaceWith(fragment);
  }
}
