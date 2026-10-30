'use client'

const themeInitScript = `(function(){try{var t=localStorage.getItem('openlink-theme')||'system';var d=t==='dark'||(t!=='light'&&matchMedia('(prefers-color-scheme: dark)').matches);var c=document.documentElement.classList;d?c.add('dark'):c.remove('dark')}catch(e){document.documentElement.classList.add('dark')}})()`

/**
 * The browser runs the server-rendered script while parsing the document.
 * During hydration it becomes inert, which avoids React trying to execute a
 * script node that it has already seen in the server HTML.
 */
export function ThemeInitScript() {
  return (
    <script
      type={typeof window === 'undefined' ? 'text/javascript' : 'text/plain'}
      suppressHydrationWarning
      dangerouslySetInnerHTML={{ __html: themeInitScript }}
    />
  )
}
