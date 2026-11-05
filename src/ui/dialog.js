/** Modal stack in opening order. Only the last modal handles keyboard input. */
const activeDialogs = [];
const FOCUSABLE = 'button, input, select, textarea, a[href], [tabindex]';

/**
 * Keep focus in an open modal and restore focus when it closes.
 *
 * Args:
 *   root: Visible modal overlay attached to the document body.
 *   onEscape: Close the modal, or its active inner view.
 * Returns:
 *   A cleanup function to call after hiding or removing the modal.
 */
export function activateDialog(root, onEscape) {
  const previousFocus = document.activeElement;
  const siblings = [...root.parentElement.children]
    .filter((element) => element !== root)
    .map((element) => [element, element.inert]);
  siblings.forEach(([element]) => { element.inert = true; });
  const token = {};
  activeDialogs.push(token);
  const isTop = () => activeDialogs.at(-1) === token;
  const controls = () => [...root.querySelectorAll(FOCUSABLE)].filter((element) =>
    !element.disabled && element.tabIndex >= 0 &&
    !element.closest('[hidden], [inert], [aria-hidden="true"]') &&
    getComputedStyle(element).display !== 'none' && getComputedStyle(element).visibility !== 'hidden');
  const focusFirst = () => (controls()[0] || root.querySelector('[role="dialog"]') || root).focus();
  const onKeydown = (event) => {
    if (!isTop()) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopImmediatePropagation();
      onEscape();
    } else if (event.key === 'Tab') {
      const items = controls();
      const index = items.indexOf(document.activeElement);
      if (index === -1 || (!event.shiftKey && index === items.length - 1) || (event.shiftKey && index === 0)) {
        event.preventDefault();
        (event.shiftKey ? items.at(-1) : items[0])?.focus();
        if (!items.length) focusFirst();
      }
    }
  };
  const onFocus = (event) => {
    if (isTop() && !root.contains(event.target)) focusFirst();
  };
  document.addEventListener('keydown', onKeydown, true);
  document.addEventListener('focusin', onFocus);
  focusFirst();
  let closed = false;
  return () => {
    if (closed) return;
    closed = true;
    activeDialogs.splice(activeDialogs.indexOf(token), 1);
    document.removeEventListener('keydown', onKeydown, true);
    document.removeEventListener('focusin', onFocus);
    siblings.forEach(([element, inert]) => { element.inert = inert; });
    if (previousFocus?.isConnected && !previousFocus.closest('[hidden], [inert]')) previousFocus.focus();
  };
}
