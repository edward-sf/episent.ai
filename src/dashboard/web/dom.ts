export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

// Status shown as a coloured dot plus text, never colour alone.
export function statusBadge(label: string, color: string): HTMLSpanElement {
  const badge = el('span', 'status');
  const dot = el('span', 'status-dot');
  dot.style.backgroundColor = color;
  badge.append(dot, document.createTextNode(label));
  return badge;
}
