/// <reference types="vite/client" />

declare module '*.css?inline' {
  const content: string
  export default content
}

declare module '@/components/thinking/demo/styles.css?inline' {
  const content: string
  export default content
}

declare module '@/components/thinking/demo/simple.css?inline' {
  const content: string
  export default content
}
