export const INSPECTOR_BRIDGE_SOURCE = String.raw`(() => {
  'use strict';
  const script = document.currentScript;
  if (!script || script.dataset.openlinkInstalled === 'true') return;
  script.dataset.openlinkInstalled = 'true';

  const sessionId = script.dataset.openlinkSession || '';
  const nonce = script.dataset.openlinkNonce || '';
  let allowedOrigins = [];
  try {
    allowedOrigins = JSON.parse(atob(script.dataset.openlinkOrigins || 'W10='));
  } catch {}
  const referrerOrigin = (() => {
    try { return new URL(document.referrer).origin; } catch { return ''; }
  })();
  const parentOrigin = allowedOrigins.includes(referrerOrigin) ? referrerOrigin : allowedOrigins[0];
  if (!sessionId || !nonce || !parentOrigin) return;

  const CHANNEL = 'openlink.browser.inspector';
  const VERSION = 1;
  const elementRefs = new WeakMap();
  const refElements = new Map();
  const originalStyles = new WeakMap();
  const originalThemeTokens = new Map();
  let refSequence = 0;
  let inspectActive = false;
  let selectedElement = null;
  let lastActivityAt = 0;

  const overlay = document.createElement('div');
  overlay.dataset.openlinkInspectorOverlay = 'true';
  Object.assign(overlay.style, {
    position: 'fixed', zIndex: '2147483647', pointerEvents: 'none', display: 'none',
    border: '1.5px solid #6d5dfc', background: 'rgba(109,93,252,.10)',
    boxSizing: 'border-box', borderRadius: '2px', transition: 'transform 45ms linear,width 45ms linear,height 45ms linear'
  });
  const label = document.createElement('div');
  Object.assign(label.style, {
    position: 'absolute', left: '-1px', bottom: '100%', maxWidth: '360px',
    padding: '3px 6px', borderRadius: '4px 4px 4px 0', background: '#6d5dfc', color: '#fff',
    font: '500 11px/15px ui-monospace,SFMono-Regular,Menlo,monospace', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
  });
  overlay.appendChild(label);
  const mountOverlay = () => {
    if (!overlay.isConnected && document.documentElement) document.documentElement.appendChild(overlay);
  };
  mountOverlay();

  function send(payload) {
    window.parent.postMessage({ channel: CHANNEL, version: VERSION, sessionId, nonce, payload }, parentOrigin);
  }

  function activity(kind) {
    const now = Date.now();
    if (now - lastActivityAt < 500) return;
    lastActivityAt = now;
    send({ type: 'human.activity', activity: kind });
  }

  function getRef(element) {
    let ref = elementRefs.get(element);
    if (!ref) {
      ref = 'el-' + (++refSequence).toString(36);
      elementRefs.set(element, ref);
      refElements.set(ref, typeof WeakRef === 'function' ? new WeakRef(element) : { deref: () => element });
    }
    return ref;
  }

  function compactText(element) {
    return (element.getAttribute('aria-label') || element.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 240);
  }

  function selectorFor(element) {
    if (element.id && /^[A-Za-z][\w:.-]*$/.test(element.id)) return '#' + CSS.escape(element.id);
    const testId = element.getAttribute('data-testid');
    if (testId) return '[data-testid="' + CSS.escape(testId) + '"]';
    const parts = [];
    let current = element;
    while (current && current.nodeType === Node.ELEMENT_NODE && parts.length < 6) {
      let part = current.localName;
      const parent = current.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter((sibling) => sibling.localName === current.localName);
        if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(current) + 1) + ')';
      }
      parts.unshift(part);
      current = parent;
    }
    return parts.join(' > ');
  }

  function describe(element) {
    const rect = element.getBoundingClientRect();
    const attributes = {};
    for (const attribute of Array.from(element.attributes).slice(0, 40)) {
      if (!/^on/i.test(attribute.name) && attribute.value.length <= 500) attributes[attribute.name] = attribute.value;
    }
    return {
      ref: getRef(element), tagName: element.localName, role: element.getAttribute('role') || undefined,
      text: compactText(element) || undefined, selector: selectorFor(element),
      componentName: element.getAttribute('data-openlink-component') || element.getAttribute('data-component') || undefined,
      source: element.getAttribute('data-openlink-source') || undefined,
      bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, attributes
    };
  }

  function show(element) {
    mountOverlay();
    const info = describe(element);
    overlay.style.display = 'block';
    overlay.style.transform = 'translate(' + info.bounds.x + 'px,' + info.bounds.y + 'px)';
    overlay.style.width = info.bounds.width + 'px';
    overlay.style.height = info.bounds.height + 'px';
    label.textContent = (info.componentName ? info.componentName + ' · ' : '') + info.tagName + (info.source ? ' · ' + info.source : '');
    return info;
  }

  function hide() { if (!selectedElement) overlay.style.display = 'none'; }
  function elementAt(x, y) {
    overlay.style.display = 'none';
    const element = document.elementFromPoint(x, y);
    if (inspectActive && element) show(element);
    return element;
  }

  document.addEventListener('pointermove', (event) => {
    if (!inspectActive) return;
    const element = elementAt(event.clientX, event.clientY);
    if (element && element !== overlay && !overlay.contains(element)) send({ type: 'inspect.hover', element: show(element) });
  }, true);
  document.addEventListener('pointerleave', () => { if (inspectActive) hide(); }, true);
  document.addEventListener('click', (event) => {
    if (!inspectActive) return;
    const element = elementAt(event.clientX, event.clientY);
    if (!element || element === overlay || overlay.contains(element)) return;
    event.preventDefault(); event.stopImmediatePropagation();
    selectedElement = element;
    inspectActive = false;
    send({ type: 'inspect.selected', element: show(element) });
  }, true);
  document.addEventListener('pointerdown', () => activity('pointer'), true);
  document.addEventListener('keydown', () => activity('keyboard'), true);
  document.addEventListener('wheel', () => activity('scroll'), { capture: true, passive: true });

  function resolveElement(action) {
    if (action.ref) return refElements.get(action.ref)?.deref();
    if (action.selector) {
      try { return document.querySelector(action.selector); } catch { return null; }
    }
    if (Number.isFinite(action.x) && Number.isFinite(action.y)) return elementAt(action.x, action.y);
    return null;
  }

  function pageSnapshot() {
    const nodes = [];
    const selector = 'a,button,input,textarea,select,[role],[contenteditable="true"],h1,h2,h3,main,nav,form';
    for (const element of Array.from(document.querySelectorAll(selector)).slice(0, 1000)) {
      const rect = element.getBoundingClientRect();
      if (rect.width && rect.height) nodes.push(describe(element));
    }
    return JSON.stringify({ url: location.href, title: document.title, nodes });
  }

  const editableProperties = new Set([
    'color', 'background-color', 'font-size', 'font-weight', 'line-height', 'text-align',
    'width', 'height', 'min-width', 'max-width', 'margin', 'padding', 'gap', 'border-radius',
    'border-color', 'border-width', 'opacity', 'display', 'position', 'justify-content',
    'align-items', 'flex-direction', 'box-shadow'
  ]);

  function safeStyleValue(value) {
    return typeof value === 'string' && value.length <= 256
      && !/[;{}\u0000-\u001f]/.test(value)
      && !/(?:url\s*\(|expression\s*\(|javascript:|@import)/i.test(value);
  }

  function readStyles(element) {
    const computed = getComputedStyle(element);
    const properties = {};
    for (const property of editableProperties) properties[property] = computed.getPropertyValue(property);
    return properties;
  }

  function setElementStyle(element, property, value) {
    if (!editableProperties.has(property) || !safeStyleValue(value)) throw new Error('Style value is not supported');
    let originals = originalStyles.get(element);
    if (!originals) { originals = new Map(); originalStyles.set(element, originals); }
    if (!originals.has(property)) originals.set(property, {
      value: element.style.getPropertyValue(property),
      priority: element.style.getPropertyPriority(property)
    });
    element.style.setProperty(property, value);
    return { element: describe(element), styles: readStyles(element) };
  }

  function resetElementStyle(element, property) {
    if (!editableProperties.has(property)) throw new Error('Style property is not supported');
    const originals = originalStyles.get(element);
    const original = originals && originals.get(property);
    if (original) {
      if (original.value) element.style.setProperty(property, original.value, original.priority);
      else element.style.removeProperty(property);
      originals.delete(property);
    }
    return { element: describe(element), styles: readStyles(element) };
  }

  function readThemeTokens() {
    const computed = getComputedStyle(document.documentElement);
    const tokens = {};
    for (let index = 0; index < computed.length && Object.keys(tokens).length < 32; index++) {
      const token = computed.item(index);
      if (!token.startsWith('--') || !/(?:color|background|foreground|primary|secondary|muted|accent|border|surface|ring)/i.test(token)) continue;
      const value = computed.getPropertyValue(token).trim();
      if (value && CSS.supports('color', value)) tokens[token] = value;
    }
    return tokens;
  }

  function setThemeToken(token, value) {
    if (!/^--[a-zA-Z0-9_-]{1,64}$/.test(token) || !safeStyleValue(value) || !CSS.supports('color', value)) {
      throw new Error('Theme token value is not supported');
    }
    const available = readThemeTokens();
    if (!Object.prototype.hasOwnProperty.call(available, token)) throw new Error('Theme token is not available');
    if (!originalThemeTokens.has(token)) originalThemeTokens.set(token, document.documentElement.style.getPropertyValue(token));
    document.documentElement.style.setProperty(token, value);
    return readThemeTokens();
  }

  function resetThemeToken(token) {
    if (!/^--[a-zA-Z0-9_-]{1,64}$/.test(token) || !originalThemeTokens.has(token)) throw new Error('Theme token is not available');
    const original = originalThemeTokens.get(token);
    if (original) document.documentElement.style.setProperty(token, original);
    else document.documentElement.style.removeProperty(token);
    originalThemeTokens.delete(token);
    return readThemeTokens();
  }

  function layerSnapshot(root) {
    const nodes = [];
    const visit = (element, depth, parentRef) => {
      if (!element || depth > 7 || nodes.length >= 400 || element === overlay || element.hasAttribute('data-openlink-inspector-overlay')) return;
      if (['script', 'style', 'meta', 'link', 'noscript', 'template'].includes(element.localName)) return;
      const rect = element.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const info = describe(element);
      nodes.push({ element: info, depth, parentRef });
      for (const child of Array.from(element.children)) visit(child, depth + 1, info.ref);
    };
    const start = root || document.body || document.documentElement;
    visit(start, 0, undefined);
    return JSON.stringify({ nodes });
  }

  function pagePath() {
    return location.pathname.replace(/^\/v1\/browser\/(?:gateway\/)?sessions\/[^/]+\/preview(?=\/|$)/, '') || '/';
  }

  function clippedRect(rect) {
    const maxX = Math.max(0, window.innerWidth - 1);
    const maxY = Math.max(0, window.innerHeight - 1);
    const x = Math.max(0, Math.min(maxX, rect.x));
    const y = Math.max(0, Math.min(maxY, rect.y));
    const right = Math.max(x + 1, Math.min(window.innerWidth, rect.x + rect.width));
    const bottom = Math.max(y + 1, Math.min(window.innerHeight, rect.y + rect.height));
    return { x, y, width: right - x, height: bottom - y };
  }

  async function execute(envelope) {
    const action = envelope.action;
    const result = { version: VERSION, actionId: envelope.actionId, sessionId, ok: true };
    try {
      switch (action.type) {
        case 'page.navigate': {
          const target = new URL(action.url, location.href);
          if (target.origin !== location.origin) throw new Error('Native preview navigation must stay on the preview origin');
          setTimeout(() => location.assign(target.href), 0); break;
        }
        case 'page.back': setTimeout(() => history.back(), 0); break;
        case 'page.forward': setTimeout(() => history.forward(), 0); break;
        case 'page.reload': setTimeout(() => location.reload(), 0); break;
        case 'page.read': result.snapshot = pageSnapshot(); break;
        case 'preview.styles.read': {
          const element = refElements.get(action.ref)?.deref();
          if (!element) throw new Error('Element is no longer available');
          result.element = describe(element);
          result.snapshot = JSON.stringify({ styles: readStyles(element) });
          break;
        }
        case 'preview.layers.read': {
          const root = action.rootRef ? refElements.get(action.rootRef)?.deref() : undefined;
          if (action.rootRef && !root) throw new Error('Layer root is no longer available');
          result.snapshot = layerSnapshot(root);
          break;
        }
        case 'preview.style.set': {
          const element = refElements.get(action.ref)?.deref();
          if (!element) throw new Error('Element is no longer available');
          const changed = setElementStyle(element, action.property, action.value);
          result.element = changed.element;
          result.snapshot = JSON.stringify({ styles: changed.styles });
          break;
        }
        case 'preview.style.reset': {
          const element = refElements.get(action.ref)?.deref();
          if (!element) throw new Error('Element is no longer available');
          const changed = resetElementStyle(element, action.property);
          result.element = changed.element;
          result.snapshot = JSON.stringify({ styles: changed.styles });
          break;
        }
        case 'preview.theme.read': result.snapshot = JSON.stringify({ tokens: readThemeTokens() }); break;
        case 'preview.theme.set': result.snapshot = JSON.stringify({ tokens: setThemeToken(action.token, action.value) }); break;
        case 'preview.theme.reset': result.snapshot = JSON.stringify({ tokens: resetThemeToken(action.token) }); break;
        case 'preview.element.activate': {
          const element = refElements.get(action.ref)?.deref();
          if (!element) throw new Error('Element is no longer available');
          element.scrollIntoView({ block: 'center', inline: 'center' });
          selectedElement = element;
          result.element = show(element);
          break;
        }
        case 'preview.annotation.select': {
          const element = elementAt(action.x, action.y);
          const rect = clippedRect(action.width && action.height && (action.width > 4 || action.height > 4)
            ? { x: action.x, y: action.y, width: action.width, height: action.height }
            : element?.getBoundingClientRect() || { x: action.x, y: action.y, width: 1, height: 1 });
          if (element && element !== overlay && !overlay.contains(element)) result.element = describe(element);
          result.snapshot = JSON.stringify({
            pagePath: pagePath(),
            bounds: rect
          });
          break;
        }
        case 'element.click': {
          const element = resolveElement(action);
          if (!element) throw new Error('Element not found');
          element.click(); result.element = describe(element); break;
        }
        case 'element.hover': {
          const element = resolveElement(action);
          if (!element) throw new Error('Element not found');
          element.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
          element.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
          result.element = describe(element); break;
        }
        case 'element.type': {
          const element = resolveElement(action);
          if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element.isContentEditable)) throw new Error('Editable element not found');
          element.focus();
          if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
            const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')?.set;
            if (setter) setter.call(element, action.text); else element.value = action.text;
          } else element.textContent = action.text;
          element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: action.text }));
          element.dispatchEvent(new Event('change', { bubbles: true }));
          if (action.submit) element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
          result.element = describe(element); break;
        }
        case 'element.drag': {
          const start = elementAt(action.from.x, action.from.y);
          if (!start) throw new Error('Drag source not found');
          start.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: action.from.x, clientY: action.from.y, buttons: 1 }));
          start.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: action.to.x, clientY: action.to.y, buttons: 1 }));
          start.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: action.to.x, clientY: action.to.y }));
          break;
        }
        case 'keyboard.key': document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: action.key, bubbles: true })); break;
        case 'keyboard.insertText': document.execCommand('insertText', false, action.text); break;
        case 'wheel': window.scrollBy({ left: action.deltaX, top: action.deltaY, behavior: 'auto' }); break;
        case 'page.activate':
        case 'viewport.set': break;
        default: throw new Error('Action is unavailable on the native preview surface: ' + action.type);
      }
    } catch (error) {
      result.ok = false;
      result.error = { code: 'PREVIEW_ACTION_FAILED', message: error instanceof Error ? error.message : String(error), recoverable: true };
    }
    send({ type: 'action.result', result });
  }

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (event.source !== window.parent || event.origin !== parentOrigin || !message || message.channel !== CHANNEL
      || message.version !== VERSION || message.sessionId !== sessionId || message.nonce !== nonce || !message.payload) return;
    const payload = message.payload;
    if (payload.type === 'inspect.start') { inspectActive = true; selectedElement = null; }
    else if (payload.type === 'inspect.stop') { inspectActive = false; selectedElement = null; hide(); }
    else if (payload.type === 'element.activate') {
      const element = refElements.get(payload.ref)?.deref();
      if (element) { element.scrollIntoView({ block: 'center', inline: 'center' }); selectedElement = element; show(element); }
    } else if (payload.type === 'element.snapshot') {
      const element = payload.ref ? refElements.get(payload.ref)?.deref() : document.documentElement;
      if (element) send({ type: 'inspect.selected', element: describe(element) });
    } else if (payload.type === 'action.execute') void execute(payload.envelope);
  });

  window.addEventListener('popstate', () => send({ type: 'page.updated', url: location.href, title: document.title }));
  window.addEventListener('hashchange', () => send({ type: 'page.updated', url: location.href, title: document.title }));
  send({ type: 'bridge.ready', url: location.href, title: document.title });
})();`
