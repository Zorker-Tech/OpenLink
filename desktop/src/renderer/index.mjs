const target = window.openLinkDesktop?.appUrl

if (!target) {
  document.querySelector('#status').textContent = 'OpenLink desktop URL is not configured.'
} else {
  window.location.replace(target)
}
