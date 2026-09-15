import { fn } from 'storybook/test'

const auth = {
  signOut: fn(async () => ({ error: null })),
  signInWithPassword: fn(async () => ({ data: { user: null, session: null }, error: { message: 'Storybook 演示：未连接认证服务。' } })),
  signUp: fn(async () => ({ data: { user: { id: 'fixture' }, session: null }, error: null })),
  signInWithOAuth: fn(async () => ({ data: { url: null }, error: { message: 'Storybook 演示：不跳转第三方登录。' } })),
}
export function createClient() { return { auth } }
