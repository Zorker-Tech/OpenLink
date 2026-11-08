export const INSPECTOR_BRIDGE_SOURCE = String.raw`(() => {
  'use strict';
  const script = document.currentScript;
  if (!script || script.dataset.openlinkInstalled === 'true') return;
  script.dataset.openlinkInstalled = 'true';

  const sessionId = script.dataset.openlinkSession || '';
  const nonce = script.dataset.openlinkNonce || '';
  const previewPath = script.dataset.openlinkPreviewPath || '';
  let allowedOrigins = [];
  let hasPendingPreviewChanges = false;
  let pendingPreviewConfirmationMessage = 'You have unapplied Preview changes. Continue and discard them?';
  let allowPendingUnload = false;
  let allowNextTraverse = false;
  let allowNextNavigation = false;
  try {
    allowedOrigins = JSON.parse(atob(script.dataset.openlinkOrigins || 'W10='));
  } catch {}
  const referrerOrigin = (() => {
    try { return new URL(document.referrer).origin; } catch { return ''; }
  })();
  const parentOrigin = allowedOrigins.includes(referrerOrigin) ? referrerOrigin : allowedOrigins[0];
  if (!sessionId || !nonce || !parentOrigin) return;

  const rewritePreviewRequestUrl = (input) => {
    if (!previewPath || typeof input !== 'string' && !(input instanceof URL)) return input;
    const value = String(input);
    try {
      const url = new URL(value, location.href);
      const websocket = url.protocol === 'ws:' || url.protocol === 'wss:';
      const sameOrigin = websocket ? url.host === location.host : url.origin === location.origin;
      if (!sameOrigin || url.pathname === previewPath || url.pathname.startsWith(previewPath + '/')) return input;
      url.pathname = previewPath + url.pathname;
      return url.href;
    } catch { return input; }
  };

  const originalFetch = window.fetch;
  if (typeof originalFetch === 'function') {
    window.fetch = function(input, init) {
      if (input instanceof Request) {
        const rewritten = rewritePreviewRequestUrl(input.url);
        return Reflect.apply(originalFetch, window, [rewritten === input.url ? input : new Request(rewritten, input), init]);
      }
      return Reflect.apply(originalFetch, window, [rewritePreviewRequestUrl(input), init]);
    };
  }
  const originalXhrOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function() {
    const args = Array.from(arguments);
    if (args.length > 1) args[1] = rewritePreviewRequestUrl(args[1]);
    return Reflect.apply(originalXhrOpen, this, args);
  };
  for (const property of ['WebSocket', 'EventSource']) {
    const NativeConstructor = window[property];
    if (typeof NativeConstructor === 'function') {
      window[property] = new Proxy(NativeConstructor, {
        construct(target, args, newTarget) {
          if (args.length) args[0] = rewritePreviewRequestUrl(args[0]);
          return Reflect.construct(target, args, newTarget);
        }
      });
    }
  }
  const originalSetAttribute = Element.prototype.setAttribute;
  const previewUrlAttributes = new Set(['src', 'href', 'action', 'formaction', 'poster', 'data', 'manifest', 'srcset', 'imagesrcset', 'xlink:href']);
  const rewritePreviewSrcSet = (value) => String(value).replace(/(^|,\s*)(\/[^,\s]+)/g, (match, separator, url) => (
    separator + rewritePreviewRequestUrl(url)
  ));
  Element.prototype.setAttribute = function(name, value) {
    const attribute = String(name).toLowerCase();
    let nextValue = value;
    if (attribute === 'srcset' || attribute === 'imagesrcset') nextValue = rewritePreviewSrcSet(value);
    else if (previewUrlAttributes.has(attribute)) nextValue = rewritePreviewRequestUrl(String(value));
    else if (attribute === 'style') {
      nextValue = String(value).replace(/url\(\s*(['"]?)([^)'"\s]+)\1\s*\)/gi, (match, quote, url) => (
        'url(' + quote + rewritePreviewRequestUrl(url) + quote + ')'
      ));
    }
    return Reflect.apply(originalSetAttribute, this, [name, nextValue]);
  };
  for (const [constructorName, property] of [
    ['HTMLAnchorElement', 'href'], ['HTMLAreaElement', 'href'], ['HTMLBaseElement', 'href'],
    ['HTMLLinkElement', 'href'], ['HTMLLinkElement', 'imageSrcset'], ['HTMLImageElement', 'src'],
    ['HTMLImageElement', 'srcset'], ['HTMLScriptElement', 'src'], ['HTMLIFrameElement', 'src'],
    ['HTMLFrameElement', 'src'], ['HTMLMediaElement', 'src'], ['HTMLSourceElement', 'src'],
    ['HTMLSourceElement', 'srcset'], ['HTMLTrackElement', 'src'], ['HTMLInputElement', 'src'],
    ['HTMLInputElement', 'formAction'], ['HTMLButtonElement', 'formAction'], ['HTMLFormElement', 'action'],
    ['HTMLObjectElement', 'data'], ['HTMLEmbedElement', 'src'], ['HTMLVideoElement', 'poster']
  ]) {
    const prototype = window[constructorName]?.prototype;
    const descriptor = prototype && Object.getOwnPropertyDescriptor(prototype, property);
    if (!descriptor?.set) continue;
    Object.defineProperty(prototype, property, {
      ...descriptor,
      set(value) {
        const nextValue = property.toLowerCase().includes('srcset')
          ? rewritePreviewSrcSet(value)
          : rewritePreviewRequestUrl(String(value));
        return Reflect.apply(descriptor.set, this, [nextValue]);
      }
    });
  }
  window.addEventListener('click', (event) => {
    const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null;
    if (!anchor) return;
    if (anchor.target && anchor.target.toLowerCase() !== '_self') return;
    const target = new URL(anchor.href, location.href);
    if (target.origin !== location.origin || target.pathname === previewPath || target.pathname.startsWith(previewPath + '/')) return;
    anchor.href = rewritePreviewRequestUrl(target.href);
  }, true);

  const CHANNEL = 'openlink.browser.inspector';
  const VERSION = 1;
  const elementRefs = new WeakMap();
  const refElements = new Map();
  const originalStyles = new WeakMap();
  const originalContent = new WeakMap();
  const originalThemeTokens = new Map();
  let refSequence = 0;
  let inspectActive = false;
  let selectedElement = null;
  let moveDrag = null;
  let suppressInspectClick = false;
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
      content: element.children.length === 0 ? (element.textContent || '').slice(0, 2000) : undefined,
      canEditContent: canEditContent(element),
      viewport: { width: window.innerWidth, height: window.innerHeight },
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

  function translateCoordinates(element) {
    const value = getComputedStyle(element).translate;
    if (!value || value === 'none') return { x: 0, y: 0 };
    const parts = value.trim().split(/\s+/);
    if (parts.length > 2) return null;
    const parseLength = (part, size) => {
      if (/^-?(?:\d+\.?\d*|\.\d+)px$/.test(part)) return Number.parseFloat(part);
      if (/^-?(?:\d+\.?\d*|\.\d+)%$/.test(part)) return Number.parseFloat(part) * size / 100;
      if (/^-?(?:\d+\.?\d*|\.\d+)$/.test(part)) return Number.parseFloat(part);
      return null;
    };
    const x = parseLength(parts[0] || '', element.offsetWidth);
    const y = parts.length > 1 ? parseLength(parts[1] || '', element.offsetHeight) : 0;
    return x === null || y === null ? null : { x, y };
  }

  document.addEventListener('pointerdown', (event) => {
    if (!inspectActive || event.button !== 0 || !(event.metaKey || event.ctrlKey)) return;
    activity('pointer');
    const element = elementAt(event.clientX, event.clientY);
    if (!element || element === overlay || overlay.contains(element)) return;
    const base = translateCoordinates(element);
    if (!base) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    try { event.target?.setPointerCapture?.(event.pointerId); } catch {}
    selectedElement = element;
    moveDrag = { element, startX: event.clientX, startY: event.clientY, baseX: base.x, baseY: base.y, lastX: 0, lastY: 0, after: '' };
    send({ type: 'inspect.selected', element: show(element) });
  }, true);

  document.addEventListener('pointermove', (event) => {
    if (moveDrag) {
      event.preventDefault();
      event.stopImmediatePropagation();
      const drag = moveDrag;
      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;
      drag.lastX = dx;
      drag.lastY = dy;
      if (Math.abs(dx) > 1 || Math.abs(dy) > 1) {
        drag.after = (drag.baseX + dx) + 'px ' + (drag.baseY + dy) + 'px';
        setElementStyle(drag.element, 'translate', drag.after);
        show(drag.element);
      }
      return;
    }
    if (!inspectActive) return;
    const element = elementAt(event.clientX, event.clientY);
    if (element && element !== overlay && !overlay.contains(element)) send({ type: 'inspect.hover', element: show(element) });
  }, true);
  document.addEventListener('pointerup', (event) => {
    if (!moveDrag) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const drag = moveDrag;
    moveDrag = null;
    if (Math.abs(drag.lastX) > 4 || Math.abs(drag.lastY) > 4) {
      suppressInspectClick = true;
      setTimeout(() => { suppressInspectClick = false; }, 0);
      const before = drag.baseX === 0 && drag.baseY === 0 ? 'none' : drag.baseX + 'px ' + drag.baseY + 'px';
      const after = drag.after || (drag.baseX + drag.lastX) + 'px ' + (drag.baseY + drag.lastY) + 'px';
      send({ type: 'inspect.moved', element: show(drag.element), property: 'translate', before, after });
    }
  }, true);
  document.addEventListener('pointercancel', () => {
    if (!moveDrag) return;
    resetElementStyle(moveDrag.element, 'translate');
    moveDrag = null;
  }, true);
  document.addEventListener('pointerleave', () => { if (inspectActive && !moveDrag) hide(); }, true);
  document.addEventListener('click', (event) => {
    if (suppressInspectClick) {
      event.preventDefault(); event.stopImmediatePropagation();
      suppressInspectClick = false;
      return;
    }
    if (!inspectActive) return;
    const element = elementAt(event.clientX, event.clientY);
    if (!element || element === overlay || overlay.contains(element)) return;
    event.preventDefault(); event.stopImmediatePropagation();
    selectedElement = element;
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
    'color', 'background-color', 'font-family', 'font-size', 'font-style', 'font-weight', 'letter-spacing', 'line-height', 'text-align', 'text-decoration', 'text-decoration-color', 'text-indent', 'text-transform', 'word-spacing',
    'width', 'height', 'min-width', 'max-width', 'margin', 'padding', 'gap', 'border-radius',
    'border-color', 'border-width', 'opacity', 'display', 'position', 'justify-content',
    'align-items', 'flex-direction', 'box-shadow', 'translate'
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

  function canEditContent(element) {
    return element.namespaceURI === 'http://www.w3.org/1999/xhtml'
      && element.children.length === 0
      && !['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr', 'textarea', 'select', 'option', 'script', 'style'].includes(element.localName);
  }

  function setElementContent(element, content) {
    if (!canEditContent(element) || typeof content !== 'string' || content.length > 2000) {
      throw new Error('Text content cannot be edited for this element');
    }
    if (!originalContent.has(element)) originalContent.set(element, element.textContent || '');
    element.textContent = content;
    return { element: describe(element), content: element.textContent || '' };
  }

  function resetElementContent(element) {
    if (!canEditContent(element)) throw new Error('Text content cannot be edited for this element');
    if (originalContent.has(element)) {
      element.textContent = originalContent.get(element);
      originalContent.delete(element);
    }
    return { element: describe(element), content: element.textContent || '' };
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
        case 'preview.content.set': {
          const element = refElements.get(action.ref)?.deref();
          if (!element) throw new Error('Element is no longer available');
          const changed = setElementContent(element, action.content);
          result.element = changed.element;
          result.snapshot = JSON.stringify({ content: changed.content });
          break;
        }
        case 'preview.content.reset': {
          const element = refElements.get(action.ref)?.deref();
          if (!element) throw new Error('Element is no longer available');
          const changed = resetElementContent(element);
          result.element = changed.element;
          result.snapshot = JSON.stringify({ content: changed.content });
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
            bounds: rect,
            viewport: { width: window.innerWidth, height: window.innerHeight },
          });
          break;
        }
        case 'preview.locator.resolve': {
          selectedElement = null;
          overlay.style.display = 'none';
          const matchesFor = (candidate) => {
            try {
              if (candidate.kind === 'id') {
                const matches = [];
                for (const element of document.querySelectorAll('[id]')) {
                  if (element.id === candidate.value && matches.length < 2) matches.push(element);
                  if (matches.length === 2) break;
                }
                return matches;
              }
              if (candidate.kind === 'data-testid' || candidate.kind === 'data-test' || candidate.kind === 'data-cy') {
                const attribute = candidate.kind;
                const matches = [];
                for (const element of document.querySelectorAll('[' + attribute + ']')) {
                  if (element.getAttribute(attribute) === candidate.value && matches.length < 2) matches.push(element);
                  if (matches.length === 2) break;
                }
                return matches;
              }
              return Array.from(document.querySelectorAll(candidate.value)).filter((element) => element.localName === action.locator.tagName).slice(0, 2);
            } catch { return []; }
          };
          const uniqueMatches = [];
          let ambiguousCandidate = false;
          for (const candidate of action.locator.candidates) {
            const matches = matchesFor(candidate).filter((element) => element.localName === action.locator.tagName && element !== overlay && !overlay.contains(element));
            if (matches.length === 1) uniqueMatches.push({ element: matches[0], kind: candidate.kind });
            else if (matches.length > 1) ambiguousCandidate = true;
          }
          const uniqueElements = Array.from(new Set(uniqueMatches.map((match) => match.element)));
          if (uniqueElements.length === 1 && !ambiguousCandidate) {
            const element = uniqueElements[0];
            element.scrollIntoView({ block: 'center', inline: 'center' });
            selectedElement = element;
            result.element = show(element);
            result.snapshot = JSON.stringify({ status: 'matched', strategies: uniqueMatches.filter((match) => match.element === element).map((match) => match.kind) });
          } else {
            result.snapshot = JSON.stringify({ status: uniqueElements.length > 1 || ambiguousCandidate ? 'ambiguous' : 'not-found' });
          }
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
    else if (payload.type === 'preview.pending-changes') {
      hasPendingPreviewChanges = payload.hasPendingChanges === true;
      if (typeof payload.confirmationMessage === 'string' && payload.confirmationMessage.length <= 300) {
        pendingPreviewConfirmationMessage = payload.confirmationMessage;
      }
    }
    else if (payload.type === 'preview.navigation-confirmed') hasPendingPreviewChanges = false;
    else if (payload.type === 'element.activate') {
      const element = refElements.get(payload.ref)?.deref();
      if (element) { element.scrollIntoView({ block: 'center', inline: 'center' }); selectedElement = element; show(element); }
    } else if (payload.type === 'element.snapshot') {
      const element = payload.ref ? refElements.get(payload.ref)?.deref() : document.documentElement;
      if (element) send({ type: 'inspect.selected', element: describe(element) });
    } else if (payload.type === 'action.execute') void execute(payload.envelope);
  });

  const confirmPendingPreviewNavigation = (destination) => {
    if (!hasPendingPreviewChanges || !destination?.origin || !destination?.pathname) return true;
    if (destination.origin === location.origin
      && destination.pathname === location.pathname && destination.search === location.search) return true;
    if (!window.confirm(pendingPreviewConfirmationMessage)) return false;
    allowPendingUnload = true;
    setTimeout(() => { allowPendingUnload = false; }, 1_000);
    return true;
  };
  const navigation = window.navigation;
  if (navigation && typeof navigation.addEventListener === 'function') {
    navigation.addEventListener('navigate', (event) => {
      if (allowNextTraverse || allowNextNavigation) {
        allowNextTraverse = false;
        allowNextNavigation = false;
        return;
      }
      if (!event.cancelable) return;
      let destination;
      try { destination = new URL(event.destination.url, location.href); } catch { return; }
      if (!confirmPendingPreviewNavigation(destination)) event.preventDefault();
    });
  } else document.addEventListener('click', (event) => {
    if (!hasPendingPreviewChanges || event.defaultPrevented || event.button !== 0
      || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const target = event.target;
    const anchor = target instanceof Element ? target.closest('a[href]') : null;
    if (!(anchor instanceof HTMLAnchorElement) || (anchor.target && anchor.target !== '_self') || anchor.hasAttribute('download')) return;
    let destination;
    try { destination = new URL(anchor.href, location.href); } catch { return; }
    if (!confirmPendingPreviewNavigation(destination)) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }, true);
  for (const method of ['back', 'forward', 'go']) {
    const original = history[method];
    history[method] = function() {
      if (hasPendingPreviewChanges) {
        if (!window.confirm(pendingPreviewConfirmationMessage)) return;
        allowPendingUnload = true;
        setTimeout(() => { allowPendingUnload = false; }, 1_000);
        allowNextTraverse = true;
        setTimeout(() => { allowNextTraverse = false; }, 1_000);
      }
      return Reflect.apply(original, this, Array.from(arguments));
    };
  }
  window.addEventListener('beforeunload', (event) => {
    if (!hasPendingPreviewChanges) return;
    if (allowPendingUnload) {
      allowPendingUnload = false;
      return;
    }
    event.preventDefault();
    event.returnValue = '';
  });

  const notifyPageUpdated = () => send({ type: 'page.updated', url: location.href, title: document.title });
  for (const method of ['pushState', 'replaceState']) {
    const original = history[method];
    history[method] = function() {
      const args = Array.from(arguments);
      if (args.length > 2 && args[2] !== null) args[2] = rewritePreviewRequestUrl(String(args[2]));
      if (hasPendingPreviewChanges && args.length > 2 && args[2] !== null) {
        let destination;
        try { destination = new URL(String(args[2]), location.href); } catch { destination = null; }
        if (!confirmPendingPreviewNavigation(destination)) return;
        allowNextNavigation = true;
        setTimeout(() => { allowNextNavigation = false; }, 0);
      }
      const result = Reflect.apply(original, this, args);
      queueMicrotask(notifyPageUpdated);
      return result;
    };
  }
  window.addEventListener('popstate', notifyPageUpdated);
  window.addEventListener('hashchange', notifyPageUpdated);
  send({ type: 'bridge.ready', url: location.href, title: document.title });
})();`
