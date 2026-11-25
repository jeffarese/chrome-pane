// A key event from the terminal, as the DevTools calls that press it in the page.
const VK = { Enter: 13, Tab: 9, Backspace: 8, Escape: 27, Delete: 46, Insert: 45, Home: 36, End: 35, PageUp: 33, PageDown: 34,
  ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40 };
for (let i = 1; i <= 12; i++) VK[`F${i}`] = 111 + i;
const PUNCT = { '-': ['Minus', 189], '=': ['Equal', 187], '[': ['BracketLeft', 219], ']': ['BracketRight', 221], '\\': ['Backslash', 220],
  ';': ['Semicolon', 186], "'": ['Quote', 222], ',': ['Comma', 188], '.': ['Period', 190], '/': ['Slash', 191], '`': ['Backquote', 192], ' ': ['Space', 32] };
const SHIFTED = { '!': '1', '@': '2', '#': '3', $: '4', '%': '5', '^': '6', '&': '7', '*': '8', '(': '9', ')': '0', _: '-', '+': '=',
  '{': '[', '}': ']', '|': '\\', ':': ';', '"': "'", '<': ',', '>': '.', '?': '/', '~': '`' };

const call = (params) => ({ method: 'Input.dispatchKeyEvent', params });

export function keyCalls(ev) {
  let modifiers = (ev.alt ? 1 : 0) | (ev.ctrl ? 2 : 0) | (ev.meta ? 4 : 0) | (ev.shift ? 8 : 0);
  const plain = !(ev.ctrl || ev.alt || ev.meta);
  const name = ev.name;
  if (name in VK) {
    const base = { key: name, code: name, windowsVirtualKeyCode: VK[name], nativeVirtualKeyCode: VK[name], modifiers };
    const down = name === 'Enter' && plain ? { type: 'keyDown', text: '\r', unmodifiedText: '\r', ...base } : { type: 'rawKeyDown', ...base };
    return [call(down), call({ type: 'keyUp', ...base })];
  }
  if ([...name].length !== 1) return [];
  if (name.codePointAt(0) >= 0x80) return [{ method: 'Input.insertText', params: { text: name } }];
  let unshifted = name;
  if (SHIFTED[name]) { unshifted = SHIFTED[name]; modifiers |= 8; }
  else if (/[A-Z]/.test(name)) { unshifted = name.toLowerCase(); modifiers |= 8; }
  let code, vk;
  if (/[a-z]/.test(unshifted)) { code = 'Key' + unshifted.toUpperCase(); vk = unshifted.toUpperCase().charCodeAt(0); }
  else if (/[0-9]/.test(unshifted)) { code = 'Digit' + unshifted; vk = unshifted.charCodeAt(0); }
  else if (PUNCT[unshifted]) [code, vk] = PUNCT[unshifted];
  const base = { key: name, modifiers, ...(code ? { code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk } : {}) };
  const down = plain ? { type: 'keyDown', text: name, unmodifiedText: unshifted, ...base } : { type: 'rawKeyDown', ...base };
  return [call(down), call({ type: 'keyUp', ...base })];
}
